// FlowRadar — KOLScan typed stub CandidateSourceProvider (Task 36, Wave 4.5,
// Spec §5b). Solana KOL leaderboard feeder, candidate-only until revalidated
// (`kolscan` source name).
//
// -----------------------------------------------------------------------
// DOC VERIFICATION — NO OFFICIAL PUBLIC API
// -----------------------------------------------------------------------
// KOLScan (kolscan.io) publishes a web leaderboard UI with no discovered
// official public API or developer docs. Per the standing rule ("no
// hardcoded unofficial endpoints ... KOLScan + GMGN: NO official public API
// confirmed => TYPED STUBS ONLY with a CONFIGURABLE base URL env"), this
// adapter never hardcodes any scraping/unofficial endpoint. It reads
// KOLSCAN_API_BASE (documented swap-in point: an operator who has arranged
// their own data source — an unofficial partnership, a self-hosted scraper,
// a future official API — can point this env var at it) but this file itself
// makes NO network call under any configuration; it always returns [] with
// status 'stub'.
//
// TODO(provider): if KOLScan ever publishes an official API, replace this
// stub's fetchCandidates body with a real fetch() against KOLSCAN_API_BASE,
// following the same fixture-tested-mapper pattern as solanaTracker.ts.
// Env vars: KOLSCAN_API_KEY (auth, already reserved in .env.example),
// KOLSCAN_API_BASE (operator-supplied base URL, new — see .env.example).

import type { Chain } from '@flowradar/core';
import type { CandidateSourceProvider, ExternalCandidate, FetchCandidatesOpts } from './types';

export interface KolscanEnv {
  KOLSCAN_API_KEY?: string;
  KOLSCAN_API_BASE?: string;
}

/**
 * Constructs the `kolscan` CandidateSourceProvider stub. Always returns a
 * working (non-null) provider regardless of env — KOLSCAN_API_KEY/
 * KOLSCAN_API_BASE are accepted (and readable via the returned object's
 * closure, for status-reporting callers) but never used to make a network
 * call; fetchCandidates always resolves to [].
 */
export function createKolscanCandidateSource(_env: KolscanEnv = {}): CandidateSourceProvider {
  return {
    name: 'kolscan',
    chains: ['SOLANA'],
    async fetchCandidates(_chain: Chain, _opts: FetchCandidatesOpts = {}): Promise<ExternalCandidate[]> {
      return [];
    }
  };
}
