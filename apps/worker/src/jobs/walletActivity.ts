// FlowRadar — walletActivity job (Task 5 brief decision 3; bounded backfill
// 2026-07-07).
//
// For every Wallet worth polling (isWatched=true OR it already has at least
// one WalletStats row), fetches new provider activity since the last recorded
// cursor, ingests it via @flowradar/db's ingestNormalizedTxs, and advances the
// cursor. Per-wallet failures are caught and recorded on ProviderSyncState
// (lastError/failCount) rather than rethrown — one wallet's provider error
// never aborts the whole job run or the runner's scheduled tick for other
// wallets.
//
// BOUNDED BACKFILL (F7, 2026-07-07 live-validation finding): each poll ingests
// PER PAGE (never accumulating a wallet's whole history into one array) and
// fetches at most WALLET_ACTIVITY_MAX_PAGES pages. The old code paginated a
// wallet's ENTIRE history into one `allTxs` array before ingesting once, so a
// deep-history active wallet grew memory unbounded and never finished — and
// because polling is sequential, that stalled every later wallet in the cycle.
// With the page cap: one deep wallet can't block the cycle and memory stays
// bounded to a single page. Pagination ORDER differs by provider, which matters
// for what the cap keeps:
//   - Helius (before-signature) paginates newest→oldest, so the cap keeps the
//     NEWEST pages — exactly what a recent-activity tracker wants — and a first
//     backfill intentionally skips older history beyond the cap (logged as
//     backfillTruncated; FlowRadar's signals key off recent activity).
//   - the mock provider paginates oldest→newest, so there the cap keeps the
//     OLDEST pages and the advanced cursor walks the wallet forward over
//     successive cycles until its history is covered (no data lost). In
//     practice no mock wallet exceeds the cap, so this only matters as
//     documented intent.
// Either way the cursor advance + the ingest layer's own dedupe keep re-polls
// idempotent.

import { createMassTrackerSession, ingestNormalizedTxs, type MassTrackerSession } from '@flowradar/db';
import { isRateLimitError } from '@flowradar/providers';
import { normalizeMassTransaction, type Chain } from '@flowradar/core';
import type { JobContext } from '../context';

const PROVIDER_NAME = 'mock';
const PAGE_LIMIT = 500;
const DEFAULT_MAX_BACKFILL_PAGES = 5;

/**
 * Per-poll page cap (WALLET_ACTIVITY_MAX_PAGES env, default 5; invalid/≤0 →
 * default). Bounds a deep-history wallet's first backfill so it can never stall
 * the sequential cycle or grow memory without limit.
 */
function maxBackfillPages(): number {
  const raw = process.env.WALLET_ACTIVITY_MAX_PAGES;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_BACKFILL_PAGES;
}

/**
 * Per-CYCLE wallet budget (WALLET_ACTIVITY_MAX_WALLETS env, default 200;
 * invalid/≤0 → default). Overnight 2026-07-11 (Codex final delta review): the
 * observation-universe import grew the pollable set from ~150 to 650 wallets
 * in one commit — without a wallet budget, a worker (re)start would silently
 * commit the FULL set to provider polling every cycle (global rule 19:
 * bounded budgets). Wallets over budget are NOT dropped: cycles rotate
 * deterministic windows over the id-ordered set, so every wallet is still
 * covered every ceil(N/budget) cycles.
 */
const DEFAULT_MAX_WALLETS_PER_CYCLE = 200;
function maxWalletsPerCycle(): number {
  const raw = process.env.WALLET_ACTIVITY_MAX_WALLETS;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_WALLETS_PER_CYCLE;
}

/**
 * Deterministic rotation window: cycle k over N wallets with budget B polls
 * ids[ (k mod ceil(N/B))·B .. +B ). Pure — exported for unit tests. A worker
 * restart resets the counter to window 0; while running, consecutive cycles
 * cover the whole set.
 */
