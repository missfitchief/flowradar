// FlowRadar — external candidate-wallet source connector interface (Task 34,
// Wave 4.5, Spec §5b).
//
// A CandidateSourceProvider is a FEEDER, not a validator: it hands back
// addresses + the source's OWN claimed performance figures (never trusted —
// Task 35's validation pipeline is the only thing that can promote a
// candidate to a real, tracked Wallet). Live adapters (Solana Tracker,
// Birdeye, KOLScan, GMGN, Cielo — Task 36) implement this same interface
// against their real APIs; MockCandidateSource (mockSource.ts) is the
// deterministic MOCK_MODE implementation every source name resolves to until
// then (see apps/worker/src/jobs/externalWalletSource.ts's resolveSource).

import type { Chain } from '@flowradar/core';

/** One external source's claimed figures for one wallet address — never trusted at face value. */
export interface ExternalCandidate {
  walletAddress: string;
  chain: Chain;
  /** The source's own leaderboard rank for this wallet, if it publishes one (1 = best). */
  sourceRank?: number;
  claimedPnlUsd?: number;
  claimedWinRate?: number;
  claimedTradeCount?: number;
  claimedRoi?: number;
  metadata?: Record<string, unknown>;
}

export interface FetchCandidatesOpts {
  /** Maximum number of candidates to return for this chain. */
  limit?: number;
}

/**
 * A candidate-wallet feeder for one or more chains. `name` should match the
 * corresponding ExternalWalletSource.name row (see Task 34 binding decision
 * 5's 6 seeded source names) so runExternalWalletSourceSync's resolver can
 * look providers up by that name.
 */
export interface CandidateSourceProvider {
  name: string;
  chains: Chain[];
  fetchCandidates(chain: Chain, opts?: FetchCandidatesOpts): Promise<ExternalCandidate[]>;
}

// ---------------------------------------------------------------------------
// Token top-traders capability (Task 35, Wave 4.5, Spec §5b) — feeds
// tokenTopTraderBackfill: tokens whose mcap recently expanded a lot get their
// top traders pulled and inserted as CandidateWallet rows
// (source='birdeye_top_traders'), same "never trusted at face value, goes
// through the validation pipeline" contract as every other candidate source.
// ---------------------------------------------------------------------------

/** One top trader for a specific token, as reported by a TokenTopTradersProvider — never trusted at face value. */
export interface TokenTopTrader {
  walletAddress: string;
  chain: Chain;
  pnlUsd?: number;
  winRate?: number;
  tradeCount?: number;
  // Optional PROVIDER-CLAIMED detail fields (runner-mining top-PnL discovery,
  // additive — existing consumers unaffected). Claims, never local truth.
  realizedPnlUsd?: number | null;
  unrealizedPnlUsd?: number | null;
  totalPnlUsd?: number | null;
  volumeBuyUsd?: number | null;
  volumeSellUsd?: number | null;
  remainingUsd?: number | null;
  tradeBuy?: number | null;
  tradeSell?: number | null;
  tags?: string[];
  /** Verbatim provider item — receipt for auditing the claim. */
  raw?: unknown;
}

export interface GetTopTradersOpts {
  limit?: number;
  /** Doc-verified sort_by values (birdeye): volume | trade | total_pnl | unrealized_pnl | realized_pnl | volume_usd. */
  sortBy?: 'volume' | 'trade' | 'total_pnl' | 'unrealized_pnl' | 'realized_pnl' | 'volume_usd';
  /** Doc-verified time_frame values (birdeye caps at 24h — a PRESENT-window view, never historical). */
  timeFrame?: '30m' | '1h' | '2h' | '4h' | '6h' | '8h' | '12h' | '24h';
}

export interface TokenTopTradersProvider {
  getTopTraders(chain: Chain, tokenAddress: string, opts?: GetTopTradersOpts): Promise<TokenTopTrader[]>;
}
