// FlowRadar — runSocialIngestPass integration tests (Task D, Social
// Intelligence, Spec §6/§10). Same LITE-Postgres integration pattern as
// externalWalletSource.test.ts (probePort skipIf, prefix-cleanup, serialized).
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import type { Chain } from '@flowradar/core';
import type { SocialSourceProvider, SocialPostRaw, FetchPostsOpts } from '@flowradar/providers';
import { prisma } from '../src/client';
import { runSocialIngestPass } from '../src/social/ingest';

const SOURCE_PREFIX = 'T_D_socialSource';
// NOTE: base58-safe (no `_`, `0`, `O`, `I`, `l`) and unbroken so extractMentions'
// bare-address regex matches the WHOLE fixture string as one token, not just a
// tail run after a non-base58 character (underscore/`l` both break the match).
const ADDR_PREFIX = 'TDsocAddr';
const POST_PREFIX = 'T_D_socialPost';

function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

let dbReachable = false;

beforeAll(async () => {
  dbReachable = await probePort('localhost', 5439);
  if (!dbReachable) {
    // eslint-disable-next-line no-console
    console.warn(
      '[socialIngest.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

async function cleanup(): Promise<void> {
  await prisma.socialMention.deleteMany({ where: { source: { name: { startsWith: SOURCE_PREFIX } } } });
  await prisma.socialSource.deleteMany({ where: { name: { startsWith: SOURCE_PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
}

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});

/** Explicit fake provider — deterministic post list, records fetch call count + the `since` it was handed. */
function makeFakeSocialProvider(
  platform: string,
  posts: SocialPostRaw[]
): SocialSourceProvider & { callCount: number; lastSince: Date | undefined } {
  return {
    name: 'fake-social',
    platform,
    chains: ['SOLANA'],
    callCount: 0,
    lastSince: undefined,
    async fetchPosts(_chain: Chain, opts?: FetchPostsOpts) {
      this.callCount += 1;
      this.lastSince = opts?.since;
      return posts;
    }
  };
}

async function makeSourceRow(
  name: string,
  overrides: Partial<{ enabled: boolean; platform: string; chainSupport: string[]; apiKeyEnvName: string | null }> = {}
) {
  return prisma.socialSource.create({
    data: {
      name,
      platform: overrides.platform ?? 'telegram',
      enabled: overrides.enabled ?? true,
      chainSupport: overrides.chainSupport ?? ['SOLANA'],
      apiKeyEnvName: overrides.apiKeyEnvName ?? 'SOCIAL_TELEGRAM_READ_TOKEN',
      rateLimitPerMinute: 30
    }
  });
}

describe.skipIf(!(await probePort('localhost', 5439)))('runSocialIngestPass', () => {
  it('extracts + upserts a SocialMention linked to an existing Token (chain,address)', async () => {
    const sourceName = `${SOURCE_PREFIX}_link`;
    await makeSourceRow(sourceName);
    const tokenAddress = `${ADDR_PREFIX}1111111111111111111111111111`; // 44-ish base58-ish for the extractor
    const token = await prisma.token.create({
      data: {
        chain: 'SOLANA',
        address: tokenAddress,
        symbol: 'TDLINK',
        name: 'Task D Link Token',
        decimals: 9,
        firstSeenAt: new Date(),
        riskFlags: []
      }
    });

    const provider = makeFakeSocialProvider('telegram', [
      {
        externalId: `${POST_PREFIX}_a`,
        authorHash: 'author-hash-1',
        content: `aping ${tokenAddress} looks strong, big volume incoming`,
        postedAt: new Date()
      }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));

    expect(result.errors).toBe(0);
    expect(result.mentionsUpserted).toBe(1);

    const mention = await prisma.socialMention.findFirst({ where: { source: { name: sourceName } } });
    expect(mention).not.toBeNull();
    expect(mention!.tokenId).toBe(token.id);
    expect(mention!.mentionType).toBe('address');
    expect(mention!.tokenAddress).toBe(tokenAddress);
    expect(mention!.chain).toBe('SOLANA');
    expect(mention!.platform).toBe('telegram');
    expect(mention!.contentSnippet.length).toBeLessThanOrEqual(280);
    expect(mention!.dedupeKey).toBe(`${POST_PREFIX}_a::${tokenAddress}`);

    const sourceRow = await prisma.socialSource.findUnique({ where: { name: sourceName } });
    expect(sourceRow?.status).toBe('ok');
    expect(sourceRow?.lastSyncAt).not.toBeNull();
    expect(sourceRow?.failCount).toBe(0);
  });

  it('extracted token NOT in DB is stored with tokenId=null (graceful unlinked skip, never a crash)', async () => {
    const sourceName = `${SOURCE_PREFIX}_unlinked`;
    await makeSourceRow(sourceName);
    const unknownAddress = `${ADDR_PREFIX}9999999999999999999999999999`;

    const provider = makeFakeSocialProvider('telegram', [
      { externalId: `${POST_PREFIX}_u`, authorHash: 'author-hash-x', content: `fresh gem ${unknownAddress} not indexed yet`, postedAt: new Date() }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));

    expect(result.errors).toBe(0);
    expect(result.mentionsUpserted).toBe(1);
    const mention = await prisma.socialMention.findFirst({ where: { source: { name: sourceName } } });
    expect(mention).not.toBeNull();
    expect(mention!.tokenId).toBeNull();
    expect(mention!.tokenAddress).toBe(unknownAddress);
  });

  it('pure $TICKER with no address stored unlinked (tokenSymbol set, tokenId null)', async () => {
    const sourceName = `${SOURCE_PREFIX}_ticker`;
    await makeSourceRow(sourceName);

    const provider = makeFakeSocialProvider('discord', [
      { externalId: `${POST_PREFIX}_t`, authorHash: 'author-hash-y', content: 'watching $BONK closely today', postedAt: new Date() }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));

    expect(result.mentionsUpserted).toBe(1);
    const mention = await prisma.socialMention.findFirst({ where: { source: { name: sourceName } } });
    expect(mention!.mentionType).toBe('ticker');
    expect(mention!.tokenSymbol).toBe('BONK');
    expect(mention!.tokenAddress).toBeNull();
    expect(mention!.tokenId).toBeNull();
    expect(mention!.dedupeKey).toBe(`${POST_PREFIX}_t::$BONK`);
  });

  it('re-ingest (second pass, same post) is idempotent — 0 net new rows, upsert not insert', async () => {
    const sourceName = `${SOURCE_PREFIX}_idem`;
    await makeSourceRow(sourceName);
    const addr = `${ADDR_PREFIX}2222222222222222222222222222`;
    const provider = makeFakeSocialProvider('telegram', [
      { externalId: `${POST_PREFIX}_i`, authorHash: 'author-hash-i', content: `same post ${addr}`, postedAt: new Date() }
    ]);

    await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));

    const rows = await prisma.socialMention.findMany({ where: { source: { name: sourceName } } });
    expect(rows).toHaveLength(1); // deduped on [sourceId, dedupeKey]
  });

  it('one post mentioning 2 tokens produces 2 mention rows (distinct dedupeKeys)', async () => {
    const sourceName = `${SOURCE_PREFIX}_multi`;
    await makeSourceRow(sourceName);
    const addrA = `${ADDR_PREFIX}3333333333333333333333333333`;
    const addrB = `${ADDR_PREFIX}4444444444444444444444444444`;
    const provider = makeFakeSocialProvider('telegram', [
      { externalId: `${POST_PREFIX}_m`, authorHash: 'author-hash-m', content: `rotating from ${addrA} into ${addrB}`, postedAt: new Date() }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    expect(result.mentionsUpserted).toBe(2);
    const rows = await prisma.socialMention.findMany({ where: { source: { name: sourceName } }, orderBy: { tokenAddress: 'asc' } });
    expect(rows.map((r) => r.tokenAddress).sort()).toEqual([addrA, addrB].sort());
  });

  it('copy-paste across distinct authors is flagged copypasta via the contentHash lookback', async () => {
    const sourceName = `${SOURCE_PREFIX}_spam`;
    await makeSourceRow(sourceName);
    const addr = `${ADDR_PREFIX}5555555555555555555555555555`;
    // 3 distinct authors post the IDENTICAL content — copypastaAuthorMin default is 3.
    const identical = `buy ${addr} now 100x guaranteed to the moon rocket`;
    const provider = makeFakeSocialProvider('telegram', [
      { externalId: `${POST_PREFIX}_s1`, authorHash: 'spammer-A', content: identical, postedAt: new Date() },
      { externalId: `${POST_PREFIX}_s2`, authorHash: 'spammer-B', content: identical, postedAt: new Date() },
      { externalId: `${POST_PREFIX}_s3`, authorHash: 'spammer-C', content: identical, postedAt: new Date() }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    expect(result.mentionsUpserted).toBe(3);

    const rows = await prisma.socialMention.findMany({ where: { source: { name: sourceName } } });
    // Shadow-only: rows are STORED, never dropped. The 3rd-ingested one sees 3 distinct authors -> copypasta.
    const flagged = rows.filter((r) => r.spamReason === 'copypasta');
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...rows.map((r) => r.spamScore))).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.connectors.social.spam.weights.copypasta);
  });

  it('zero-token post is counted (postsScanned) but stored as ZERO mentions', async () => {
    const sourceName = `${SOURCE_PREFIX}_notoken`;
    await makeSourceRow(sourceName);
    const provider = makeFakeSocialProvider('telegram', [
      { externalId: `${POST_PREFIX}_z`, authorHash: 'author-z', content: 'gm everyone, great vibes today no tokens here', postedAt: new Date() }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    expect(result.mentionsUpserted).toBe(0);
    expect(result.postsScanned).toBeGreaterThanOrEqual(1);

    const rows = await prisma.socialMention.findMany({ where: { source: { name: sourceName } } });
    expect(rows).toHaveLength(0);

    const sourceRow = await prisma.socialSource.findUnique({ where: { name: sourceName } });
    const meta = (sourceRow?.metadataJson ?? {}) as { postsScanned?: number };
    expect(meta.postsScanned).toBeGreaterThanOrEqual(1);
  });

  it('disabled source is skipped entirely — provider never called, no mentions', async () => {
    const sourceName = `${SOURCE_PREFIX}_disabled`;
    await makeSourceRow(sourceName, { enabled: false });
    const provider = makeFakeSocialProvider('telegram', [
      { externalId: `${POST_PREFIX}_d`, authorHash: 'author-d', content: 'should never run', postedAt: new Date() }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    expect(result.sourcesSkippedDisabled).toBeGreaterThanOrEqual(1);
    expect(provider.callCount).toBe(0);
    const rows = await prisma.socialMention.findMany({ where: { source: { name: sourceName } } });
    expect(rows).toHaveLength(0);
  });

  it('resolver returning null (missing key / manual platform) is a graceful skip, never throws', async () => {
    const sourceName = `${SOURCE_PREFIX}_noprovider`;
    await makeSourceRow(sourceName, { platform: 'manual', apiKeyEnvName: null });

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, () => null);
    expect(result.errors).toBe(0);
    expect(result.mentionsUpserted).toBe(0);
    expect(result.sourcesSkippedNoProvider).toBeGreaterThanOrEqual(1);
  });

  it('one source throwing never aborts other enabled sources (per-source try/catch)', async () => {
    const goodName = `${SOURCE_PREFIX}_good`;
    const badName = `${SOURCE_PREFIX}_bad`;
    await makeSourceRow(goodName);
    await makeSourceRow(badName);
    const addr = `${ADDR_PREFIX}6666666666666666666666666666`;

    const goodProvider = makeFakeSocialProvider('telegram', [
      { externalId: `${POST_PREFIX}_g`, authorHash: 'author-g', content: `clean call ${addr}`, postedAt: new Date() }
    ]);
    const badProvider: SocialSourceProvider = {
      name: 'bad-social',
      platform: 'telegram',
      chains: ['SOLANA'],
      async fetchPosts() {
        throw new Error('simulated social provider failure');
      }
    };

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === goodName ? goodProvider : badProvider));

    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.mentionsUpserted).toBeGreaterThanOrEqual(1);

    const goodMention = await prisma.socialMention.findFirst({ where: { source: { name: goodName } } });
    expect(goodMention).not.toBeNull();

    const badRow = await prisma.socialSource.findUnique({ where: { name: badName } });
    expect(badRow?.status).toBe('error');
    expect(badRow?.lastError).toContain('simulated social provider failure');
    expect(badRow?.failCount).toBeGreaterThanOrEqual(1);

    const goodRow = await prisma.socialSource.findUnique({ where: { name: goodName } });
    expect(goodRow?.status).toBe('ok');
  });

  it('one bad post never aborts sibling posts in the same source (per-post try/catch)', async () => {
    const sourceName = `${SOURCE_PREFIX}_perpost`;
    await makeSourceRow(sourceName);
    const addr = `${ADDR_PREFIX}7777777777777777777777777777`;
    const provider = makeFakeSocialProvider('telegram', [
      // A malformed post: content forced null-ish to trip an in-loop throw; the pass must catch + continue.
      { externalId: `${POST_PREFIX}_bad`, authorHash: 'author-bad', content: null as unknown as string, postedAt: new Date() },
      { externalId: `${POST_PREFIX}_ok`, authorHash: 'author-ok', content: `still fine ${addr}`, postedAt: new Date() }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    // The good post still landed even though a sibling threw.
    const ok = await prisma.socialMention.findFirst({ where: { source: { name: sourceName }, tokenAddress: addr } });
    expect(ok).not.toBeNull();
    // Source is NOT marked error by a per-post failure (only per-source resolve/fetch failures are).
    const sourceRow = await prisma.socialSource.findUnique({ where: { name: sourceName } });
    expect(sourceRow?.status).toBe('ok');
    void result;
  });

  it('lastSyncAt from the prior pass is handed to fetchPosts as opts.since on the next pass', async () => {
    const sourceName = `${SOURCE_PREFIX}_since`;
    await makeSourceRow(sourceName);
    const provider = makeFakeSocialProvider('telegram', []);

    await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    const firstSyncAt = (await prisma.socialSource.findUnique({ where: { name: sourceName } }))!.lastSyncAt;
    expect(firstSyncAt).not.toBeNull();

    await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    expect(provider.lastSince).not.toBeUndefined();
    expect(provider.lastSince!.getTime()).toBe(firstSyncAt!.getTime());
  });
});
