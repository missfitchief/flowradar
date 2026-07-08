// FlowRadar — runSocialIngestPass integration tests (Task D, Social
// Intelligence, Spec §6/§10). Same LITE-Postgres integration pattern as
// externalWalletSource.test.ts (probePort skipIf, prefix-cleanup, serialized).
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import type { Chain } from '@flowradar/core';
import type { SocialSourceProvider, SocialPostRaw, FetchPostsOpts } from '@flowradar/providers';
import { MockSocialSource, createMockWorld } from '@flowradar/providers';
import { prisma } from '../src/client';
import { runSocialIngestPass } from '../src/social/ingest';
import { getSocialSignalOverlap } from '../src/social/overlap';
import { getRecentMentions } from '../src/social/queries';

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

// ---------------------------------------------------------------------------
// Task G — cross-cutting end-to-end gate: drives the REAL MockSocialSource
// (not a hand-rolled fixture provider) through runSocialIngestPass, exactly
// as apps/worker/src/jobs/socialIngest.ts's getSharedMockSocialSource() does
// in MOCK_MODE, and asserts the full chain works: mentions created +
// token-linked where a matching Token exists, the wallet-signal overlap join
// returns confluence rows for a token with BOTH legs, and a disabled source
// is skipped cleanly with the provider never invoked. Same probePort/
// prefix-cleanup/serialized-db-project discipline as the rest of this file;
// shares the module-level `prisma` client (no second PrismaClient), disposed
// only in this block's own afterAll-independent module afterAll above.
// ---------------------------------------------------------------------------

const GATE_TOKEN_PREFIX = 'TGgateTok';
const GATE_SOURCE_PREFIX = 'TGgateSrc';

// Each gate test gets its OWN world seed so the mock world's deterministic
// NOVA address differs per test (createMockWorld's address generation is
// derived from `seed`, not wall-clock time) — this avoids two tests (or two
// reruns of the same test) racing to create a Token at the SAME real
// mock-world address, which is not itself GATE_TOKEN_PREFIX-scoped and so
// would never be caught by the prefix-based cleanup below.
//
// genesis is anchored to "now minus a small buffer" (NOT a hardcoded past
// date) so every MockSocialSource post (offsetMin up to 40 minutes past
// genesis) lands well inside getSocialSignalOverlap's windowMinutes lookback
// — a fixed past-dated genesis would eventually (and did) age out of that
// window and silently break the overlap-join assertion.
let gateWorldSeedCounter = 900000;
function gateWorld() {
  gateWorldSeedCounter += 1;
  const genesis = new Date(Date.now() - 60 * 60_000); // 1h ago
  return createMockWorld({ seed: gateWorldSeedCounter, genesis });
}

async function makeGateSourceRow(name: string, overrides: Partial<{ enabled: boolean }> = {}) {
  return prisma.socialSource.create({
    data: {
      name,
      platform: 'telegram',
      enabled: overrides.enabled ?? true,
      chainSupport: ['SOLANA'],
      apiKeyEnvName: null,
      rateLimitPerMinute: 30
    }
  });
}

// Tracks the exact mock-world token addresses this suite has created Token
// rows for (they are NOT GATE_TOKEN_PREFIX-prefixed — they're the real
// deterministic addresses from createMockWorld), so cleanup can delete them
// precisely instead of relying on a prefix match.
const gateCreatedAddresses = new Set<string>();

async function gateCleanup(): Promise<void> {
  await prisma.socialMention.deleteMany({ where: { source: { name: { startsWith: GATE_SOURCE_PREFIX } } } });
  await prisma.socialSource.deleteMany({ where: { name: { startsWith: GATE_SOURCE_PREFIX } } });
  if (gateCreatedAddresses.size > 0) {
    const addresses = [...gateCreatedAddresses];
    await prisma.signal.deleteMany({ where: { token: { address: { in: addresses } } } });
    await prisma.token.deleteMany({ where: { address: { in: addresses } } });
  }
  await prisma.signal.deleteMany({ where: { token: { address: { startsWith: GATE_TOKEN_PREFIX } } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: GATE_TOKEN_PREFIX } } });
}

const gateDbReachable = await probePort('localhost', 5439);

