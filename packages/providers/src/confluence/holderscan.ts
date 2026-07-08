// FlowRadar — HolderScan HolderRisk provider (design doc §Module A). OPTIONAL
// and likely PAID/plan-gated — the build must NOT depend on it. Config-gated:
// returns null when HOLDERSCAN_API_KEY is absent (graceful missing-key skip,
// mirrors createTelegramSocialSource's null contract). When keyed it is a
// DOCUMENTED STUB: there is no verified public endpoint wired here, so
// fetchForToken resolves to status 'plan_required' (a key alone does not make
// an unverified paid integration real) and makes NO network call. It NEVER
// returns 'ok' and NEVER infers a 'safe'/'clean' verdict from absence
// (constraint 15). NO hallucinated endpoint.
//
// TODO(provider): once a real HolderScan plan + docs exist, replace the stub
// body with a fetch() against the documented base URL, mapping the plan's
// holder-delta/concentration fields into dataJson (all provider-claimed);
// 401/403/402/quota => 'plan_required', 429 => 'rate_limited', endpoint down
// => 'unavailable', malformed => fields marked unknown. Never infer 'safe'.
import type { Chain } from '@flowradar/core';
import type { ConfluenceFetchResult, ConfluenceProvider } from './types';

export interface HolderScanEnv {
  HOLDERSCAN_API_KEY?: string;
}

export function createHolderScanProvider(env: HolderScanEnv): ConfluenceProvider | null {
  if (!env.HOLDERSCAN_API_KEY) return null; // missing key => graceful skip (source marked missing_key)
  return {
    name: 'holderscan',
    provider: 'holderscan',
    snapshotType: 'holder_risk',
    chains: ['SOLANA'],
    async fetchForToken(_chain: Chain, _tokenAddress: string): Promise<ConfluenceFetchResult> {
      // Documented stub: no verified endpoint wired. A present key does not make
      // an unverified paid plan real, so we report plan_required honestly and
      // never fabricate data or a safe verdict.
      return {
        status: 'plan_required',
        dataJson: {
          providerClaimed: false,
          note: 'HolderScan plan/integration not verified — no data fetched. See file header TODO(provider). Absence of data is NOT a safe signal.'
        },
        observedAt: new Date(0)
      };
    }
  };
}
