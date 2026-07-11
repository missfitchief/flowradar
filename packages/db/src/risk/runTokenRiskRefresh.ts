// FlowRadar — runTokenRiskRefresh: the ONE bounded risk-refresh job (Task 1).
//
// The sole caller of the real risk provider. Scans traded tokens that need a
// fresh snapshot — MISSING a snapshot, or DUE (nextRefreshAt <= now) — bounded
// to `limit` per run, and refreshes each via TokenRiskCache.refreshToken
// (which dedups, backs off on 429, and never throws). Missing snapshots are
// prioritized (they read as "unknown"); then the most-overdue due snapshots.
//
// Bounded on purpose: a single run fetches at most `limit` tokens, so the
// per-cycle Helius call volume is CAPPED regardless of universe size — this is
// what replaces the unbounded per-token-per-pass burst (shadow finding H-1).
// Pending work is PERSISTED in the snapshot rows (nextRefreshAt), so a process
// restart resumes exactly where it left off; nothing is queued in memory.

import type { PrismaClient } from '@prisma/client';
import type { Chain } from '@flowradar/core';
import type { TokenRiskCache } from './tokenRiskCache';

export interface TokenRiskRefreshOptions {
  /** Max tokens to fetch this run (hard cap on provider calls). */
  limit?: number;
  /** Restrict to a single chain (default: all). */
  chain?: Chain;
}

export interface TokenRiskRefreshMetrics {
  considered: number;
  refreshed: number;
  throttled: number;
  unavailable: number;
  errors: number;
  /** Selected but another job/process already owned the refresh — no provider call issued. */
  skipped: number;
  missingSelected: number;
  dueSelected: number;
}

const DEFAULT_LIMIT = 200;

type Candidate = { id: string; chain: Chain; address: string };

/**
 * Selects up to `limit` traded tokens needing a risk refresh: first those with
 * NO snapshot (never fetched → currently read as unknown), then the most
 * overdue existing snapshots (nextRefreshAt <= now, oldest first). Two queries
 * keep the ordering deterministic without fighting Prisma's null-ordering on a
 * nested relation.
 */
async function selectDue(
  prisma: PrismaClient,
  now: Date,
  limit: number,
  chain?: Chain
): Promise<{ missing: Candidate[]; due: Candidate[] }> {
  const chainWhere = chain ? { chain: chain as 'SOLANA' | 'BSC' } : {};

  const missingRows = await prisma.token.findMany({
    where: { ...chainWhere, trades: { some: {} }, riskSnapshot: null },
    take: limit,
    select: { id: true, chain: true, address: true }
  });
  const missing: Candidate[] = missingRows.map((t) => ({ id: t.id, chain: t.chain as Chain, address: t.address }));

  const remaining = limit - missing.length;
  let due: Candidate[] = [];
  if (remaining > 0) {
    const dueRows = await prisma.token.findMany({
      where: { ...chainWhere, trades: { some: {} }, riskSnapshot: { nextRefreshAt: { lte: now } } },
      take: remaining,
      orderBy: { riskSnapshot: { nextRefreshAt: 'asc' } },
      select: { id: true, chain: true, address: true }
    });
    due = dueRows.map((t) => ({ id: t.id, chain: t.chain as Chain, address: t.address }));
  }

  return { missing, due };
}

/**
 * Runs one bounded risk-refresh pass. Never throws on a single token's failure
 * — each is caught and reflected in the returned metrics (the pass continues).
 */
export async function runTokenRiskRefresh(
  cache: TokenRiskCache,
  prisma: PrismaClient,
  opts: TokenRiskRefreshOptions = {}
): Promise<TokenRiskRefreshMetrics> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const now = new Date();
  const { missing, due } = await selectDue(prisma, now, limit, opts.chain);
  const candidates = [...missing, ...due].slice(0, limit);

  const metrics: TokenRiskRefreshMetrics = {
    considered: candidates.length,
    refreshed: 0,
    throttled: 0,
    unavailable: 0,
    errors: 0,
    skipped: 0,
    missingSelected: missing.length,
    dueSelected: due.length
  };

  // Sequential: the underlying provider is itself rate-limited, and sequential
  // keeps the in-flight map (and thus memory) tightly bounded. refreshToken
  // never throws, but guard anyway so one token can never abort the batch.
  // Count by what THIS attempt actually did (not the row status, which another
  // claimant may have written) so metrics don't overstate refresh throughput.
  for (const token of candidates) {
    try {
      const { outcome } = await cache.refreshTokenDetailed(token);
      switch (outcome) {
        case 'refreshed':
          metrics.refreshed += 1;
          break;
        case 'unavailable':
          metrics.unavailable += 1;
          metrics.refreshed += 1; // a definitive answer was obtained
          break;
        case 'throttled':
          metrics.throttled += 1;
          break;
        case 'skipped_claim':
          metrics.skipped += 1;
          break;
        case 'error':
        default:
          metrics.errors += 1;
          break;
      }
    } catch {
      metrics.errors += 1;
    }
  }

  return metrics;
}
