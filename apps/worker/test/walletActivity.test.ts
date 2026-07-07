// FlowRadar — walletActivity job tests (rate-limit hardening, 2026-07-07).
//
// The live Solana validation found that walletActivity's real-provider polls
// hit Helius 429s and stopped ingesting. These tests lock in the job-level
// contract the fix depends on: polls are SEQUENTIAL (never a concurrent
// burst), a provider throttle (429) does not crash the cycle, later wallets
// are still attempted after a throttled one, and per-wallet failures are
// counted + classified honestly (rate_limited vs provider_error).
//
// @flowradar/db is mocked so the job runs with no real database — the test
// drives it with a hand-built JobContext (fake prisma + fake provider + spy
// logger). isRateLimitError / HeliusRateLimitError are the REAL ones.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@flowradar/db', () => ({
  ingestNormalizedTxs: vi.fn(async () => {})
}));

import { HeliusRateLimitError } from '@flowradar/providers';
import type { NormalizedTx } from '@flowradar/core';
import { run } from '../src/jobs/walletActivity';

interface FakeWallet {
  id: string;
  address: string;
  chain: 'SOLANA' | 'BSC';
}

function makeTx(): NormalizedTx {
  // Only `.ts` (a Date) is read by walletActivity (cursor advance); the rest of
  // the shape is irrelevant because ingestNormalizedTxs is mocked out.
  return { ts: new Date(1_000) } as unknown as NormalizedTx;
}

/**
 * A fake WalletActivityProvider that (a) tracks the max number of concurrent
 * getWalletTransactions calls (to prove the job never bursts), and (b) throws
 * a 429 (HeliusRateLimitError) for address 'THROTTLED', a generic error for
 * 'BOOM', and returns one tx for anything else.
 */
function makeFakeProvider() {
  let active = 0;
  let maxConcurrent = 0;
  const getWalletTransactions = vi.fn(async (_chain: string, address: string) => {
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    await Promise.resolve(); // yield — a Promise.all-style caller would overlap here
    try {
      if (address === 'THROTTLED') throw new HeliusRateLimitError('Helius rate-limited (429 Too Many Requests)');
      if (address === 'BOOM') throw new Error('provider exploded (500 Internal Server Error)');
      return { txs: [makeTx()], nextCursor: undefined as string | undefined };
    } finally {
      active -= 1;
    }
  });
  return { provider: { providerName: 'FakeHelius', getWalletTransactions }, getMaxConcurrent: () => maxConcurrent };
}

function makeCtx(wallets: FakeWallet[], provider: unknown) {
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const prisma = {
    wallet: { findMany: vi.fn(async () => wallets) },
    providerSyncState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({}))
    }
  };
  const providers = vi.fn(() => provider);
  // Cast through unknown — the shapes above satisfy only the members
  // walletActivity actually touches, which is all the job needs at runtime.
  return { ctx: { prisma, providers, log } as never, log, providers };
}

describe('walletActivity job — rate-limit hardening', () => {
  it('polls wallets sequentially, never launching all polls concurrently', async () => {
    const wallets: FakeWallet[] = Array.from({ length: 6 }, (_, i) => ({
      id: `w${i}`,
      address: `Addr${i}`,
      chain: 'SOLANA' as const
    }));
    const { provider, getMaxConcurrent } = makeFakeProvider();
    const { ctx } = makeCtx(wallets, provider);

    await run(ctx);

    expect(getMaxConcurrent()).toBe(1);
    expect(provider.getWalletTransactions).toHaveBeenCalledTimes(6);
  });

  it('a single wallet 429 does not crash the cycle and does not stop later wallets from being attempted', async () => {
    const wallets: FakeWallet[] = [
      { id: 'a', address: 'GoodA', chain: 'SOLANA' },
      { id: 'b', address: 'THROTTLED', chain: 'SOLANA' },
      { id: 'c', address: 'GoodC', chain: 'SOLANA' }
    ];
    const { provider } = makeFakeProvider();
    const { ctx } = makeCtx(wallets, provider);

    // Must resolve (not reject) despite the middle wallet throttling.
    await expect(run(ctx)).resolves.toBeUndefined();
    // All three wallets attempted — the throttle didn't short-circuit the loop.
    expect(provider.getWalletTransactions).toHaveBeenCalledTimes(3);
  });

  it('counts and classifies per-wallet failures honestly (rate_limited vs provider_error)', async () => {
    const wallets: FakeWallet[] = [
      { id: 'a', address: 'GoodA', chain: 'SOLANA' },
      { id: 'b', address: 'GoodB', chain: 'SOLANA' },
      { id: 'c', address: 'THROTTLED', chain: 'SOLANA' },
      { id: 'd', address: 'BOOM', chain: 'SOLANA' }
    ];
    const { provider } = makeFakeProvider();
    const { ctx, log } = makeCtx(wallets, provider);

    await run(ctx);

    expect(log.info).toHaveBeenCalledWith(
      'walletActivity cycle complete',
      expect.objectContaining({
        walletsPolled: 4,
        txsIngested: 2,
        walletsWithErrors: 2,
        walletsRateLimited: 1
      })
    );
    // 429 is logged as rate_limited; the generic 500 as provider_error.
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('THROTTLED'),
      expect.objectContaining({ kind: 'rate_limited' })
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('BOOM'),
      expect.objectContaining({ kind: 'provider_error' })
    );
  });

  it('a clean cycle (no throttles) ingests every wallet with zero errors', async () => {
    const wallets: FakeWallet[] = [
      { id: 'a', address: 'GoodA', chain: 'SOLANA' },
      { id: 'b', address: 'GoodB', chain: 'SOLANA' }
    ];
    const { provider } = makeFakeProvider();
    const { ctx, log } = makeCtx(wallets, provider);

    await run(ctx);

    expect(log.info).toHaveBeenCalledWith(
      'walletActivity cycle complete',
      expect.objectContaining({ walletsPolled: 2, txsIngested: 2, walletsWithErrors: 0, walletsRateLimited: 0 })
    );
    expect(log.error).not.toHaveBeenCalled();
  });
});
