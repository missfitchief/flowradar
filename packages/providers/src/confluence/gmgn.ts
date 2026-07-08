// FlowRadar — GMGN query-only external-intel provider (design doc §Module D).
// QUERY-ONLY and optional. This adapter reads discovery/labels/holders context
// only and performs no action beyond a read. It references NONE of the
// forbidden capability endpoints (enforced by test/gmgnQueryOnlyGuard.test.ts,
// which greps this file for those capability substrings and asserts zero hits).
//
// No verified public GMGN API/docs exist (a direct fetch this session returned
// 403; see candidates/gmgnStub.ts's doc-verification note), so this is a typed
// STUB: fetchForToken makes NO network call and resolves status 'stub'. A
// present GMGN_API_KEY does NOT make an unverified endpoint real. It NEVER
// returns 'ok'/'safe'. NO hallucinated endpoint.
//
// TODO(provider): if GMGN ever publishes an official QUERY-ONLY intel API,
// replace the stub body with a fetch() mapping trending/labels/holders context
// into dataJson — every field explicitly providerClaimed:true (never asserted
// as fact). Do NOT add any capability beyond read-only queries.
import type { Chain } from '@flowradar/core';
import type { ConfluenceFetchResult, ConfluenceProvider } from './types';

export interface GmgnConfluenceEnv {
  GMGN_API_KEY?: string;
}

export function createGmgnProvider(_env: GmgnConfluenceEnv): ConfluenceProvider | null {
  return {
    name: 'gmgn',
    provider: 'gmgn',
    snapshotType: 'external_intel',
    chains: ['SOLANA'],
    async fetchForToken(_chain: Chain, _tokenAddress: string): Promise<ConfluenceFetchResult> {
      return {
        status: 'stub',
        dataJson: {
          providerClaimed: true,
          note: 'GMGN has no verified public query API — typed query-only stub, no intel fetched. Labels/discovery would be provider-claimed, never fact. Not integrated is NOT a safe signal.'
        },
        observedAt: new Date(0)
      };
    }
  };
}
