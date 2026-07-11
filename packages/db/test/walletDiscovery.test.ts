// FlowRadar — runWalletDiscovery integration tests (Task 30 binding decision
// 2). Same LITE-Postgres integration pattern as rotation.test.ts (prefix-
// cleanup, describe.skipIf when the embedded Postgres isn't reachable).
//
// Mock-provider case is a real DB integration test (upserts land in Postgres);
// the missing-provider case is a pure unit test (stub resolver returning
// null, no DB writes expected) — both live in this file since they exercise
// the same runWalletDiscovery function, matching Task 30's own test-plan
// grouping.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import type { Chain } from '@flowradar/core';
import type { WalletDiscoveryProvider } from '@flowradar/providers';
import { prisma } from '../src/client';
import { runWalletDiscovery } from '../src/walletDiscovery';

const ADDR_PREFIX = 'T30DISC';
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
      '[walletDiscovery.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.walletStats.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.$disconnect();
});

/** Fake WalletDiscoveryProvider — records the chain it was called for, returns two fixed candidates. */
function makeFakeMockProvider(): WalletDiscoveryProvider & { callCount: number } {
  return {
    callCount: 0,
    async getCandidateWallets(chain: Chain) {
      this.callCount += 1;
      return [
        { walletId: 'mock-1', chain, address: `${ADDR_PREFIX}_cand_1`, labels: ['smart_money'], walletScore: 72 },
        { walletId: 'mock-2', chain, address: `${ADDR_PREFIX}_cand_2`, labels: ['whale'], walletScore: 91 }
      ];
    }
  };
}

