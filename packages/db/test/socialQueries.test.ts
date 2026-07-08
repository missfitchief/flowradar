// FlowRadar — social read-helper tests (Task E, spec §8/§9/§10).
//
// DB integration test: mirrors this repo's probePort(5439) skipIf +
// prefix-scoped cleanup convention (see socialSchema.test.ts /
// externalWalletSource.test.ts). Covers getRecentMentions (newest-first,
// linked vs unlinked shaping, spam never dropped by default),
// getSocialSourceHealth (per-source counts + postsScanned from
// metadataJson), and getSocialSignalOverlap (read-only join — token with
// wallet evidence included, social-only token excluded).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import {
  getRecentMentions,
  getSocialSourceHealth,
  getSocialSignalOverlap
} from '../src/index';
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

const PREFIX = 'sq_test_';
// NOTE: describe.skipIf's condition is evaluated synchronously at collection
// time — a beforeAll-set `dbReachable` flag would always read false there.
// This repo's actual working DB-integration tests (socialSchema.test.ts,
// externalWalletSource.test.ts) resolve this with a top-level await directly
// in the describe.skipIf(...) call, so this file matches that proven pattern
// rather than the beforeAll-only sketch.
const dbReachable = await probePort('localhost', 5439);

beforeAll(async () => {
  if (!dbReachable) return;
  // Clean any leftover rows from a prior run (prefix-scoped). Tokens created
  // by this file are also prefix-scoped (address startsWith PREFIX) so a
  // previously-interrupted run doesn't collide on the unique (chain, address).
  await prisma.socialMention.deleteMany({ where: { source: { name: { startsWith: PREFIX } } } });
  await prisma.socialSource.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
});

afterAll(async () => {
  if (dbReachable) {
    await prisma.socialMention.deleteMany({ where: { source: { name: { startsWith: PREFIX } } } });
    await prisma.socialSource.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
  }
  await prisma.$disconnect();
});

