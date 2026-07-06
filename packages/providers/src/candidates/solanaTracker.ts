// FlowRadar — Solana Tracker-backed CandidateSourceProvider (Task 36, Wave
// 4.5, Spec §5b). Primary Solana smart-wallet PnL leaderboard feeder.
//
// -----------------------------------------------------------------------
// DOC VERIFICATION (WebFetch'd this session, 2026-07-06)
// -----------------------------------------------------------------------
// https://docs.solanatracker.io/data-api/pnl-v2/leaderboard/solana-traders-leaderboard.md
//
//   GET https://data.solanatracker.io/v2/pnl/leaderboard/top
//   Header: x-api-key: <SOLANA_TRACKER_API_KEY>
//   Query params (doc-verified, all optional except none are required):
//     sort (default 'realized'; also volume|days|roi|win_percentage|trades|tokens)
//     direction (default 'desc')
//     limit (default 100)
//     cursor (pagination cursor from a previous response's pagination.nextCursor)
//     days (1|7|30|90, default 90)
//     minTrades (default 20), minInvested (default 1), minDays (default 3)
//     minWinRate, minRoi, minClosedTokens, maxSingleTokenPct
//     platform (comma-separated), excludeArbitrage (default 'true'), pnlMode (default 'strict')
//
//   Response shape (doc-verified):
//     { traders: [{ wallet, period: { realized, roi, days: { winRate } },
//                   ending: { pnl: { realized, total } },
//                   counts: { trades }, winRate, ... }],
//       pagination: { hasMore, nextCursor, count, total, ... } }
//
// This adapter is Solana-only (chains = ['SOLANA']) per the endpoint's own
// scope (Solana Traders Leaderboard) — no chain param exists to request BSC.
//
// Mapping to ExternalCandidate (per binding decision 1):
//   walletAddress    <- trader.wallet
//   sourceRank        <- 1-based index in the returned page (the endpoint
//                         itself is presented in sorted-leaderboard order but
//                         does not echo a numeric rank field, so this adapter
//                         derives one from response order, same convention
//                         MockCandidateSource uses)
//   claimedPnlUsd     <- trader.ending.pnl.realized ?? trader.period.realized
//   claimedWinRate    <- trader.winRate ?? trader.period.days.winRate (API
//                         returns win rate as a 0-100 percentage per the
//                         `minWinRate` query param's own docs wording
//                         ("Minimum win rate %") — normalized to a 0-1
//                         fraction here so it matches every other
//                         ExternalCandidate.claimedWinRate producer in this
//                         codebase, e.g. MockCandidateSource's 0.30-0.80 range)
//   claimedTradeCount <- trader.counts.trades
//   claimedRoi        <- trader.period.roi (already a plain multiplier per
//                         the `minRoi`/`sort=roi` doc wording, no % scaling)
//
// Missing SOLANA_TRACKER_API_KEY => fetchCandidates returns [] (never
// crashes) — registry-level "missing_key" status reporting is
// getCandidateSourceStatuses's job (see index.ts), not this file's.

import type { Chain } from '@flowradar/core';
import type { CandidateSourceProvider, ExternalCandidate, FetchCandidatesOpts } from './types';
import { createRateLimiter } from '../rateLimiter';
import type { RateLimiter } from '../rateLimiter';

export interface SolanaTrackerEnv {
  SOLANA_TRACKER_API_KEY?: string;
}

const SOLANA_TRACKER_API_BASE = 'https://data.solanatracker.io';
const LEADERBOARD_PATH = '/v2/pnl/leaderboard/top';
// No doc-published rate limit figure was found for this endpoint specifically
// (the general Data API pricing/limits page was not fetched this session,
// out of scope for the leaderboard endpoint alone) — a conservative 2rps
// default is used, same "pick a conservative default and document it rather
// than guess a generous one" approach as every other adapter in this repo
// when a precise doc figure isn't available.
const DEFAULT_RPS = 2;
const DEFAULT_LIMIT = 100;

