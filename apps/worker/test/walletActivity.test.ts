// FlowRadar — walletActivity job tests (rate-limit hardening 2026-07-07 +
// bounded backfill F7 2026-07-07).
//
// These lock in the job-level contract: polls are SEQUENTIAL (never a
// concurrent burst); a provider throttle (429) doesn't crash the cycle; later
// wallets are still reached after a throttled/deep one; per-wallet failures are
// counted + classified honestly (rate_limited vs provider_error); and the
// initial backfill is BOUNDED — ingesting per page, capping first-poll pages,
// never accumulating a wallet's whole history in memory, and resuming
// incrementally via the advanced cursor.
//
// @flowradar/db is mocked so the job runs with no real database; the job is
// driven by a hand-built JobContext (stateful fake prisma + paginating fake
// provider + spy logger). isRateLimitError / HeliusRateLimitError are REAL.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@flowradar/db', () => ({
  ingestNormalizedTxs: vi.fn(async () => {})
}));

import { ingestNormalizedTxs } from '@flowradar/db';
import { HeliusRateLimitError } from '@flowradar/providers';
import type { NormalizedTx } from '@flowradar/core';
import { run } from '../src/jobs/walletActivity';

const ingestMock = vi.mocked(ingestNormalizedTxs);

interface FakeWallet {
  id: string;
  address: string;
  chain: 'SOLANA' | 'BSC';
}

function makeTx(seq = 0): NormalizedTx {
  // Only `.ts` (a Date) is read by walletActivity (cursor advance); the rest of
  // the shape is irrelevant because ingestNormalizedTxs is mocked out.
  return { ts: new Date(1_000 + seq) } as unknown as NormalizedTx;
}

/**
 * Fake WalletActivityProvider that (a) tracks max concurrent
 * getWalletTransactions calls (proves no bursting), (b) throws a 429 for
 * 'THROTTLED' / a generic error for 'BOOM', and (c) for any address in
 * `historyByAddress` paginates a synthetic history of that many txs (page size
 * = opts.limit), returning a `nextCursor` offset while more remain — otherwise
 * a single one-tx page. Every call's opts are recorded for assertions.
 */
function makeFakeProvider(historyByAddress: Record<string, number> = {}) {
  let active = 0;
  let maxConcurrent = 0;
  const calls: { address: string; cursor?: string; since?: Date }[] = [];
  const getWalletTransactions = vi.fn(
    async (_chain: string, address: string, opts: { cursor?: string; limit?: number; since?: Date } = {}) => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      calls.push({ address, cursor: opts.cursor, since: opts.since });
      await Promise.resolve(); // yield — a Promise.all-style caller would overlap here
      try {
        if (address === 'THROTTLED') throw new HeliusRateLimitError('Helius rate-limited (429 Too Many Requests)');
        if (address === 'BOOM') throw new Error('provider exploded (500 Internal Server Error)');
        const total = historyByAddress[address];
        if (total === undefined) {
          return { txs: [makeTx(0)], nextCursor: undefined as string | undefined };
        }
        const limit = opts.limit ?? 100;
        const start = opts.cursor ? Number(opts.cursor) : 0;
        const end = Math.min(start + limit, total);
        const txs = Array.from({ length: Math.max(0, end - start) }, (_, i) => makeTx(start + i));
        const nextCursor = end < total ? String(end) : undefined;
        return { txs, nextCursor };
      } finally {
        active -= 1;
      }
    }
  );
  return {
    provider: { providerName: 'FakeHelius', getWalletTransactions },
    getMaxConcurrent: () => maxConcurrent,
    calls
  };
}

/** Stateful JobContext: providerSyncState persists cursors per address across polls. */
function makeCtx(wallets: FakeWallet[], provider: unknown) {
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const cursors = new Map<string, string | null>();
  const prisma = {
    wallet: { findMany: vi.fn(async () => wallets) },
    providerSyncState: {
      findUnique: vi.fn(async ({ where }: { where: { provider_chain_scope: { scope: string } } }) => {
        const scope = where.provider_chain_scope.scope;
        return cursors.has(scope) ? { cursor: cursors.get(scope) } : null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update
        }: {
          where: { provider_chain_scope: { scope: string } };
          create: { cursor: string | null };
          update: { cursor: string | null };
        }) => {
          const scope = where.provider_chain_scope.scope;
          cursors.set(scope, create?.cursor ?? update?.cursor ?? null);
          return {};
        }
      )
    }
  };
  const providers = vi.fn(() => provider);
  return { ctx: { prisma, providers, log } as never, log, cursors };
}

beforeEach(() => {
  ingestMock.mockClear();
  delete process.env.WALLET_ACTIVITY_MAX_PAGES;
});
afterEach(() => {
  delete process.env.WALLET_ACTIVITY_MAX_PAGES;
});

