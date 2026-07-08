// FlowRadar — getTokenSocialMentions test (Task F, token-detail social section).
//
// DB integration test: mirrors this repo's probePort(5439) skipIf +
// prefix-scoped cleanup convention (see socialQueries.test.ts /
// socialSchema.test.ts). Covers: only this token's mentions are returned,
// newest-first ordering, source name/platform/trustTier projection, and a
// graceful [] (never throws) for a token with no mentions.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { getTokenSocialMentions } from '../src/index';
import { prisma } from '../src/client';

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

const PREFIX = 'tsms_test_'; // unique row prefix for isolated cleanup

// NOTE: describe.skipIf's condition is evaluated synchronously at collection
// time — a beforeAll-set `dbReachable` flag would always read false there.
// This repo's actual working DB-integration tests (socialQueries.test.ts,
// socialSchema.test.ts) resolve this with a top-level await directly in the
// describe.skipIf(...) call, so this file matches that proven pattern.
const dbReachable = await probePort('localhost', 5439);

describe.skipIf(!dbReachable)('getTokenSocialMentions', () => {
  let tokenId = '';
  let sourceId = '';

  beforeAll(async () => {
    // Clean any leftover rows from a prior interrupted run (prefix-scoped).
    await prisma.socialMention.deleteMany({ where: { externalPostId: { startsWith: PREFIX } } });
    await prisma.socialSource.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });

    const token = await prisma.token.create({
      data: {
        chain: 'SOLANA',
        address: PREFIX + 'addr_nova',
        symbol: PREFIX + 'NOVA',
        name: 'Test Nova',
        decimals: 9,
        firstSeenAt: new Date(),
        riskFlags: [],
      },
    });
    tokenId = token.id;

    const source = await prisma.socialSource.create({
      data: { name: PREFIX + 'tg', platform: 'telegram', trustTier: 'high' },
    });
    sourceId = source.id;

    const base = Date.now();
    // 3 mentions for our token (varying postedAt to assert desc ordering),
    // 1 mention for a DIFFERENT token (must be excluded).
    const otherToken = await prisma.token.create({
      data: {
        chain: 'SOLANA',
        address: PREFIX + 'addr_other',
        symbol: PREFIX + 'OTHER',
        name: 'Other',
        decimals: 9,
        firstSeenAt: new Date(),
        riskFlags: [],
      },
    });
    const rows = [
      { tokenId, postedAt: new Date(base - 3000), post: 'p1' },
      { tokenId, postedAt: new Date(base - 1000), post: 'p2' }, // newest of ours
      { tokenId, postedAt: new Date(base - 2000), post: 'p3' },
      { tokenId: otherToken.id, postedAt: new Date(base), post: 'p4' },
    ];
    for (const r of rows) {
      await prisma.socialMention.create({
        data: {
          sourceId,
          platform: 'telegram',
          externalPostId: PREFIX + r.post,
          postedAt: r.postedAt,
          chain: 'SOLANA',
          contentSnippet: 'gm ' + r.post,
          normalizedSnippet: 'gm ' + r.post,
          contentHash: PREFIX + 'h_' + r.post,
          mentionType: 'address',
          tokenAddress: PREFIX + 'addr_nova',
          tokenId: r.tokenId,
          confidence: 90,
          spamScore: 0,
          dedupeKey: PREFIX + r.post + '::' + PREFIX + 'addr_nova',
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.socialMention.deleteMany({ where: { externalPostId: { startsWith: PREFIX } } });
    await prisma.socialSource.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  });

  it('returns only this token\'s mentions, newest first, with source name/platform/trustTier', async () => {
    const rows = await getTokenSocialMentions(prisma, tokenId);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.tokenId === tokenId)).toBe(true);
    // desc by postedAt: p2 (newest) then p3 then p1.
    expect(rows.map((r) => r.externalPostId)).toEqual([
      PREFIX + 'p2', PREFIX + 'p3', PREFIX + 'p1',
    ]);
    expect(rows[0].source).toEqual({ name: PREFIX + 'tg', platform: 'telegram', trustTier: 'high' });
  });

  it('returns [] (never throws) for a token with no mentions — graceful empty', async () => {
    const empty = await getTokenSocialMentions(prisma, 'cixdoesnotexist000000000');
    expect(empty).toEqual([]);
  });
});
