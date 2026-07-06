// FlowRadar — runWalletStatsRefresh integration tests (Task 30 binding
// decision 1). Same LITE-Postgres integration pattern as rotation.test.ts /
// clustering.test.ts (prefix-cleanup, describe.skipIf when the embedded
// Postgres isn't reachable on localhost:5439).
//
// Fixture-A FIFO expectation (mirrors packages/core/test's own fifo fixture
// exactly, per Task 30's binding decision 1 brief):
//   buy 10 @ $1 (cost $10) + buy 10 @ $2 (cost $20)
//   sell 15 @ $3 (proceeds $45)
//   -> consumes all 10 units of lot 1 ($10 cost) + 5 units of lot 2 ($10 cost)
//   -> realizedUsd = 45 - 20 = 25
//   remaining inventory: 5 units of the $2 lot (cost $10) -> priced at the
//   latest TokenMarketSnapshot price (set to $4 below) -> unrealizedUsd =
//   5*4 - 10 = 10
//   -> pnlUsd = 25 + 10 = 35

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { prisma } from '../src/client';
import { runWalletStatsRefresh } from '../src/walletStatsRefresh';

const ADDR_PREFIX = 'T30STATS';
const CHAIN = 'SOLANA' as const;

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
      '[walletStatsRefresh.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.walletStats.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.walletTokenTrade.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.tokenMarketSnapshot.deleteMany({ where: { token: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.$disconnect();
});

async function makeToken(suffix: string): Promise<string> {
  const address = `${ADDR_PREFIX}_token_${suffix}`;
  const token = await prisma.token.upsert({
    where: { chain_address: { chain: CHAIN, address } },
    create: { chain: CHAIN, address, symbol: `T30${suffix}`, name: `T30 ${suffix}`, decimals: 9, firstSeenAt: new Date(), riskFlags: [] },
    update: {}
  });
  return token.id;
}

async function makeWallet(suffix: string, isWatched = false): Promise<string> {
  const address = `${ADDR_PREFIX}_wallet_${suffix}`;
  const now = new Date();
  const wallet = await prisma.wallet.upsert({
    where: { address_chain: { address, chain: CHAIN } },
    create: { address, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched },
    update: {}
  });
  return wallet.id;
}

let tradeCounter = 0;
async function makeTrade(
  walletId: string,
  tokenId: string,
  action: 'BUY' | 'SELL',
  amountToken: number,
  amountUsd: number,
  priceUsd: number,
  ts: Date
): Promise<void> {
  tradeCounter += 1;
  await prisma.walletTokenTrade.create({
    data: {
      walletId,
      tokenId,
      chain: CHAIN,
      action,
      amountToken,
      amountUsd,
      txHash: `${ADDR_PREFIX}_tx_${tradeCounter}`,
      blockOrSlot: BigInt(tradeCounter),
      ts,
      priceUsd,
      marketCapAtTrade: 500_000,
      walletScoreAtTime: 50,
      provider: 'test'
    }
  });
}

