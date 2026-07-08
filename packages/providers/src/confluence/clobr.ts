// FlowRadar — CLOBr liquidity-map provider (design doc §Module C). STUB-ONLY:
// no confirmed public API + docs exist (design doc Open Decision 2), so this
// adapter is a typed stub that makes NO network call and never scrapes
// private/gated/browser-only content. Unlike the key-gated holderscan factory,
// a liquidity-map stub still REGISTERS (returns non-null) so the source appears
// honestly as 'stub' in the panel; a present CLOBR_API_KEY does NOT make an
// unverified endpoint real. fetchForToken always resolves status 'stub' and
// NEVER 'ok'/'safe' (constraint 15). NO hallucinated endpoint.
//
// TODO(provider): if CLOBr publishes a confirmed public order-book/depth API,
// replace the stub body with a fetch() mapping depth/support/resistance buckets
// into dataJson (all provider-claimed); endpoint down => 'unavailable',
// 401/403 => 'plan_required', 429 => 'rate_limited'.
import type { Chain } from '@flowradar/core';
import type { ConfluenceFetchResult, ConfluenceProvider } from './types';

export interface ClobrEnv {
  CLOBR_API_KEY?: string;
}

export function createClobrProvider(_env: ClobrEnv): ConfluenceProvider | null {
  return {
    name: 'clobr',
    provider: 'clobr',
    snapshotType: 'liquidity_map',
    chains: ['SOLANA'],
    async fetchForToken(_chain: Chain, _tokenAddress: string): Promise<ConfluenceFetchResult> {
      return {
        status: 'stub',
        dataJson: {
          providerClaimed: false,
          note: 'CLOBr has no confirmed public API — typed stub, no liquidity map fetched. See file header TODO(provider). Not integrated is NOT a safe signal.'
        },
        observedAt: new Date(0)
      };
    }
  };
}
