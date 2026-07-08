// FlowRadar — SocialSource + SocialMention schema-behavior integration tests
// (Social Intelligence, Task A, spec §1). Same LITE-Postgres integration
// pattern as externalWalletSource.test.ts (prefix-cleanup, describe.skipIf
// when the embedded Postgres isn't reachable). Proves the three schema
// guarantees later tasks depend on: [sourceId, dedupeKey] idempotency,
// onDelete:Cascade from SocialSource, and a nullable tokenId link.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../src/client';

const SOURCE_PREFIX = 'TAsocSource';
const TOKEN_PREFIX = 'TAsocToken';

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
      '[socialSchema.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

async function cleanup() {
  // SocialMention rows are cascade-deleted with their source, but delete by
  // prefix explicitly so a leftover source-less mention (e.g. from a failed
  // run) is also cleared, and to null out any token linkage first.
  await prisma.socialMention.deleteMany({ where: { source: { name: { startsWith: SOURCE_PREFIX } } } });
  await prisma.socialMention.deleteMany({ where: { tokenAddress: { startsWith: TOKEN_PREFIX } } });
  await prisma.socialSource.deleteMany({ where: { name: { startsWith: SOURCE_PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: TOKEN_PREFIX } } });
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

async function makeSource(name: string, overrides: Partial<Parameters<typeof prisma.socialSource.create>[0]['data']> = {}) {
  return prisma.socialSource.create({
    data: {
      name,
      platform: 'telegram',
      chainSupport: ['SOLANA'],
      apiKeyEnvName: 'SOCIAL_TELEGRAM_READ_TOKEN',
      ...overrides
    }
  });
}

/** Deterministic mention payload for a given source + dedupeKey. */
function mentionData(sourceId: string, dedupeKey: string, over: Partial<Parameters<typeof prisma.socialMention.create>[0]['data']> = {}) {
  return {
    sourceId,
    platform: 'telegram',
    externalPostId: `${dedupeKey}_post`,
    postedAt: new Date('2026-07-07T00:00:00.000Z'),
    chain: 'SOLANA' as const,
    contentSnippet: 'gm buy $NOVA now',
    normalizedSnippet: 'gm buy nova now',
    contentHash: 'hash_nova',
    mentionType: 'ticker',
    tokenSymbol: 'NOVA',
    confidence: 40,
    dedupeKey,
    ...over
  };
}

describe.skipIf(!(await probePort('localhost', 5439)))('SocialSource + SocialMention schema', () => {
  it('applies documented column defaults on SocialSource', async () => {
    const source = await makeSource(`${SOURCE_PREFIX}_defaults`);
    expect(source.trustTier).toBe('medium');
    expect(source.enabled).toBe(true);
    expect(source.rateLimitPerMinute).toBe(30);
    expect(source.status).toBe('idle');
    expect(source.failCount).toBe(0);
    expect(source.chainSupport).toEqual(['SOLANA']);
    expect(source.addedAt).toBeInstanceOf(Date);
    expect(source.lastSyncAt).toBeNull();
  });

  it('creates two mentions under one source and applies SocialMention defaults', async () => {
    const source = await makeSource(`${SOURCE_PREFIX}_two`);
    await prisma.socialMention.create({ data: mentionData(source.id, 'dk_a') });
    const m2 = await prisma.socialMention.create({ data: mentionData(source.id, 'dk_b') });

    const rows = await prisma.socialMention.findMany({ where: { sourceId: source.id } });
    expect(rows).toHaveLength(2);
    expect(m2.spamScore).toBe(0);
    expect(m2.spamReason).toBeNull();
    expect(m2.tokenId).toBeNull();
    expect(m2.ingestedAt).toBeInstanceOf(Date);
  });

  it('[sourceId, dedupeKey] is idempotent — re-upsert of the same dedupeKey yields exactly 1 row', async () => {
    const source = await makeSource(`${SOURCE_PREFIX}_idem`);
    const where = { sourceId_dedupeKey: { sourceId: source.id, dedupeKey: 'dk_same' } };

    await prisma.socialMention.upsert({
      where,
      create: mentionData(source.id, 'dk_same', { spamScore: 0 }),
      update: {}
    });
    // Second upsert of the SAME (sourceId, dedupeKey), different spamScore —
    // must UPDATE the existing row, never insert a second.
    const second = await prisma.socialMention.upsert({
      where,
      create: mentionData(source.id, 'dk_same', { spamScore: 0 }),
      update: { spamScore: 80, spamReason: 'copypasta' }
    });

    const rows = await prisma.socialMention.findMany({ where: { sourceId: source.id, dedupeKey: 'dk_same' } });
    expect(rows).toHaveLength(1);
    expect(second.spamScore).toBe(80);
    expect(second.spamReason).toBe('copypasta');
  });

  it('the same dedupeKey under a DIFFERENT source is a distinct row (constraint is per-source)', async () => {
    const s1 = await makeSource(`${SOURCE_PREFIX}_scopeA`);
    const s2 = await makeSource(`${SOURCE_PREFIX}_scopeB`);
    await prisma.socialMention.create({ data: mentionData(s1.id, 'dk_shared') });
    await prisma.socialMention.create({ data: mentionData(s2.id, 'dk_shared') });

    const all = await prisma.socialMention.findMany({ where: { dedupeKey: 'dk_shared' } });
    expect(all).toHaveLength(2);
  });

  it('deleting a SocialSource cascade-deletes its SocialMention rows', async () => {
    const source = await makeSource(`${SOURCE_PREFIX}_cascade`);
    await prisma.socialMention.create({ data: mentionData(source.id, 'dk_c1') });
    await prisma.socialMention.create({ data: mentionData(source.id, 'dk_c2') });

    await prisma.socialSource.delete({ where: { id: source.id } });

    const remaining = await prisma.socialMention.findMany({ where: { sourceId: source.id } });
    expect(remaining).toHaveLength(0);
  });

  it('links a mention to a Token when tokenId is supplied, and reads back via the Token.socialMentions back-relation', async () => {
    const source = await makeSource(`${SOURCE_PREFIX}_linked`);
    const token = await prisma.token.create({
      data: {
        chain: 'SOLANA',
        address: `${TOKEN_PREFIX}_nova`,
        symbol: 'NOVA',
        name: 'Nova',
        decimals: 9,
        firstSeenAt: new Date(),
        riskFlags: []
      }
    });

    const linked = await prisma.socialMention.create({
      data: mentionData(source.id, 'dk_linked', {
        mentionType: 'address',
        tokenAddress: `${TOKEN_PREFIX}_nova`,
        tokenId: token.id,
        confidence: 90
      })
    });
    expect(linked.tokenId).toBe(token.id);

    const tokenWithMentions = await prisma.token.findUnique({
      where: { id: token.id },
      include: { socialMentions: true }
    });
    expect(tokenWithMentions!.socialMentions).toHaveLength(1);
    expect(tokenWithMentions!.socialMentions[0]!.dedupeKey).toBe('dk_linked');
  });

  it('graceful skip: a mention with tokenId=null (unlinked / missing token) persists cleanly', async () => {
    const source = await makeSource(`${SOURCE_PREFIX}_unlinked`);
    const unlinked = await prisma.socialMention.create({
      data: mentionData(source.id, 'dk_unlinked', { tokenSymbol: 'GHOST', tokenId: null })
    });
    expect(unlinked.tokenId).toBeNull();
    expect(unlinked.tokenSymbol).toBe('GHOST');

    const readBack = await prisma.socialMention.findUnique({ where: { id: unlinked.id }, include: { token: true } });
    expect(readBack!.token).toBeNull();
  });
});