describe.skipIf(!(await probePort('localhost', 5439)))('runWalletStatsRefresh', () => {
  it('computes a fresh source=computed WalletStats row matching computeFifoPnl for a wallet with no prior stats', async () => {
    const walletId = await makeWallet('fresh');
    const tokenId = await makeToken('fresh');

    const now = new Date();
    const buy1Ts = new Date(now.getTime() - 4 * 60 * 60_000);
    const buy2Ts = new Date(now.getTime() - 3 * 60 * 60_000);
    const sellTs = new Date(now.getTime() - 2 * 60 * 60_000);

    await makeTrade(walletId, tokenId, 'BUY', 10, 10, 1, buy1Ts);
    await makeTrade(walletId, tokenId, 'BUY', 10, 20, 2, buy2Ts);
    await makeTrade(walletId, tokenId, 'SELL', 15, 45, 3, sellTs);

    // Latest market snapshot price used for unrealized valuation of the
    // remaining 5-unit lot.
    await prisma.tokenMarketSnapshot.create({
      data: {
        tokenId,
        ts: now,
        priceUsd: 4,
        marketCapUsd: 800_000,
        fdvUsd: 800_000,
        liquidityUsd: 100_000,
        vol5m: 0,
        vol1h: 0,
        vol6h: 0,
        vol24h: 0,
        holderCount: 100
      }
    });

    const result = await runWalletStatsRefresh(prisma);
    expect(result.refreshed).toBeGreaterThanOrEqual(1);

    const stats = await prisma.walletStats.findFirst({
      where: { walletId },
      orderBy: { computedAt: 'desc' }
    });
    expect(stats).not.toBeNull();
    expect(stats!.source).toBe('computed');
    expect(Number(stats!.realizedPnlUsd)).toBeCloseTo(25, 5);
    expect(Number(stats!.unrealizedPnlUsd)).toBeCloseTo(10, 5);
    expect(Number(stats!.pnlUsd)).toBeCloseTo(35, 5);
    expect(stats!.tradeCount).toBe(3);
    expect(stats!.winRate).toBeCloseTo(1, 5); // the one sell was a win
  });

  it('NEVER touches a wallet whose latest WalletStats is source=csv (anti-clobber guarantee)', async () => {
    const walletId = await makeWallet('csv-protected');
    const tokenId = await makeToken('csv-protected');

    const now = new Date();
    await makeTrade(walletId, tokenId, 'BUY', 10, 10, 1, new Date(now.getTime() - 60 * 60_000));
    await makeTrade(walletId, tokenId, 'SELL', 10, 999, 99.9, new Date(now.getTime() - 30 * 60_000));

    const csvComputedAt = new Date(now.getTime() - 10 * 60_000);
    const csvStats = await prisma.walletStats.create({
      data: {
        walletId,
        window: '30d',
        pnlUsd: 12345,
        realizedPnlUsd: 12345,
        unrealizedPnlUsd: 0,
        winRate: 0.77,
        tradeCount: 20,
        avgTradeSizeUsd: 600,
        walletScore: 88,
        scoreComponents: { note: 'csv fixture' },
        pnlConfidence: 85,
        source: 'csv',
        computedAt: csvComputedAt
      }
    });

    const before = await prisma.walletStats.findMany({ where: { walletId } });
    expect(before).toHaveLength(1);

    const result1 = await runWalletStatsRefresh(prisma);
    expect(result1.skippedCsv).toBeGreaterThanOrEqual(1);

    const afterPass1 = await prisma.walletStats.findMany({ where: { walletId } });
    expect(afterPass1).toHaveLength(1);
    expect(afterPass1[0]!.id).toBe(csvStats.id);
    expect(afterPass1[0]!.source).toBe('csv');
    expect(Number(afterPass1[0]!.pnlUsd)).toBe(12345);

    // Idempotent-ish: a second pass still doesn't touch the csv wallet.
    const result2 = await runWalletStatsRefresh(prisma);
    expect(result2.skippedCsv).toBeGreaterThanOrEqual(1);

    const afterPass2 = await prisma.walletStats.findMany({ where: { walletId } });
    expect(afterPass2).toHaveLength(1);
    expect(afterPass2[0]!.id).toBe(csvStats.id);
    expect(afterPass2[0]!.source).toBe('csv');
    expect(Number(afterPass2[0]!.pnlUsd)).toBe(12345);
  });

  it('two passes over a computed wallet do not corrupt data — each pass adds one fresh computed row', async () => {
    const walletId = await makeWallet('idempotent');
    const tokenId = await makeToken('idempotent');
    const now = new Date();
    await makeTrade(walletId, tokenId, 'BUY', 5, 50, 10, new Date(now.getTime() - 60 * 60_000));

    await runWalletStatsRefresh(prisma);
    const afterPass1 = await prisma.walletStats.findMany({ where: { walletId } });
    expect(afterPass1.length).toBeGreaterThanOrEqual(1);
    expect(afterPass1.every((r) => r.source === 'computed')).toBe(true);

    await runWalletStatsRefresh(prisma);
    const afterPass2 = await prisma.walletStats.findMany({ where: { walletId } });
    expect(afterPass2.length).toBeGreaterThan(afterPass1.length);
    expect(afterPass2.every((r) => r.source === 'computed')).toBe(true);
  });
});