describe.skipIf(!dbReachable)('social queries (DB integration)', () => {
  it('getRecentMentions orders newest-first and shapes link vs unlinked rows', async () => {
    const source = await prisma.socialSource.create({
      data: { name: `${PREFIX}tg`, platform: 'telegram', trustTier: 'high', enabled: true, chainSupport: ['SOLANA'], apiKeyEnvName: 'SOCIAL_TELEGRAM_READ_TOKEN' }
    });
    // A real Token to link one mention to.
    const token = await prisma.token.create({
      data: { chain: 'SOLANA', address: `${PREFIX}addr_nova`, symbol: 'NOVA', name: 'Nova', decimals: 9, firstSeenAt: new Date(), riskFlags: [] }
    });
    const older = new Date('2026-07-07T10:00:00Z');
    const newer = new Date('2026-07-07T11:00:00Z');
    await prisma.socialMention.create({
      data: {
        sourceId: source.id, platform: 'telegram', externalPostId: 'p1', postedAt: older,
        chain: 'SOLANA', contentSnippet: 'buy $NOVA now', normalizedSnippet: 'buy nova now',
        contentHash: 'h1', mentionType: 'ticker', tokenSymbol: 'NOVA', tokenId: token.id,
        confidence: 40, spamScore: 10, dedupeKey: 'p1::$NOVA'
      }
    });
    await prisma.socialMention.create({
      data: {
        sourceId: source.id, platform: 'telegram', externalPostId: 'p2', postedAt: newer,
        chain: 'SOLANA', contentSnippet: 'ticker only $GHOST', normalizedSnippet: 'ticker only ghost',
        contentHash: 'h2', mentionType: 'ticker', tokenSymbol: 'GHOST', tokenId: null,
        confidence: 40, spamScore: 5, dedupeKey: 'p2::$GHOST'
      }
    });

    const rows = await getRecentMentions(prisma, { limit: 10 });
    const mine = rows.filter((r) => r.sourceName === `${PREFIX}tg`);
    expect(mine).toHaveLength(2);
    // Newest first.
    expect(mine[0].tokenSymbol).toBe('GHOST');
    expect(mine[0].tokenId).toBeNull();          // unlinked
    expect(mine[1].tokenId).toBe(token.id);      // linked
    expect(mine[1].tokenSymbol).toBe('NOVA');
    expect(mine[0].sourceTrustTier).toBe('high');
  });

  it('getRecentMentions excludes rows at/above includeSpamAtOrAbove only when asked (default returns all)', async () => {
    const source = await prisma.socialSource.create({
      data: { name: `${PREFIX}spam`, platform: 'discord', enabled: true, chainSupport: ['SOLANA'] }
    });
    await prisma.socialMention.create({
      data: {
        sourceId: source.id, platform: 'discord', externalPostId: 's1', postedAt: new Date(),
        chain: 'SOLANA', contentSnippet: 'spammy', normalizedSnippet: 'spammy', contentHash: 'hs1',
        mentionType: 'ticker', tokenSymbol: 'SPAM', confidence: 40, spamScore: 90, spamReason: 'copypasta', dedupeKey: 's1::$SPAM'
      }
    });
    const all = await getRecentMentions(prisma, { limit: 100 });
    expect(all.some((r) => r.sourceName === `${PREFIX}spam`)).toBe(true);
    // getRecentMentions never DROPS by spam by default (UI collapses; shadow-only stores everything).
    const stillThere = await getRecentMentions(prisma, { limit: 100, includeSpamAtOrAbove: 100 });
    expect(stillThere.some((r) => r.sourceName === `${PREFIX}spam`)).toBe(true);
  });

  it('getSocialSourceHealth reports mention counts + postsScanned from metadataJson', async () => {
    const source = await prisma.socialSource.create({
      data: {
        name: `${PREFIX}health`, platform: 'telegram', trustTier: 'medium', enabled: false,
        chainSupport: ['SOLANA'], apiKeyEnvName: 'SOCIAL_TELEGRAM_READ_TOKEN',
        rateLimitPerMinute: 30, status: 'ok', metadataJson: { postsScanned: 42 }
      }
    });
    await prisma.socialMention.create({
      data: {
        sourceId: source.id, platform: 'telegram', externalPostId: 'hp1', postedAt: new Date(),
        chain: 'SOLANA', contentSnippet: 'x', normalizedSnippet: 'x', contentHash: 'hh1',
        mentionType: 'ticker', tokenSymbol: 'HLTH', confidence: 40, dedupeKey: 'hp1::$HLTH'
      }
    });
    const health = await getSocialSourceHealth(prisma);
    const row = health.find((h) => h.name === `${PREFIX}health`);
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(false);
    expect(row!.mentionCount).toBe(1);
    expect(row!.postsScanned).toBe(42);
    expect(row!.apiKeyEnvName).toBe('SOCIAL_TELEGRAM_READ_TOKEN');
  });

  it('getSocialSignalOverlap joins linked mentions to Signal/flow evidence; skips unlinked and evidence-less tokens', async () => {
    const source = await prisma.socialSource.create({
      data: { name: `${PREFIX}ov`, platform: 'telegram', enabled: true, chainSupport: ['SOLANA'] }
    });
    // Token WITH social + a Signal + a flow snapshot => appears.
    const hot = await prisma.token.create({
      data: { chain: 'SOLANA', address: `${PREFIX}addr_hot`, symbol: 'HOT', name: 'Hot', decimals: 9, firstSeenAt: new Date(), riskFlags: [] }
    });
    // Token WITH social but NO wallet evidence => excluded.
    const cold = await prisma.token.create({
      data: { chain: 'SOLANA', address: `${PREFIX}addr_cold`, symbol: 'COLD', name: 'Cold', decimals: 9, firstSeenAt: new Date(), riskFlags: [] }
    });
    const now = new Date();
    for (const [i, tk] of [hot, cold].entries()) {
      await prisma.socialMention.create({
        data: {
          sourceId: source.id, platform: 'telegram', externalPostId: `ov${i}`, postedAt: now,
          chain: 'SOLANA', contentSnippet: 'x', normalizedSnippet: 'x', contentHash: `ovh${i}`,
          mentionType: 'address', tokenAddress: tk.address, tokenId: tk.id, authorHash: `a${i}`,
          confidence: 90, dedupeKey: `ov${i}::${tk.address}`
        }
      });
    }
    await prisma.signal.create({
      data: {
        tokenId: hot.id, rule: 'A', severity: 'HIGH', triggeredAt: now, reasons: {},
        walletCount: 5, uniqueEntityCount: 4, netFlowUsd: 1000, mcapAtTrigger: 50000, status: 'active'
      }
    });
    await prisma.tokenFlowSnapshot.create({
      data: {
        tokenId: hot.id, ts: now, windowMinutes: 60, flowScore: 77, smartWalletCount: 5,
        humanLikeCount: 4, possibleBotCount: 1, uniqueEntityCount: 4, clusterAdjustedWalletCount: 4,
        entityConcentrationRisk: 0.2, trackedBuyVolumeUsd: 1000, trackedSellVolumeUsd: 100,
        netFlowUsd: 900, buySellRatio: 10, avgEntryMcap: 40000, currentMcap: 50000,
        mcapExpansionFromAvgEntry: 1.25, holdersGrowth: 0.1, liquidityChange: 0.05,
        signalStatus: 'hot', componentBreakdown: {}
      }
    });

    const overlap = await getSocialSignalOverlap(prisma, { windowMinutes: 1440, limit: 25 });
    const hotRow = overlap.find((r) => r.tokenId === hot.id);
    const coldRow = overlap.find((r) => r.tokenId === cold.id);
    expect(hotRow).toBeDefined();
    expect(hotRow!.socialMentionCount).toBe(1);
    expect(hotRow!.distinctAuthors).toBe(1);
    expect(hotRow!.latestFlowScore).toBe(77);
    expect(hotRow!.firedSignals.map((s) => s.rule)).toContain('A');
    expect(coldRow).toBeUndefined(); // social but no wallet evidence => excluded
  });
});
