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

import { ingestNormalizedTxs } from '@flowradar/db';
import { isRateLimitError } from '@flowradar/providers';
import type { Chain } from '@flowradar/core';
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

interface WalletPollResult {
  pagesFetched: number;
  txsIngested: number;
  backfillTruncated: boolean;
}

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, log } = ctx;

  const wallets = await prisma.wallet.findMany({
    where: {
      // Phase 0 taxonomy (feat/pre-public-accumulation): excluded wallets
      // are never polled. Every OTHER status stays polled when it meets the
      // original activity criteria — observation_only wallets in particular
      // keep their activity persisted (they just carry zero signal weight,
      // enforced downstream in aggregateWindow's status gate).
      status: { not: 'excluded' },
      OR: [{ isWatched: true }, { stats: { some: {} } }]
    },
    select: { id: true, address: true, chain: true }
  });

  let totalIngestedTxs = 0;
  let totalPagesFetched = 0;
  let walletsWithErrors = 0;
  let walletsRateLimited = 0;
  let walletsBackfillTruncated = 0;

  // Sequential by design: each wallet is awaited before the next, so the
  // provider's shared rate limiter (one instance per cached provider) meters
  // the whole cycle rather than a burst of concurrent calls. With the per-poll
  // page cap (pollAndIngestWallet), a single deep-history wallet can no longer
  // stall the loop, so later wallets are always reached. A single wallet's
  // provider error — including a provider throttle (429) that survived the
  // adapter's own backoff/retries — is caught and recorded per-wallet, never
  // rethrown, so it can't abort the rest of the cycle.
  for (const wallet of wallets) {
    try {
      const result = await pollAndIngestWallet(ctx, wallet.address, wallet.chain);
      totalIngestedTxs += result.txsIngested;
      totalPagesFetched += result.pagesFetched;
      if (result.backfillTruncated) {
        walletsBackfillTruncated += 1;
        // Not silent: we hit the page cap and deliberately stopped this poll;
        // the advanced cursor means the next cycle continues from newer activity.
        log.info(`walletActivity: bounded backfill truncated for ${wallet.address}`, {
          chain: wallet.chain,
          pagesFetched: result.pagesFetched,
          txsIngested: result.txsIngested,
          maxPages: maxBackfillPages()
        });
      }
    } catch (err) {
      walletsWithErrors += 1;
      const rateLimited = isRateLimitError(err);
      if (rateLimited) walletsRateLimited += 1;
      await recordSyncFailure(prisma, wallet.chain, wallet.address, err);
      log.error(`walletActivity: failed to poll wallet ${wallet.address}`, {
        chain: wallet.chain,
        // Honest classification: a provider throttle is rate_limited, not an
        // auth_error or unknown failure (live-validation finding 2026-07-07).
        kind: rateLimited ? 'rate_limited' : 'provider_error',
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  log.info('walletActivity cycle complete', {
    walletsPolled: wallets.length,
    txsIngested: totalIngestedTxs,
    pagesFetched: totalPagesFetched,
    walletsWithErrors,
    walletsRateLimited,
    walletsBackfillTruncated
  });
}

async function pollAndIngestWallet(ctx: JobContext, address: string, chain: Chain): Promise<WalletPollResult> {
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
