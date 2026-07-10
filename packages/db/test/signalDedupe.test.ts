// FlowRadar — signal dedupe integration test (Task 15 binding decision 5).
//
// Integration test against the real LITE-mode Postgres (embedded-postgres,
// port 5439), same prefix-cleanup pattern as packages/db/test/ingest.test.ts.
//
// Constructs a token with 12 watched-wallet BUY trades inside the last 30
// minutes (Rule A's WATCH tier fires at >= 10 smart/watched wallets, per
// settings.rules.A.watchMinWallets), runs runSignalDetectionPass TWICE back
// to back, and asserts the second run creates ZERO additional active Signal
// rows for (tokenId, 'A') — the "no duplicate open signal same token+rule"
// dedupe requirement (skip if an ACTIVE Signal already exists with
// triggeredAt within 24h).

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import { prisma } from '../src/client';
import { runSignalDetectionPass } from '../src/signals';

const ADDR_PREFIX = 'T15DEDUPE';
const CHAIN = 'SOLANA' as const;
const WALLET_COUNT = 12; // >= rules.A.watchMinWallets (10)

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
      '[signalDedupe.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

let tokenId: string | undefined;

afterAll(async () => {
  if (!dbReachable) return;
  if (tokenId) {
    await prisma.signal.deleteMany({ where: { tokenId } });
    await prisma.tokenFlowSnapshot.deleteMany({ where: { tokenId } });
  }
  await prisma.walletTokenTrade.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.$disconnect();
});

describe.skipIf(!(await probePort('localhost', 5439)))('signal dedupe (runSignalDetectionPass called twice)', () => {
  it('second run creates zero additional ACTIVE Signal rows for the same (tokenId, rule)', async () => {
    const now = new Date();
    const tokenAddr = `${ADDR_PREFIX}_token`;

    const token = await prisma.token.upsert({
      where: { chain_address: { chain: CHAIN, address: tokenAddr } },
      create: {
        chain: CHAIN,
        address: tokenAddr,
        symbol: 'T15DD',
        name: 'T15 Dedupe Token',
        decimals: 9,
        firstSeenAt: new Date(now.getTime() - 24 * 60 * 60_000),
        riskFlags: []
      },
      update: {}
    });
    tokenId = token.id;

    for (let i = 0; i < WALLET_COUNT; i++) {
      const address = `${ADDR_PREFIX}_wallet_${i}`;
      const wallet = await prisma.wallet.upsert({
        where: { address_chain: { address, chain: CHAIN } },
        create: { address, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: true, status: 'signal_eligible' },
        update: { isWatched: true, status: 'signal_eligible' }
      });
      await prisma.walletTokenTrade.create({
        data: {
          walletId: wallet.id,
          tokenId: token.id,
          chain: CHAIN,
          action: 'BUY',
          amountToken: 1000,
          amountUsd: 500,
          txHash: `${ADDR_PREFIX}_tx_buy_${i}`,
          blockOrSlot: BigInt(i + 1),
          ts: new Date(now.getTime() - (10 + i) * 60_000), // spread across last ~20min
          priceUsd: 0.5,
          marketCapAtTrade: 300_000,
          walletScoreAtTime: 70,
          provider: 'test'
        }
      });
    }

    const noOpLog = { info: () => {}, error: () => {} };

    const firstRun = await runSignalDetectionPass(prisma, DEFAULT_SETTINGS, noOpLog);
    const firstTokenResult = firstRun.perToken.get(token.id);
    expect(firstTokenResult).toBeDefined();
    expect(firstTokenResult!.fired.some((f) => f.rule === 'A')).toBe(true);

    const activeSignalsAfterFirst = await prisma.signal.findMany({
      where: { tokenId: token.id, rule: 'A', status: 'active' }
    });
    expect(activeSignalsAfterFirst.length).toBe(1);

    const secondRun = await runSignalDetectionPass(prisma, DEFAULT_SETTINGS, noOpLog);
    const secondTokenResult = secondRun.perToken.get(token.id);
    expect(secondTokenResult!.fired.some((f) => f.rule === 'A')).toBe(true);

    const activeSignalsAfterSecond = await prisma.signal.findMany({
      where: { tokenId: token.id, rule: 'A', status: 'active' }
    });
    // Still exactly 1 — the second run deduped instead of creating a duplicate.
    expect(activeSignalsAfterSecond.length).toBe(1);
    expect(activeSignalsAfterSecond[0]!.id).toBe(activeSignalsAfterFirst[0]!.id);

    expect(secondRun.summary.signalsDeduped).toBeGreaterThanOrEqual(1);
  });
});