describe.skipIf(!(await probePort('localhost', 5439)))('runWalletDiscovery', () => {
  it('mock provider: upserts candidate wallets isWatched=false, WalletStats source=provider, from claimed walletScore', async () => {
    const fakeProvider = makeFakeMockProvider();
    const result = await runWalletDiscovery(prisma, DEFAULT_SETTINGS, () => fakeProvider);

    expect(result.errors).toBe(0);
    expect(result.chainsWithNoProvider).toBe(0);
    expect(result.candidatesUpserted).toBeGreaterThanOrEqual(2);

    const wallet1 = await prisma.wallet.findUnique({
      where: { address_chain: { address: `${ADDR_PREFIX}_cand_1`, chain: CHAIN } }
    });
    expect(wallet1).not.toBeNull();
    expect(wallet1!.isWatched).toBe(false);
    // Phase 0 taxonomy: provider-discovered wallets are observation-only —
    // a mutant that escalated discovery to signal_eligible must fail here.
    expect(wallet1!.status).toBe('observation_only');
    expect(wallet1!.notes).toBe('discovered:mock');

    const stats1 = await prisma.walletStats.findFirst({ where: { walletId: wallet1!.id } });
    expect(stats1).not.toBeNull();
    expect(stats1!.source).toBe('provider');
    expect(stats1!.walletScore).toBeCloseTo(72, 5);

    const wallet2 = await prisma.wallet.findUnique({
      where: { address_chain: { address: `${ADDR_PREFIX}_cand_2`, chain: CHAIN } }
    });
    expect(wallet2).not.toBeNull();
    expect(wallet2!.isWatched).toBe(false);
  });

  it('missing provider (resolver returns null): no-op, no throw, zero upserts', async () => {
    const result = await runWalletDiscovery(prisma, DEFAULT_SETTINGS, () => null);

    expect(result.errors).toBe(0);
    expect(result.candidatesUpserted).toBe(0);
    expect(result.chainsWithNoProvider).toBeGreaterThanOrEqual(2); // SOLANA + BSC both enabled in DEFAULT_SETTINGS
  });

  it('provider resolver throws: caught, treated as an error for that chain, never rethrown', async () => {
    const result = await runWalletDiscovery(prisma, DEFAULT_SETTINGS, () => {
      throw new Error('simulated live-mode getProvider throw');
    });

    expect(result.errors).toBeGreaterThanOrEqual(2);
    expect(result.candidatesUpserted).toBe(0);
  });

  it('collision guard: re-discovering an ALREADY-EXISTING isWatched wallet (source=computed latest stats) is a no-op — its isWatched and latest stats are untouched — while a genuinely NEW candidate in the same pass IS created', async () => {
    const watchedAddress = `${ADDR_PREFIX}_watched_collision`;
    const now = new Date();

    const watchedWallet = await prisma.wallet.create({
      data: {
        address: watchedAddress,
        chain: CHAIN,
        firstSeenAt: now,
        lastActiveAt: now,
        isWatched: true, status: 'signal_eligible',
        notes: 'manually watched before discovery ran'
      }
    });
    const computedStats = await prisma.walletStats.create({
      data: {
        walletId: watchedWallet.id,
        window: '30d',
        pnlUsd: 4321,
        realizedPnlUsd: 4321,
        unrealizedPnlUsd: 0,
        winRate: 0.65,
        tradeCount: 12,
        avgTradeSizeUsd: 300,
        walletScore: 77,
        scoreComponents: { note: 'pre-existing computed fixture' },
        pnlConfidence: 70,
        source: 'computed',
        computedAt: now
      }
    });

    const newAddress = `${ADDR_PREFIX}_genuinely_new`;
    const collidingProvider: WalletDiscoveryProvider = {
      async getCandidateWallets(chain: Chain) {
        return [
          { walletId: 'collide-1', chain, address: watchedAddress, labels: ['whale'], walletScore: 5 },
          { walletId: 'new-1', chain, address: newAddress, labels: ['smart_money'], walletScore: 63 }
        ];
      }
    };

    const result = await runWalletDiscovery(prisma, DEFAULT_SETTINGS, () => collidingProvider);
    expect(result.errors).toBe(0);

    // The pre-existing watched wallet: isWatched must still be true, notes untouched.
    const watchedAfter = await prisma.wallet.findUnique({ where: { id: watchedWallet.id } });
    expect(watchedAfter).not.toBeNull();
    expect(watchedAfter!.isWatched).toBe(true);
    expect(watchedAfter!.notes).toBe('manually watched before discovery ran');

    // Its latest WalletStats must still be the original source=computed non-zero row —
    // no new source=provider zeroed row inserted.
    const watchedStatsAll = await prisma.walletStats.findMany({ where: { walletId: watchedWallet.id } });
    expect(watchedStatsAll).toHaveLength(1);
    expect(watchedStatsAll[0]!.id).toBe(computedStats.id);
    expect(watchedStatsAll[0]!.source).toBe('computed');
    expect(Number(watchedStatsAll[0]!.pnlUsd)).toBe(4321);

    // A genuinely new candidate address in the SAME pass DOES get created.
    const newWallet = await prisma.wallet.findUnique({
      where: { address_chain: { address: newAddress, chain: CHAIN } }
    });
    expect(newWallet).not.toBeNull();
    expect(newWallet!.isWatched).toBe(false);
    expect(newWallet!.notes).toBe('discovered:mock');
    const newStats = await prisma.walletStats.findFirst({ where: { walletId: newWallet!.id } });
    expect(newStats).not.toBeNull();
    expect(newStats!.source).toBe('provider');
    expect(newStats!.walletScore).toBeCloseTo(63, 5);
  });

  it('collision guard: re-discovering an already-existing source=csv wallet is a no-op — csv stats untouched, no provider row inserted', async () => {
    const csvAddress = `${ADDR_PREFIX}_csv_collision`;
    const now = new Date();

    const csvWallet = await prisma.wallet.create({
      data: {
        address: csvAddress,
        chain: CHAIN,
        firstSeenAt: now,
        lastActiveAt: now,
        isWatched: false,
        notes: 'imported:csv'
      }
    });
    const csvStats = await prisma.walletStats.create({
      data: {
        walletId: csvWallet.id,
        window: '30d',
        pnlUsd: 999,
        realizedPnlUsd: 999,
        unrealizedPnlUsd: 0,
        winRate: 0.8,
        tradeCount: 30,
        avgTradeSizeUsd: 200,
        walletScore: 91,
        scoreComponents: { note: 'csv fixture' },
        pnlConfidence: 85,
        source: 'csv',
        computedAt: now
      }
    });

    const csvCollidingProvider: WalletDiscoveryProvider = {
      async getCandidateWallets(chain: Chain) {
        return [{ walletId: 'csv-collide-1', chain, address: csvAddress, labels: [], walletScore: 5 }];
      }
    };

    const result = await runWalletDiscovery(prisma, DEFAULT_SETTINGS, () => csvCollidingProvider);
    expect(result.errors).toBe(0);

    const csvWalletAfter = await prisma.wallet.findUnique({ where: { id: csvWallet.id } });
    expect(csvWalletAfter).not.toBeNull();
    expect(csvWalletAfter!.isWatched).toBe(false);
    expect(csvWalletAfter!.notes).toBe('imported:csv');

    const csvStatsAll = await prisma.walletStats.findMany({ where: { walletId: csvWallet.id } });
    expect(csvStatsAll).toHaveLength(1);
    expect(csvStatsAll[0]!.id).toBe(csvStats.id);
    expect(csvStatsAll[0]!.source).toBe('csv');
    expect(Number(csvStatsAll[0]!.pnlUsd)).toBe(999);
  });
});
