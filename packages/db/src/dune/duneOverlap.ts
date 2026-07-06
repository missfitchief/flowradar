// FlowRadar — runTokenOverlapSearch / runDuneQuerySync: the Wave 4.6 Dune
// overlap-finder + query-source refresh passes (Task 37, dune-feature-wave46.md
// BINDING capture). Consumes @flowradar/providers's DuneClient (real or
// MockDuneOverlapSource, resolved by the caller — same
// worker/seed-sharing pattern as every other job body in this directory, see
// externalWalletSource.ts's own header) and is the ONLY writer of
// TokenOverlapSearch/TokenOverlapWalletResult/TokenOverlapGroupResult.
//
// TRUST BOUNDARY (Spec §5b, restated for Wave 4.6 by dune-feature-wave46.md's
// "Dune rows are never trusted blindly and never auto-promote to tracked
// wallets"): runTokenOverlapSearch ALSO creates a CandidateWallet row per
// distinct wallet in the overlap result set — source='dune_token_overlap',
// validationStatus='pending', deduped on the SAME (walletAddress, chain,
// source) unique tuple every other candidate source uses (Task 34). It NEVER
// writes to Wallet/WalletStats/any signal-path table directly; Task 35's
// existing runCandidateValidation is the only thing that can later promote
// one of these rows. This module does not need its own "import" worker —
// the overlap-search pass itself IS the import (see dune-feature-wave46.md's
// task board: "Fold the overlap import into runTokenOverlapSearch's candidate
// creation ... a separate import worker isn't needed").
//
// CREDIT SAFETY: this module has NO opinion on cached-vs-fresh — that switch
// lives entirely inside the DuneClient it's given (packages/providers/src/
// candidates/dune/client.ts's createDuneClient, gated on
// DUNE_USE_LATEST_RESULT/DUNE_EXECUTE_FRESH). runTokenOverlapSearch just
// records whatever the client reports (usedCachedResult/truncated) onto the
// TokenOverlapSearch row for Task 38's UI "coverage display".

import type { Prisma, PrismaClient } from '@prisma/client';
import type { Chain, Settings } from '@flowradar/core';
import { parseOverlapRows } from '@flowradar/providers';
import type { DuneClient, DuneRawRow } from '@flowradar/providers';

export interface DuneOverlapLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface TokenOverlapSearchInput {
  chain: Chain;
  tokenAddresses: string[];
  minTradeUsd?: number;
  minTokensOverlap?: number;
  maxResults?: number;
  startTime?: string;
  endTime?: string;
}

export interface TokenOverlapSearchResult {
  searchId: string;
  status: 'done' | 'failed';
  rowsReturned: number;
  rowsDropped: number;
  walletResultsCreated: number;
  groupResultsCreated: number;
  candidatesUpserted: number;
  usedCachedResult: boolean;
  truncated: boolean;
  error?: string;
}

/**
 * Resolves a DuneClient for an overlap search. Returns null/undefined to mean
 * "no client available" (missing DUNE_API_KEY in live mode, or MOCK_MODE's
 * own resolver choosing to route through MockDuneOverlapSource directly
 * instead — see apps/worker/src/jobs/duneQuery.ts for how MOCK_MODE wires
 * this) — runTokenOverlapSearch cannot itself run a search with no client and
 * marks the search 'failed' with a clear error rather than crashing.
 */
export type DuneClientResolver = () => DuneClient | null | undefined;

const DEFAULT_QUERY_ID_PLACEHOLDER = 'overlap_finder_ad_hoc';
const DEFAULT_MAX_RESULTS = 500;
const SOURCE_NAME = 'dune_token_overlap';

/**
 * Runs ONE token-overlap search: creates a TokenOverlapSearch row
 * (queued -> running), calls the resolved DuneClient with the overlap query
 * params, Zod-validates the returned rows (dropping + counting invalid ones,
 * NEVER throwing on a bad row), persists TokenOverlapWalletResult +
 * TokenOverlapGroupResult rows, marks the search done|failed, and creates a
 * CandidateWallet per distinct wallet (source='dune_token_overlap', pending,
 * deduped on the existing unique tuple) so Task 35's validation pipeline
 * picks them up on its own next pass.
 */
