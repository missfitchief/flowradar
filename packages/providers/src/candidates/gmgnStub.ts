// FlowRadar — GMGN typed stub CandidateSourceProvider (Task 36, Wave 4.5,
// Spec §5b). Smart-money candidate + cross-check feeder, no hardcoded
// unofficial endpoints (`gmgn_smart_money` source name).
//
// -----------------------------------------------------------------------
// DOC VERIFICATION — NO OFFICIAL PUBLIC API
// -----------------------------------------------------------------------
// GMGN (gmgn.ai) publishes a web trading terminal / smart-money UI with no
// discovered official public API or developer docs (a direct fetch this
// session returned 403). Per the standing rule and Spec §5b's own wording
// ("GMGN smart-money ... no hardcoded unofficial endpoints; configurable
// base URL, stub unless documented access"), this adapter never hardcodes
// any unofficial endpoint. It reads GMGN_API_BASE (documented swap-in point,
// same convention as kolscanStub.ts's KOLSCAN_API_BASE) but makes NO network
// call under any configuration; it always returns [] with status 'stub'.
//
// TODO(provider): if GMGN ever publishes an official API, replace this
// stub's fetchCandidates body with a real fetch() against GMGN_API_BASE,
// following the same fixture-tested-mapper pattern as solanaTracker.ts.
// Env vars: GMGN_API_KEY (auth, already reserved in .env.example),
// GMGN_API_BASE (operator-supplied base URL, new — see .env.example).

import type { Chain } from '@flowradar/core';
import type { CandidateSourceProvider, ExternalCandidate, FetchCandidatesOpts } from './types';

export interface GmgnEnv {
  GMGN_API_KEY?: string;
  GMGN_API_BASE?: string;
}

/**
 * Constructs the `gmgn_smart_money` CandidateSourceProvider stub. Always
 * returns a working (non-null) provider regardless of env; fetchCandidates
 * always resolves to [], no network call made.
 */
export function createGmgnCandidateSource(_env: GmgnEnv = {}): CandidateSourceProvider {
  return {
    name: 'gmgn_smart_money',
    chains: ['SOLANA', 'BSC'],
    async fetchCandidates(_chain: Chain, _opts: FetchCandidatesOpts = {}): Promise<ExternalCandidate[]> {
      return [];
    }
  };
}