export function selectPollWindow<T>(all: T[], budget: number, cycle: number): { window: T[]; windows: number; windowIndex: number } {
  if (all.length <= budget) return { window: all, windows: 1, windowIndex: 0 };
  const windows = Math.ceil(all.length / budget);
  const windowIndex = ((cycle % windows) + windows) % windows;
  return { window: all.slice(windowIndex * budget, (windowIndex + 1) * budget), windows, windowIndex };
}

let pollCycleCounter = 0;

interface WalletPollResult {
  pagesFetched: number;
  txsIngested: number;
  backfillTruncated: boolean;
}

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, log } = ctx;

  const allWallets = await prisma.wallet.findMany({
    where: {
      // Phase 0 taxonomy (feat/pre-public-accumulation): excluded wallets
      // are never polled; observation_only wallets are ALWAYS pollable (the
      // spec's "polled but zero signal weight" guarantee — a stats-less
      // receiver/discovery wallet must still have its activity persisted,
      // which the legacy watched-or-has-stats predicate alone would skip).
      // Other statuses keep the original activity criteria. Signal weight is
      // enforced downstream (aggregateWindow status gate, Rule E/F gates).
      status: { not: 'excluded' },
      OR: [{ isWatched: true }, { stats: { some: {} } }, { status: 'observation_only' }]
    },
    select: { id: true, address: true, chain: true },
    orderBy: { id: 'asc' } // stable order — rotation windows are deterministic
  });
  const budget = maxWalletsPerCycle();
  const { window: wallets, windows, windowIndex } = selectPollWindow(allWallets, budget, pollCycleCounter);
  pollCycleCounter += 1;
  if (windows > 1) {
    log.info(
      `walletActivity budget: polling ${wallets.length}/${allWallets.length} wallets (window ${windowIndex + 1}/${windows}, budget ${budget}) — full set covered every ${windows} cycles`
    );
  }

  let totalIngestedTxs = 0;
  let totalPagesFetched = 0;
  let walletsWithErrors = 0;
  let walletsRateLimited = 0;
  let walletsBackfillTruncated = 0;
  const massTracker = await createMassTrackerSession(prisma, {
    enrollReceivers: true,
    metadata: { job: 'walletActivity', mode: process.env.MOCK_MODE === 'false' ? 'live' : 'mock' }
  });

  // Sequential by design: each wallet is awaited before the next, so the
  // provider's shared rate limiter (one instance per cached provider) meters
  // the whole cycle rather than a burst of concurrent calls. With the per-poll
  // page cap (pollAndIngestWallet), a single deep-history wallet can no longer
  // stall the loop, so later wallets are always reached. A single wallet's
  // provider error — including a provider throttle (429) that survived the
  // adapter's own backoff/retries — is caught and recorded per-wallet, never
  // rethrown, so it can't abort the rest of the cycle.
  try {
    for (const wallet of wallets) {
      try {
        const result = await pollAndIngestWallet(ctx, wallet.address, wallet.chain, massTracker);
        totalIngestedTxs += result.txsIngested;
        totalPagesFetched += result.pagesFetched;
        if (result.backfillTruncated) {
          walletsBackfillTruncated += 1;
          log.info(`walletActivity: bounded backfill truncated for ${wallet.address}`, {
            chain: wallet.chain,
            pagesFetched: result.pagesFetched,
            txsIngested: result.txsIngested,
            maxPages: maxBackfillPages()
          });
        }
      } catch (err) {
        massTracker.recordProviderError();
        walletsWithErrors += 1;
        const rateLimited = isRateLimitError(err);
        if (rateLimited) walletsRateLimited += 1;
        await recordSyncFailure(prisma, wallet.chain, wallet.address, err);
        log.error(`walletActivity: failed to poll wallet ${wallet.address}`, {
          chain: wallet.chain,
          kind: rateLimited ? 'rate_limited' : 'provider_error',
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    const trackerMetrics = await massTracker.complete();
    log.info('walletActivity cycle complete', {
      walletsPolled: wallets.length, txsIngested: totalIngestedTxs,
      pagesFetched: totalPagesFetched, walletsWithErrors, walletsRateLimited,
      walletsBackfillTruncated, massTrackerRunId: trackerMetrics.runId,
      massEvents: trackerMetrics.inputEvents, massEventsPerSec: trackerMetrics.throughputPerSec,
      massPeakHeapBytes: trackerMetrics.peakHeapBytes, massRetries: trackerMetrics.retryAttempts
    });
  } catch (error) {
    await massTracker.fail(error);
    throw error;
  }
}

async function pollAndIngestWallet(ctx: JobContext, address: string, chain: Chain, massTracker: MassTrackerSession): Promise<WalletPollResult> {
  const { prisma, providers } = ctx;

  const syncState = await prisma.providerSyncState.findUnique({
    where: { provider_chain_scope: { provider: PROVIDER_NAME, chain, scope: address } }
  });
  const since = syncState?.cursor ? new Date(syncState.cursor) : undefined;

  const activityProvider = providers(chain, 'walletActivity');
  const maxPages = maxBackfillPages();

  let cursor: string | undefined;
  let pagesFetched = 0;
  let txsIngested = 0;
  let backfillTruncated = false;
  let latestTs: Date | null = null;

  for (;;) {
    if (pagesFetched >= maxPages) {
      // Page cap reached — stop this poll instead of paginating the wallet's
      // entire back-history. The cursor advance (below) sits past everything
      // ingested this poll, so the next cycle resumes from there (see the
      // per-provider ordering note in the file header).
      backfillTruncated = true;
      break;
    }

    const result = await activityProvider.getWalletTransactions(chain, address, {
      since,
      cursor,
      limit: PAGE_LIMIT
    });
    pagesFetched += 1;

    if (result.txs.length > 0) {
      // Ingest THIS page immediately — never accumulate the whole history in
      // memory. ingestNormalizedTxs is additive and dedupes, so per-page ingest
      // yields the identical DB state as one whole-history ingest.
      await ingestNormalizedTxs(prisma, chain, address, result.txs);
      const observedAt = new Date();
      const provider = activityProvider.providerName ?? PROVIDER_NAME;
      await massTracker.ingest(result.txs.flatMap((tx) => normalizeMassTransaction(tx, { chain, provider, observedAt }, address)));
      txsIngested += result.txs.length;
      for (const tx of result.txs) {
        if (!latestTs || tx.ts.getTime() > latestTs.getTime()) latestTs = tx.ts;
      }
    } else if (since !== undefined) {
      // Incremental poll (we already have a cursor) and this page yielded
      // nothing new after the since-filter. Pagination is strictly
      // newest→oldest, so every older page is also older than `since` — stop
      // early rather than walk the whole back-history every cycle.
      break;
    }

    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  // MockProvider's `since` filter is inclusive (tx.ts >= since), so storing the
  // latest-seen tx's own timestamp verbatim would re-fetch that exact tx again
  // on the very next poll forever (harmless — ingest dedupes — but wastefully
  // re-processes the same tail every cycle). Advancing 1ms past the latest-seen
  // timestamp makes the next poll's `since` cleanly exclusive of everything
  // already processed.
  const nextCursor = latestTs ? new Date(latestTs.getTime() + 1).toISOString() : (syncState?.cursor ?? null);

  await prisma.providerSyncState.upsert({
    where: { provider_chain_scope: { provider: PROVIDER_NAME, chain, scope: address } },
    create: {
      provider: PROVIDER_NAME,
      chain,
      scope: address,
      cursor: nextCursor,
      lastSyncAt: new Date(),
      lastError: null,
      failCount: 0
    },
    update: {
      cursor: nextCursor,
      lastSyncAt: new Date(),
      lastError: null,
      failCount: 0
    }
  });

  return { pagesFetched, txsIngested, backfillTruncated };
}

async function recordSyncFailure(prisma: JobContext['prisma'], chain: Chain, address: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.providerSyncState.upsert({
    where: { provider_chain_scope: { provider: PROVIDER_NAME, chain, scope: address } },
    create: {
      provider: PROVIDER_NAME,
      chain,
      scope: address,
      lastError: message,
      failCount: 1
    },
    update: {
      lastError: message,
      failCount: { increment: 1 }
    }
  });
}
