// FlowRadar — fetchAggregateInputs bounded-market-load tests (F8, 2026-07-07).
//
// The live Solana soak found flowScoring/signalDetection re-loading each
// token's FULL, ever-growing TokenMarketSnapshot history every cycle (RSS
// climbed 91MB -> 399MB). The fix bounds that load to only the snapshots
// aggregateWindow actually reads (earliest + latest<=to + latest<=from per
// window). These tests prove the bound (a) loads far fewer rows on a
// many-snapshot token and (b) is SCORE-EXACT — the resulting aggregate's
// market-derived fields are identical to the full-history load.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS, aggregateWindow } from '@flowradar/core';
import { prisma } from '../src/client';
import { fetchAggregateInputs } from '../src/fetchAggregateInputs';

const ADDR_PREFIX = 'F8AGG';
const CHAIN = 'SOLANA' as const;
const WINDOW_30 = 30;
const WINDOW_1440 = 1440;

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
});

async function cleanup() {
  await prisma.walletTokenTrade.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.tokenMarketSnapshot.deleteMany({ where: { token: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
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

const SNAP_COUNT = 60; // 60 hourly snapshots => 60h of history, far beyond the 24h window

async function seedTokenWithHistory(now: Date) {
  const token = await prisma.token.create({
    data: { chain: CHAIN, address: `${ADDR_PREFIX}_tok`, symbol: 'F8', name: 'F8 token', decimals: 9, firstSeenAt: now, riskFlags: [] }
  });
  const wallet = await prisma.wallet.create({
    data: { address: `${ADDR_PREFIX}_w`, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: true }
  });
  // A few BUY trades over the last ~2h (so the window has real in-window trades).
  // Latest trade is at now-80m, so aggregateWindow anchors `to = now-80m`.
  for (let i = 0; i < 5; i++) {
    await prisma.walletTokenTrade.create({
      data: {
        walletId: wallet.id,
        tokenId: token.id,
        chain: CHAIN,
        action: 'BUY',
        amountToken: 100,
        amountUsd: 1000,
        txHash: `${ADDR_PREFIX}_tx_${i}`,
        blockOrSlot: BigInt(i + 1),
        ts: new Date(now.getTime() - (120 - i * 10) * 60_000),
        priceUsd: 10,
        marketCapAtTrade: 500_000,
        walletScoreAtTime: 50,
        provider: 'test'
      }
    });
  }
  // Many hourly market snapshots spanning 60h (only the earliest + latest<=to +
  // latest<=from should ever be read by aggregateWindow).
  for (let i = 0; i < SNAP_COUNT; i++) {
    await prisma.tokenMarketSnapshot.create({
      data: {
        tokenId: token.id,
        ts: new Date(now.getTime() - (SNAP_COUNT - i) * 60 * 60_000),
        priceUsd: 1,
        marketCapUsd: 100_000 + i * 1000,
        fdvUsd: 100_000 + i * 1000,
        liquidityUsd: 20_000 + i * 100,
        vol5m: 0,
        vol1h: 0,
        vol6h: 0,
        vol24h: 0,
        holderCount: 100 + i,
        source: 'test'
      }
    });
  }
  // One extra snapshot at now-90m — inside the 30m window (to=now-80m,
  // from=now-110m) but strictly AFTER its `from`. Without it, the 30m
  // window's latest<=to and latest<=from both resolve to the SAME hourly
  // snapshot (now-120m), making liquidityChangePct a degenerate 0==0 that
  // wouldn't catch the bounded path dropping the 30m `from` point. With it,
  // latest<=to=now-90m and latest<=from(30m)=now-120m are distinct rows, so
  // the 30m score-exactness assertion actually exercises two boundary points.
  await prisma.tokenMarketSnapshot.create({
    data: {
      tokenId: token.id,
      ts: new Date(now.getTime() - 90 * 60_000),
      priceUsd: 1,
      marketCapUsd: 250_000,
      fdvUsd: 250_000,
      liquidityUsd: 33_333,
      vol5m: 0,
      vol1h: 0,
      vol6h: 0,
      vol24h: 0,
      holderCount: 175,
      source: 'test'
    }
  });
  return { token, snapshotCount: SNAP_COUNT + 1 };
}

describe.skipIf(!(await probePort('localhost', 5439)))('fetchAggregateInputs — bounded market load (F8)', () => {
  it('loads far fewer snapshots than full-history but yields an identical aggregate (24h window)', async () => {
    const now = new Date();
    const { token, snapshotCount } = await seedTokenWithHistory(now);

    const full = await fetchAggregateInputs(prisma, token.id, DEFAULT_SETTINGS);
    const bounded = await fetchAggregateInputs(prisma, token.id, DEFAULT_SETTINGS, { now, windows: [WINDOW_1440] });

    // Full loads every snapshot; bounded loads only the boundary points it needs.
    expect(full.market.length).toBe(snapshotCount);
    expect(bounded.market.length).toBeLessThan(full.market.length);
    expect(bounded.market.length).toBeLessThanOrEqual(3); // earliest + latest<=to + latest<=from

    // SCORE-EXACT: every market-derived aggregate field is identical.
    const opts = { windowMinutes: WINDOW_1440, now } as const;
    const aggFull = aggregateWindow({ trades: full.trades, wallets: full.wallets, clusters: full.clusters, market: full.market, ...opts });
    const aggBounded = aggregateWindow({ trades: bounded.trades, wallets: bounded.wallets, clusters: bounded.clusters, market: bounded.market, ...opts });

    expect(aggBounded.currentMcap).toBe(aggFull.currentMcap);
    expect(aggBounded.liquidityUsd).toBe(aggFull.liquidityUsd);
    expect(aggBounded.mcapExpansionFromAvgEntry).toBe(aggFull.mcapExpansionFromAvgEntry);
    expect(aggBounded.liquidityChangePct).toBe(aggFull.liquidityChangePct);
    expect(aggBounded.tokenAgeDays).toBe(aggFull.tokenAgeDays);
    // sanity: the market-derived fields aren't trivially all-null/zero (the
    // token has real snapshots + real entry mcaps), so the equalities above
    // are asserting on live values rather than a degenerate null==null.
    expect(aggFull.currentMcap).not.toBeNull();
    expect(aggFull.mcapExpansionFromAvgEntry).not.toBeNull();
  });

  it('is score-exact for the two-window (30m + 24h) signalDetection path too', async () => {
    const now = new Date();
    const { token } = await seedTokenWithHistory(now);

    const full = await fetchAggregateInputs(prisma, token.id, DEFAULT_SETTINGS);
    const bounded = await fetchAggregateInputs(prisma, token.id, DEFAULT_SETTINGS, {
      now,
      windows: [WINDOW_30, WINDOW_1440]
    });

    expect(bounded.market.length).toBeLessThanOrEqual(4); // earliest + latest<=to + latest<=from(30m) + latest<=from(24h)

    for (const windowMinutes of [WINDOW_30, WINDOW_1440]) {
      const aggFull = aggregateWindow({ trades: full.trades, wallets: full.wallets, clusters: full.clusters, market: full.market, windowMinutes, now });
      const aggBounded = aggregateWindow({ trades: bounded.trades, wallets: bounded.wallets, clusters: bounded.clusters, market: bounded.market, windowMinutes, now });
      expect(aggBounded.currentMcap).toBe(aggFull.currentMcap);
      expect(aggBounded.liquidityUsd).toBe(aggFull.liquidityUsd);
      expect(aggBounded.liquidityChangePct).toBe(aggFull.liquidityChangePct);
      expect(aggBounded.tokenAgeDays).toBe(aggFull.tokenAgeDays);
      // The 30m window's from/to now resolve to DISTINCT snapshots (now-120m
      // vs now-90m), so liquidityChangePct is a non-zero value here — the
      // equality is exercising the bounded path's 30m `from` fetch, not a
      // degenerate 0==0.
      expect(aggBounded.liquidityChangePct).not.toBe(0);
    }
  });
});