export async function runTokenOverlapSearch(
  prisma: PrismaClient,
  input: TokenOverlapSearchInput,
  resolveClient: DuneClientResolver,
  log?: DuneOverlapLogger
): Promise<TokenOverlapSearchResult> {
  const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
  const params = {
    min_trade_usd: input.minTradeUsd ?? 0,
    min_tokens_overlap: input.minTokensOverlap ?? 2,
    max_results: maxResults,
    start_time: input.startTime,
    end_time: input.endTime
  };

  const search = await prisma.tokenOverlapSearch.create({
    data: {
      chain: input.chain,
      tokenAddresses: input.tokenAddresses,
      params: params as Prisma.InputJsonValue,
      status: 'running',
      startedAt: new Date()
    }
  });

  try {
    const client = resolveClient();
    if (!client) {
      const errorMessage = 'runTokenOverlapSearch: no DuneClient available (missing DUNE_API_KEY or unresolved mock)';
      await prisma.tokenOverlapSearch.update({
        where: { id: search.id },
        data: { status: 'failed', error: errorMessage, finishedAt: new Date() }
      });
      log?.error(errorMessage, { searchId: search.id });
      return {
        searchId: search.id,
        status: 'failed',
        rowsReturned: 0,
        rowsDropped: 0,
        walletResultsCreated: 0,
        groupResultsCreated: 0,
        candidatesUpserted: 0,
        usedCachedResult: false,
        truncated: false,
        error: errorMessage
      };
    }

    const resultSet = await client.executeQuery(DEFAULT_QUERY_ID_PLACEHOLDER, {
      params: {
        chain: input.chain,
        ...Object.fromEntries(
          input.tokenAddresses.map((addr, i) => [`token_address_${i + 1}`, addr])
        ),
        min_trade_usd: params.min_trade_usd,
        min_tokens_overlap: params.min_tokens_overlap,
        ...(params.start_time ? { start_time: params.start_time } : {}),
        ...(params.end_time ? { end_time: params.end_time } : {})
      },
      limit: maxResults
    });

    const { rows, droppedCount } = parseOverlapRows(resultSet.rows as DuneRawRow[]);

    // Persist wallet results + build overlapGroupId aggregates in the same pass.
    const groupAccumulator = new Map<string, { walletAddresses: Set<string>; sharedTokenCounts: number[] }>();
    let walletResultsCreated = 0;

    for (const row of rows) {
      const chain = (row.chain as Chain | undefined) ?? input.chain;
      await prisma.tokenOverlapWalletResult.create({
        data: {
          searchId: search.id,
          walletAddress: row.wallet_address,
          chain,
          tokensOverlapCount: row.tokens_overlap_count ?? input.tokenAddresses.length,
          totalBuyUsd: row.total_buy_usd ?? null,
          totalSellUsd: row.total_sell_usd ?? null,
          estimatedPnlUsd: row.estimated_pnl_usd ?? null,
          firstBuyTime: row.first_buy_time ? new Date(row.first_buy_time) : null,
          buyCount: row.buy_count ?? null,
          sellCount: row.sell_count ?? null,
          entryMarketCapUsd: row.entry_market_cap_usd ?? null,
          overlapGroupId: row.overlap_group_id ?? null,
          txHashesSample: row.tx_hashes ?? []
        }
      });
      walletResultsCreated += 1;

      if (row.overlap_group_id) {
        const group = groupAccumulator.get(row.overlap_group_id) ?? { walletAddresses: new Set(), sharedTokenCounts: [] };
        group.walletAddresses.add(row.wallet_address);
        group.sharedTokenCounts.push(row.tokens_overlap_count ?? input.tokenAddresses.length);
        groupAccumulator.set(row.overlap_group_id, group);
      }

      // Trust boundary: create/upsert the CandidateWallet row (pending) —
      // the ONLY signal-path-adjacent write this module makes. Never touches
      // Wallet/WalletStats — Task 35's validation pipeline owns that.
      await upsertOverlapCandidate(prisma, chain, row.wallet_address, {
        estimatedPnlUsd: row.estimated_pnl_usd,
        buyCount: row.buy_count,
        sellCount: row.sell_count,
        tokensOverlapCount: row.tokens_overlap_count
      });
    }

    let groupResultsCreated = 0;
    for (const [overlapGroupId, group] of groupAccumulator) {
      // Only genuinely-recurring groups (>= 2 distinct wallets) are worth
      // persisting as a "co-trader group" row — a group of 1 is just that
      // one wallet's own overlap, already captured in its WalletResult row.
      if (group.walletAddresses.size < 2) continue;
      await prisma.tokenOverlapGroupResult.create({
        data: {
          searchId: search.id,
          overlapGroupId,
          walletCount: group.walletAddresses.size,
          walletAddresses: [...group.walletAddresses].sort(),
          sharedTokenCount: Math.min(...group.sharedTokenCounts)
        }
      });
      groupResultsCreated += 1;
    }

    const rowsReturned = resultSet.rowsReturned;
    const truncated = resultSet.truncated || rowsReturned >= maxResults;

    await prisma.tokenOverlapSearch.update({
      where: { id: search.id },
      data: {
        status: 'done',
        rowsReturned,
        usedCachedResult: resultSet.usedCached,
        truncated,
        executionId: resultSet.executionId ?? null,
        finishedAt: new Date()
      }
    });

    const candidatesUpserted = new Set(rows.map((r) => r.wallet_address)).size;

    log?.info('runTokenOverlapSearch: search complete', {
      searchId: search.id,
      rowsReturned,
      droppedCount,
      walletResultsCreated,
      groupResultsCreated,
      candidatesUpserted,
      usedCached: resultSet.usedCached,
      truncated
    });

    return {
      searchId: search.id,
      status: 'done',
      rowsReturned,
      rowsDropped: droppedCount,
      walletResultsCreated,
      groupResultsCreated,
      candidatesUpserted,
      usedCachedResult: resultSet.usedCached,
      truncated
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.tokenOverlapSearch
      .update({ where: { id: search.id }, data: { status: 'failed', error: message, finishedAt: new Date() } })
      .catch(() => undefined);
    log?.error('runTokenOverlapSearch: search failed', { searchId: search.id, error: message });
    return {
      searchId: search.id,
      status: 'failed',
      rowsReturned: 0,
      rowsDropped: 0,
      walletResultsCreated: 0,
      groupResultsCreated: 0,
      candidatesUpserted: 0,
      usedCachedResult: false,
      truncated: false,
      error: message
    };
  }
}

async function upsertOverlapCandidate(
  prisma: PrismaClient,
  chain: Chain,
  walletAddress: string,
  claimed: { estimatedPnlUsd?: number; buyCount?: number; sellCount?: number; tokensOverlapCount?: number }
): Promise<void> {
  const now = new Date();
  const claimedTradeCount = (claimed.buyCount ?? 0) + (claimed.sellCount ?? 0);

  await prisma.candidateWallet.upsert({
    where: {
      walletAddress_chain_source: { walletAddress, chain, source: SOURCE_NAME }
    },
    create: {
      walletAddress,
      chain,
      source: SOURCE_NAME,
      claimedPnlUsd: claimed.estimatedPnlUsd ?? null,
      claimedTradeCount: claimedTradeCount > 0 ? claimedTradeCount : null,
      firstSeenAt: now,
      lastSeenAt: now,
      validationStatus: 'pending',
      metadataJson: { tokensOverlapCount: claimed.tokensOverlapCount ?? null }
    },
    // Re-sync (same anti-clobber contract as externalWalletSource.ts's own
    // upsertCandidateWallet): validationStatus is NEVER touched on an
    // existing row — a 'promoted'/'rejected'/'validating' candidate stays
    // that way even if a later overlap search re-surfaces the same address.
    update: {
      claimedPnlUsd: claimed.estimatedPnlUsd ?? null,
      claimedTradeCount: claimedTradeCount > 0 ? claimedTradeCount : null,
      lastSeenAt: now,
      metadataJson: { tokensOverlapCount: claimed.tokensOverlapCount ?? null }
    }
  });
}

// ---------------------------------------------------------------------------
// runDuneQuerySync — credit-safe refresh of enabled DuneQuerySource rows
// ---------------------------------------------------------------------------

export interface DuneQuerySyncResult {
  sourcesConsidered: number;
  sourcesRefreshed: number;
  sourcesSkippedDisabled: number;
  errors: number;
}

/**
 * Refreshes every ENABLED DuneQuerySource row credit-safely: calls the
 * resolved DuneClient's executeQuery with no `useLatestCached` override,
 * meaning the client's own env-derived default applies (DUNE_USE_LATEST_RESULT,
 * default true => latest-cached-result GET only, never an execute POST,
 * unless the operator has separately set DUNE_EXECUTE_FRESH=true). Updates
 * lastRunAt/lastSuccessAt/lastExecutionId/status per row. Per-row try/catch:
 * one row's client call throwing is caught, logged, and never aborts the
 * pass for any other enabled row (same contract as
 * externalWalletSource.ts's per-source try/catch).
 */
export async function runDuneQuerySync(
  prisma: PrismaClient,
  _settings: Settings,
  resolveClient: DuneClientResolver,
  log?: DuneOverlapLogger
): Promise<DuneQuerySyncResult> {
  const allSources = await prisma.duneQuerySource.findMany();

  let sourcesRefreshed = 0;
  let sourcesSkippedDisabled = 0;
  let errors = 0;

  for (const source of allSources) {
    if (!source.enabled) {
      sourcesSkippedDisabled += 1;
      log?.info('runDuneQuerySync: source disabled, skipping', { source: source.name });
      continue;
    }

    try {
      const client = resolveClient();
      if (!client) {
        log?.info('runDuneQuerySync: no DuneClient available, skipping', { source: source.name });
        continue;
      }

      const resultSet = await client.executeQuery(source.queryId);

      await prisma.duneQuerySource.update({
        where: { id: source.id },
        data: {
          lastRunAt: new Date(),
          lastSuccessAt: new Date(),
          lastExecutionId: resultSet.executionId ?? null,
          status: 'ok'
        }
      });
      sourcesRefreshed += 1;
      log?.info('runDuneQuerySync: source refreshed', {
        source: source.name,
        rowsReturned: resultSet.rowsReturned,
        usedCached: resultSet.usedCached
      });
    } catch (err) {
      errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      await prisma.duneQuerySource
        .update({ where: { id: source.id }, data: { status: 'error', lastRunAt: new Date() } })
        .catch(() => undefined);
      log?.error(`runDuneQuerySync: refresh failed for source ${source.name}`, { source: source.name, error: message });
    }
  }

  const summary: DuneQuerySyncResult = {
    sourcesConsidered: allSources.length,
    sourcesRefreshed,
    sourcesSkippedDisabled,
    errors
  };
  log?.info('runDuneQuerySync cycle complete', { ...summary });
  return summary;
}
