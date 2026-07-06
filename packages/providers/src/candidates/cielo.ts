// FlowRadar — Cielo typed stub CandidateSourceProvider (Task 36, Wave 4.5,
// Spec §5b). Optional PnL-tracker candidate feeder (`cielo` source name).
//
// -----------------------------------------------------------------------
// DOC VERIFICATION (WebFetch'd this session, 2026-07-06) — NO PUBLIC API
// REFERENCE FOUND
// -----------------------------------------------------------------------
// https://docs.cielo.finance (sitemap + llms-full.txt + several guessed
// /reference and /api-reference paths) lists an in-APP "Settings > API"
// section ("Integrate the Cielo API and manage your key. Monitor your daily
// API usage and keep track of credits used") but publishes NO discoverable
// REST API reference page: no base URL, no endpoint list, no auth header
// name, no response shapes. Every /reference/* and /api-reference/* guess
// 404'd back to the docs site's generic "ask the docs" landing page. Cielo's
// PnL leaderboard feature itself is documented only as an in-app web feature
// (https://docs.cielo.finance/wallet-tracking/my-wallets/pnl-leaderboard.md),
// not as a programmatic endpoint.
//
// Per the standing rule ("implement ONLY docs-verified; unclear => typed
// stub + TODO(provider) + doc URL"), this ships as a typed stub: it never
// makes a network call and always returns []. CIELO_API_KEY is still read
// (so getCandidateSourceStatuses can report 'missing_key' vs 'stub'
// correctly, mirroring the KOLScan/GMGN stubs' own key-presence-only
// reporting) but its value never gates the stub's behavior — even with a key
// present, this remains a stub until a real API reference is found and
// verified.
//
// TODO(provider): re-verify at https://docs.cielo.finance/sitemap.md — if a
// public REST reference page appears there in the future (e.g. under a
// "Developers" or "API Reference" section), wire a real adapter following
// the same fixture-tested-mapper pattern as solanaTracker.ts/
// birdeyeCandidates.ts. Env var: CIELO_API_KEY (already reserved in
// .env.example).

import type { Chain } from '@flowradar/core';
import type { CandidateSourceProvider, ExternalCandidate, FetchCandidatesOpts } from './types';

export interface CieloEnv {
  CIELO_API_KEY?: string;
}

/**
 * Constructs the `cielo` CandidateSourceProvider stub. Always returns a
 * working (non-null) provider object regardless of whether CIELO_API_KEY is
 * set — unlike the key-gated live adapters in this directory, there is no
 * live behavior to gate on a key for, since no verified endpoint exists yet.
 * fetchCandidates makes no network call and always resolves to [].
 */
export function createCieloCandidateSource(_env: CieloEnv = {}): CandidateSourceProvider {
  return {
    name: 'cielo',
    chains: ['SOLANA', 'BSC'],
    async fetchCandidates(_chain: Chain, _opts: FetchCandidatesOpts = {}): Promise<ExternalCandidate[]> {
      return [];
    }
  };
}