/** Doc-verified `/v2/pnl/leaderboard/top` response shape (fields this adapter reads only — see file header for the full doc-verified shape). */
interface SolanaTrackerTraderRow {
  wallet: string;
  period?: {
    realized?: number | null;
    roi?: number | null;
    days?: {
      winRate?: number | null;
    };
  };
  ending?: {
    pnl?: {
      realized?: number | null;
      total?: number | null;
    };
  };
  counts?: {
    trades?: number;
  };
  winRate?: number | null;
}

interface SolanaTrackerLeaderboardResponse {
  traders?: SolanaTrackerTraderRow[];
}

/** Maps one doc-verified leaderboard row to an ExternalCandidate — exported so it can be fixture-tested independent of any network call. */
export function mapSolanaTrackerTrader(row: SolanaTrackerTraderRow, rank: number): ExternalCandidate {
  const claimedPnlUsd = row.ending?.pnl?.realized ?? row.period?.realized ?? undefined;
  const rawWinRate = row.winRate ?? row.period?.days?.winRate ?? undefined;
  // Doc wording ("Minimum win rate %") indicates a 0-100 scale; normalize to
  // 0-1 to match every other ExternalCandidate.claimedWinRate producer.
  const claimedWinRate = typeof rawWinRate === 'number' ? rawWinRate / 100 : undefined;
  const claimedTradeCount = row.counts?.trades ?? undefined;
  const claimedRoi = row.period?.roi ?? undefined;

  return {
    walletAddress: row.wallet,
    chain: 'SOLANA',
    sourceRank: rank,
    ...(claimedPnlUsd !== undefined ? { claimedPnlUsd } : {}),
    ...(claimedWinRate !== undefined ? { claimedWinRate } : {}),
    ...(claimedTradeCount !== undefined ? { claimedTradeCount } : {}),
    ...(claimedRoi !== undefined ? { claimedRoi } : {})
  };
}

/**
 * Constructs a Solana Tracker-backed CandidateSourceProvider, or `null` when
 * SOLANA_TRACKER_API_KEY is absent (mirrors solana/helius.ts's
 * "null => missing_key, caller falls back gracefully" contract). Solana-only
 * — fetchCandidates(chain) returns [] for any chain other than 'SOLANA'
 * rather than throwing (this endpoint has no BSC equivalent).
 */
export function createSolanaTrackerCandidateSource(env: SolanaTrackerEnv): CandidateSourceProvider | null {
  const apiKey = env.SOLANA_TRACKER_API_KEY;
  if (!apiKey) return null;

  const limiter: RateLimiter = createRateLimiter({ rps: DEFAULT_RPS });

  return {
    name: 'solana_tracker_pnl',
    chains: ['SOLANA'],
    async fetchCandidates(chain: Chain, opts: FetchCandidatesOpts = {}): Promise<ExternalCandidate[]> {
      if (chain !== 'SOLANA') return [];

      await limiter.acquire();

      const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT));
      const url = new URL(LEADERBOARD_PATH, SOLANA_TRACKER_API_BASE);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('sort', 'realized');
      url.searchParams.set('direction', 'desc');

      const response = await fetch(url.toString(), {
        headers: { 'x-api-key': apiKey }
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '<no response body>');
        // Never interpolate the request URL/headers (no secret is IN the URL
        // here since the key is header-only, but keep the same
        // no-echo-secrets discipline as every other adapter regardless).
        throw new Error(
          `SolanaTracker leaderboard fetch failed (${response.status} ${response.statusText}): ${bodyText}`
        );
      }

      const json = (await response.json()) as SolanaTrackerLeaderboardResponse;
      const traders = json.traders ?? [];
      return traders.slice(0, limit).map((row, i) => mapSolanaTrackerTrader(row, i + 1));
    }
  };
}
