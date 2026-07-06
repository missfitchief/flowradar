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