describe.skipIf(!gateDbReachable)('runSocialIngestPass + MockSocialSource (Task G end-to-end gate)', () => {
  beforeEach(async () => {
    await gateCleanup();
  });

  afterAll(async () => {
    await gateCleanup();
  });

  it('a real MockSocialSource run creates SocialMention rows, token-linking the ones matching a seeded Token', async () => {
    const sourceName = `${GATE_SOURCE_PREFIX}_mock`;
    await makeGateSourceRow(sourceName);

    const world = gateWorld();
    const novaAddress = world.tokens.find((t) => t.symbol === 'NOVA')!.address;

    // Seed a real Token at the mock world's NOVA address so the extractor's
    // address-mention (tg-0001, tg-0004) resolves to a genuine tokenId — the
    // "token-linked where a matching Token exists" leg of the gate.
    gateCreatedAddresses.add(novaAddress);
    const linkedToken = await prisma.token.create({
      data: {
        chain: 'SOLANA',
        address: novaAddress,
        symbol: 'NOVA',
        name: 'Nova (gate token)',
        decimals: 9,
        firstSeenAt: new Date(),
        riskFlags: []
      }
    });

    const provider = new MockSocialSource(world, { name: sourceName });
    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));

    expect(result.errors).toBe(0);
    // MockSocialSource's 8-post fixture yields >=9 mentions (tg-0004 alone
    // contributes 2 tokens); every post is scanned regardless of outcome.
    expect(result.mentionsUpserted).toBeGreaterThanOrEqual(8);
    expect(result.postsScanned).toBeGreaterThanOrEqual(8);

    const mentions = await prisma.socialMention.findMany({ where: { source: { name: sourceName } } });
    expect(mentions.length).toBeGreaterThanOrEqual(8);

    // At least one mention is token-LINKED to the seeded NOVA Token.
    const linked = mentions.filter((m) => m.tokenId === linkedToken.id);
    expect(linked.length).toBeGreaterThanOrEqual(1);

    // QUIET has no seeded Token row -> its mentions are gracefully UNLINKED
    // (tokenId null) rather than dropped.
    const unlinkedQuiet = mentions.filter((m) => m.tokenId === null && m.tokenSymbol === 'QUIET');
    expect(unlinkedQuiet.length).toBeGreaterThanOrEqual(1);

    // Snippet safety (Spec §1): every stored snippet <=280 chars.
    for (const m of mentions) {
      expect(m.contentSnippet.length).toBeLessThanOrEqual(280);
      expect(m.normalizedSnippet.length).toBeLessThanOrEqual(280);
    }

    // The 3-author copy-paste cluster (tg-0005/6/7) shares a contentHash.
    const hashes = new Set(mentions.map((m) => m.contentHash));
    expect(hashes.size).toBeLessThan(mentions.length);

    // getRecentMentions surfaces them end-to-end (feed query works).
    const recent = await getRecentMentions(prisma, { limit: 100 });
    expect(recent.some((r) => r.tokenSymbol === 'NOVA' && r.tokenId === linkedToken.id)).toBe(true);
  });

  it('overlap join returns a confluence row for a token with BOTH a MockSocialSource mention and a wallet Signal', async () => {
    const sourceName = `${GATE_SOURCE_PREFIX}_overlap`;
    await makeGateSourceRow(sourceName);

    const world = gateWorld();
    const novaAddress = world.tokens.find((t) => t.symbol === 'NOVA')!.address;
    gateCreatedAddresses.add(novaAddress);
    const token = await prisma.token.create({
      data: {
        chain: 'SOLANA',
        address: novaAddress,
        symbol: 'NOVA',
        name: 'Nova (overlap gate token)',
        decimals: 9,
        firstSeenAt: new Date(),
        riskFlags: []
      }
    });

    // The wallet-driven leg of the confluence: a real Signal on this token.
    await prisma.signal.create({
      data: {
        tokenId: token.id,
        rule: 'A',
        severity: 'HIGH',
        reasons: ['multi-wallet accumulation'],
        walletCount: 5,
        uniqueEntityCount: 4,
        netFlowUsd: 1000,
        mcapAtTrigger: 500_000,
        status: 'active',
        triggeredAt: new Date()
      }
    });

    // The social leg: run the REAL MockSocialSource, which mentions NOVA's
    // (now-linked) address across several posts.
    const provider = new MockSocialSource(world, { name: sourceName });
    await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));

    const overlap = await getSocialSignalOverlap(prisma, { windowMinutes: 1440 });
    const row = overlap.find((r) => r.tokenId === token.id);
    expect(row).toBeDefined();
    expect(row!.socialMentionCount).toBeGreaterThanOrEqual(1);
    expect(row!.firedSignals.some((s) => s.rule === 'A')).toBe(true);
  });

  it('a disabled source is skipped cleanly — MockSocialSource never invoked, no mentions written', async () => {
    const sourceName = `${GATE_SOURCE_PREFIX}_disabled`;
    await makeGateSourceRow(sourceName, { enabled: false });

    const world = gateWorld();
    let called = 0;
    const provider = new MockSocialSource(world, { name: sourceName });
    const originalFetchPosts = provider.fetchPosts.bind(provider);
    provider.fetchPosts = async (chain: Chain, opts?: FetchPostsOpts) => {
      called += 1;
      return originalFetchPosts(chain, opts);
    };

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));

    expect(result.sourcesSkippedDisabled).toBeGreaterThanOrEqual(1);
    expect(called).toBe(0);

    const mentions = await prisma.socialMention.findMany({ where: { source: { name: sourceName } } });
    expect(mentions).toHaveLength(0);
  });
});
