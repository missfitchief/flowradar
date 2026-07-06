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
});
