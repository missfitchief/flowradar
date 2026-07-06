// FlowRadar — runHistoricalReplay integration test (Task 41 binding decision
// 5). Same LITE-Postgres integration pattern as backtest.test.ts/rotation.test.ts
// (prefix-cleanup, describe.skipIf when the embedded Postgres isn't reachable).
//
// Builds a minimal fixture directly against the DB (not the full seed
// script, which is out of scope for a fast unit-level integration test):
// one token, 22 smart/watched wallets buying at the start of a 72h window,
// and a market-snapshot series showing the token pump 2.2x a few hours
// later — enough for Rule A to fire during replay and for evaluateReplay to
// join a real hit2x outcome.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { prisma } from '../src/client';
import { runHistoricalReplay } from '../src/replayRunner';

const ADDR_PREFIX = 'T41REPLAY';
const CHAIN = 'SOLANA' as const;
const HOUR_MS = 60 * 60_000;

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
      '[replayRunner.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  // BacktestRun rows carry no per-test address scoping (they summarize a
  // whole-DB replay pass, not a single token/wallet) — deleting every
  // kind='replay' row is the same "whole-table pass" cleanup precedent
  // vitest.config.ts documents for this project's other full-DB-scan tests.
  await prisma.backtestRun.deleteMany({ where: { kind: 'replay' } });
  await prisma.walletTokenTrade.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.tokenMarketSnapshot.deleteMany({ where: { token: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.$disconnect();
});

describe.skipIf(!(await probePort('localhost', 5439)))('runHistoricalReplay', () => {
  it(
    'replays a 72h seeded-shape period, persists a BacktestRun with a parseable summary, ' +
      'replayedSignalCount > 0, rule-performance table present, walk-forward verdict present',
    async () => {
      const genesis = new Date(Date.now() - 72 * HOUR_MS);
      const tokenAddr = `${ADDR_PREFIX}_token`;

      const token = await prisma.token.upsert({
        where: { chain_address: { chain: CHAIN, address: tokenAddr } },
        create: {
          chain: CHAIN,
          address: tokenAddr,
          symbol: 'T41RPL',
          name: 'T41 Replay Token',
          decimals: 9,
          firstSeenAt: genesis,
          riskFlags: []
        },
        update: {}
      });

      // 22 watched wallets, each buying $3,000 within the first hour of the
      // period — enough to clear Rule A's HIGH-tier wallet floor (20).
      const buyTs = new Date(genesis.getTime() + 30 * 60_000);
      for (let i = 0; i < 22; i++) {
        const walletAddr = `${ADDR_PREFIX}_wallet_${i}`;
        const wallet = await prisma.wallet.upsert({
          where: { address_chain: { address: walletAddr, chain: CHAIN } },
          create: { address: walletAddr, chain: CHAIN, firstSeenAt: genesis, lastActiveAt: buyTs, isWatched: true },
          update: {}
        });
        await prisma.walletTokenTrade.create({
          data: {
            walletId: wallet.id,
            tokenId: token.id,
            chain: CHAIN,
            action: 'BUY',
            amountToken: 300_000,
            amountUsd: 3000,
            txHash: `${ADDR_PREFIX}_tx_buy_${i}`,
            blockOrSlot: BigInt(i + 1),
            ts: new Date(buyTs.getTime() + i * 500),
            priceUsd: 1,
            marketCapAtTrade: 500_000,
            walletScoreAtTime: 80,
            provider: 'test'
          }
        });
      }

      // Market snapshots: baseline at genesis, then a 2.2x pump ~2h after the
      // buy cluster, well within the 72h period and comfortably ahead of any
      // replay step boundary.
      await prisma.tokenMarketSnapshot.create({
        data: {
          tokenId: token.id,
          ts: genesis,
          priceUsd: 1,
          marketCapUsd: 500_000,
          fdvUsd: 500_000,
          liquidityUsd: 100_000,
          vol5m: 0,
          vol1h: 0,
          vol6h: 0,
          vol24h: 0,
          holderCount: 100
        }
      });
      const pumpTs = new Date(buyTs.getTime() + 3 * HOUR_MS);
      await prisma.tokenMarketSnapshot.create({
        data: {
          tokenId: token.id,
          ts: pumpTs,
          priceUsd: 2.2,
          marketCapUsd: 1_100_000,
          fdvUsd: 1_100_000,
          liquidityUsd: 100_000,
          vol5m: 0,
          vol1h: 0,
          vol6h: 0,
          vol24h: 0,
          holderCount: 120
        }
      });

      const to = new Date(genesis.getTime() + 72 * HOUR_MS);
      const { backtestRunId, summary } = await runHistoricalReplay(prisma, { from: genesis, to, stepMinutes: 60 });

      expect(summary.replayedSignalCount).toBeGreaterThan(0);
      expect(summary.rulePerformance.A).toBeDefined();
      expect(summary.rulePerformance.A.real.signalCount).toBeGreaterThan(0);
      expect(summary.comboPerformance.length).toBe(8);
      expect(typeof summary.thresholdTuning.overfittingWarning).toBe('string');
      expect(summary.thresholdTuning.overfittingWarning.length).toBeGreaterThan(0);
      expect(['holds up', 'degrades — likely overfit']).toContain(summary.walkForward.verdict);
      expect(Array.isArray(summary.limitations)).toBe(true);
      expect(summary.limitations.length).toBeGreaterThan(0);

      // Persisted row is parseable and matches what was returned.
      const persisted = await prisma.backtestRun.findUnique({ where: { id: backtestRunId } });
      expect(persisted).not.toBeNull();
      expect(persisted!.status).toBe('complete');
      expect(persisted!.kind).toBe('replay');
      const persistedSummary = persisted!.summary as unknown as typeof summary;
      expect(persistedSummary.replayedSignalCount).toBe(summary.replayedSignalCount);
    },
    30_000
  );
});
