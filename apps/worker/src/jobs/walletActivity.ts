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

import { advanceTimestampCursor, createMassTrackerSession, ingestNormalizedTxs, recordCursorFailure, recordProviderHealth, type MassTrackerSession } from '@flowradar/db';
import { isRateLimitError } from '@flowradar/providers';
import { normalizeMassTransaction, type Chain } from '@flowradar/core';
import type { JobContext } from '../context';

const LIVE_FAILURE_PROVIDER_NAME = 'wallet_activity_live';
const PAGE_LIMIT = 500;
const DEFAULT_MAX_BACKFILL_PAGES = 5;

/**
 * Per-poll page cap (WALLET_ACTIVITY_MAX_PAGES env, default 5; invalid/≤0 →
 * default). Bounds a deep-history wallet's first backfill so it can never stall
 * the sequential cycle or grow memory without limit.
 */
function maxBackfillPages(providerName?: string): number {
  const alchemy = providerName === 'Alchemy';
  const raw = alchemy ? process.env.ALCHEMY_POLLING_MAX_PAGES ?? process.env.WALLET_ACTIVITY_MAX_PAGES : process.env.WALLET_ACTIVITY_MAX_PAGES;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : alchemy ? 1 : DEFAULT_MAX_BACKFILL_PAGES;
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
  const alchemyConfigured = ['SOLANA', 'ETHEREUM', 'BASE', 'ARBITRUM', 'BSC']
    .some((chain) => Boolean(process.env[`ALCHEMY_${chain}_RPC_URL`]?.trim()));
  const raw = process.env.WALLET_ACTIVITY_MAX_WALLETS ?? (alchemyConfigured ? process.env.ALCHEMY_POLLING_MAX_WALLETS : undefined);
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : alchemyConfigured ? 1 : DEFAULT_MAX_WALLETS_PER_CYCLE;
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

const ROTATION_PROVIDER = 'wallet_activity_scheduler';
const ROTATION_SCOPE = 'global_rotation';

interface WalletPollResult {
  pagesFetched: number;
  txsIngested: number;
  backfillTruncated: boolean;
  provider: string;
  latencyMs: number;
}

type HealthOutcome = 'success' | 'error' | 'rate_limited' | 'timeout' | 'missing_key';
interface HealthBucket { provider: string; chain: Chain; outcome: HealthOutcome; count: number; latencyMs: number; error?: unknown }

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, log } = ctx;

  const fetchedWallets = await prisma.wallet.findMany({
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
  // Alchemy Notify is the primary live transport. Keep the complete pollable
  // universe in this deterministic rotation as a recovery path: when any
  // Alchemy RPC is configured, maxWalletsPerCycle()/maxBackfillPages() default
  // to one wallet and one page. That gives us a bounded multi-hour repair
  // sweep without running an aggressive polling pipeline beside webhooks.
  const allWallets = fetchedWallets;
  const rotationState = await prisma.providerSyncState.findUnique({
    where: { provider_chain_scope: { provider: ROTATION_PROVIDER, chain: 'SOLANA', scope: ROTATION_SCOPE } }
  });
  const persistedCycle = Number(rotationState?.cursor ?? 0);
  const cycle = Number.isSafeInteger(persistedCycle) && persistedCycle >= 0 ? persistedCycle : 0;
  const budget = maxWalletsPerCycle();
  const { window: wallets, windows, windowIndex } = selectPollWindow(allWallets, budget, cycle);
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
  const healthBuckets = new Map<string, HealthBucket>();
  const addHealth = (provider: string, chain: Chain, outcome: HealthOutcome, latencyMs: number, error?: unknown) => {
    const key = `${provider}:${chain}:${outcome}`;
    const current = healthBuckets.get(key) ?? { provider, chain, outcome, count: 0, latencyMs: 0 };
    current.count += 1; current.latencyMs += latencyMs; if (error) current.error = error;
    healthBuckets.set(key, current);
  };
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
        addHealth(result.provider, wallet.chain, 'success', result.latencyMs);
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
        addHealth(
          LIVE_FAILURE_PROVIDER_NAME, wallet.chain,
          rateLimited ? 'rate_limited' : /timeout|timed out|abort/i.test(err instanceof Error ? err.message : String(err)) ? 'timeout' : /No live .*provider configured/i.test(err instanceof Error ? err.message : String(err)) ? 'missing_key' : 'error',
          0, err
        );
        log.error(`walletActivity: failed to poll wallet ${wallet.address}`, {
          chain: wallet.chain,
          kind: rateLimited ? 'rate_limited' : 'provider_error',
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    const trackerMetrics = await massTracker.complete();
    for (const health of healthBuckets.values()) {
      await recordProviderHealth(prisma, {
        provider: health.provider, chain: health.chain, capability: 'walletActivity',
        scope: `${health.count} wallets`, outcome: health.outcome,
        latencyMs: health.count ? health.latencyMs / health.count : 0, error: health.error
      });
    }
    await prisma.providerSyncState.upsert({
      where: { provider_chain_scope: { provider: ROTATION_PROVIDER, chain: 'SOLANA', scope: ROTATION_SCOPE } },
      create: { provider: ROTATION_PROVIDER, chain: 'SOLANA', scope: ROTATION_SCOPE, cursor: String(cycle + 1), lastSyncAt: new Date() },
      update: { cursor: String(cycle + 1), lastSyncAt: new Date(), lastError: null, failCount: 0 }
    });
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
  const startedAt = Date.now();

  const activityProvider = providers(chain, 'walletActivity');
  const providerName = activityProvider.providerName ?? 'unknown';
  // Registry-level keyless fallbacks intentionally return MockProvider so
  // generic development jobs can boot. A MOCK_MODE=false production worker
  // must never turn that fallback into fake on-chain evidence or alerts.
  if (process.env.MOCK_MODE === 'false' && /mock/i.test(providerName)) {
    throw new Error(`No live walletActivity provider configured for ${chain}; refusing MockProvider in production`);
  }
  const syncProvider = process.env.MOCK_MODE === 'false' ? providerName.toLowerCase() : 'mock';

  const syncState = await prisma.providerSyncState.findUnique({
    where: { provider_chain_scope: { provider: syncProvider, chain, scope: address } }
  });
  const since = syncState?.cursor ? new Date(syncState.cursor) : undefined;

  const maxPages = maxBackfillPages(providerName);

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
      const historicalBackfill = !syncState?.cursor;
      await massTracker.ingest(result.txs.flatMap((tx) => {
        const observedAt = historicalBackfill ? tx.ts : new Date();
        return normalizeMassTransaction(tx, { chain, provider: providerName, observedAt }, address).map((event) => ({
          ...event,
          metadata: { ...event.metadata, historicalBackfill, alchemyRpc: providerName === 'Alchemy' }
        }));
      }));
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

  await advanceTimestampCursor(prisma, {
    provider: syncProvider, chain, scope: address, nextCursor,
    eventCount: txsIngested, syncedAt: new Date()
  });

  return { pagesFetched, txsIngested, backfillTruncated, provider: providerName, latencyMs: Date.now() - startedAt };
}

async function recordSyncFailure(prisma: JobContext['prisma'], chain: Chain, address: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const failureProvider = process.env.MOCK_MODE === 'false' ? LIVE_FAILURE_PROVIDER_NAME : 'mock';
  await recordCursorFailure(prisma, { provider: failureProvider, chain, scope: address, error: message });
}