describe('walletActivity — sequencing + honest error handling', () => {
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

  it('a single wallet 429 does not crash the cycle and does not stop later wallets', async () => {
    const wallets: FakeWallet[] = [
      { id: 'a', address: 'GoodA', chain: 'SOLANA' },
      { id: 'b', address: 'THROTTLED', chain: 'SOLANA' },
      { id: 'c', address: 'GoodC', chain: 'SOLANA' }
    ];
    const { provider } = makeFakeProvider();
    const { ctx } = makeCtx(wallets, provider);

    await expect(run(ctx)).resolves.toBeUndefined();
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
      expect.objectContaining({ walletsPolled: 4, txsIngested: 2, walletsWithErrors: 2, walletsRateLimited: 1 })
    );
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

describe('walletActivity — bounded backfill (F7)', () => {
  it('ingests PER PAGE (never accumulating whole history) and stops at the page cap', async () => {
    process.env.WALLET_ACTIVITY_MAX_PAGES = '3';
    // A deep-history wallet: 10 000 txs, page size 500 (PAGE_LIMIT) => 20 pages
    // uncapped. The cap must stop it at 3 pages / 1500 txs.
    const { provider } = makeFakeProvider({ DEEP: 10_000 });
    const { ctx, log } = makeCtx([{ id: 'd', address: 'DEEP', chain: 'SOLANA' }], provider);

    await run(ctx);

    // Exactly maxPages fetches — NOT the 20 a full backfill would take.
    expect(provider.getWalletTransactions).toHaveBeenCalledTimes(3);
    // Ingested per page: 3 separate calls (never one giant 1500-tx array).
    expect(ingestMock).toHaveBeenCalledTimes(3);
    for (const call of ingestMock.mock.calls) {
      expect((call[3] as unknown[]).length).toBe(500); // each ingest is one page
    }
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('bounded backfill truncated for DEEP'),
      expect.objectContaining({ pagesFetched: 3 })
    );
    expect(log.info).toHaveBeenCalledWith(
      'walletActivity cycle complete',
      expect.objectContaining({ txsIngested: 1500, pagesFetched: 3, walletsBackfillTruncated: 1 })
    );
  });

  it('a deep-history first wallet does not prevent the second wallet from being polled', async () => {
    process.env.WALLET_ACTIVITY_MAX_PAGES = '2';
    const { provider, calls } = makeFakeProvider({ DEEP: 10_000 });
    const wallets: FakeWallet[] = [
      { id: 'd', address: 'DEEP', chain: 'SOLANA' },
      { id: 'g', address: 'GOOD', chain: 'SOLANA' }
    ];
    const { ctx } = makeCtx(wallets, provider);

    await run(ctx);

    // DEEP capped at 2 pages, then GOOD reached in the same cycle.
    const deepCalls = calls.filter((c) => c.address === 'DEEP').length;
    const goodCalls = calls.filter((c) => c.address === 'GOOD').length;
    expect(deepCalls).toBe(2);
    expect(goodCalls).toBe(1);
  });

  it('does NOT truncate a wallet whose history fits within the cap', async () => {
    process.env.WALLET_ACTIVITY_MAX_PAGES = '5';
    // 700 txs, page size 500 => 2 pages, ends naturally before the cap.
    const { provider } = makeFakeProvider({ SHALLOW: 700 });
    const { ctx, log } = makeCtx([{ id: 's', address: 'SHALLOW', chain: 'SOLANA' }], provider);

    await run(ctx);

    expect(provider.getWalletTransactions).toHaveBeenCalledTimes(2); // 500 + 200, then nextCursor undefined
    expect(ingestMock).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      'walletActivity cycle complete',
      expect.objectContaining({ txsIngested: 700, walletsBackfillTruncated: 0 })
    );
  });

  // NB: this proves the advanced cursor is passed as `since` on the next poll
  // (so re-polls resume incrementally rather than from scratch). Actual row
  // dedupe / no-duplicate-trades is ingestNormalizedTxs's own concern and is
  // covered by ingest.ts's tests — it can't be asserted here since ingest is mocked.
  it('re-poll passes the advanced cursor as `since` (resumes incrementally, not from scratch)', async () => {
    process.env.WALLET_ACTIVITY_MAX_PAGES = '3';
    const { provider, calls } = makeFakeProvider({ DEEP: 10_000 });
    const { ctx } = makeCtx([{ id: 'd', address: 'DEEP', chain: 'SOLANA' }], provider);

    await run(ctx); // first poll: since=undefined, capped at 3 pages, cursor advances
    const firstPollCalls = calls.length;
    expect(calls[0]!.since).toBeUndefined(); // first ever poll has no cursor

    await run(ctx); // second poll: must use the advanced cursor as `since`
    const secondPollFirstCall = calls[firstPollCalls];
    expect(secondPollFirstCall).toBeDefined();
    expect(secondPollFirstCall!.since).toBeInstanceOf(Date); // cursor from poll 1 used as `since` on poll 2
  });
});
