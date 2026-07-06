// FlowRadar — getCandidateSourceStatuses: reports the effective mode for each
// of the 6 seeded ExternalWalletSource names (Task 36, Wave 4.5, Spec §5b),
// plus one `dune` row (Task 37, Wave 4.6). Analogous to registry.ts's
// getProviderStatuses — used by the Source Health page
// (apps/web/app/sources/page.tsx) and by ops/debugging. Never echoes secret
// values, only whether the required env key is present.
//
// Mode per source, in MOCK_MODE (default):
//   ALL 6 ExternalWalletSource-backed sources report mode='mock' (every
//   ExternalWalletSource name resolves to the shared MockCandidateSource —
//   Task 34 binding decision 3), same "MOCK_MODE is the one switch"
//   convention getProviderStatuses uses. The `dune` row ALSO reports 'mock'
//   in MOCK_MODE — MockDuneOverlapSource stands in regardless of
//   DUNE_API_KEY, same convention.
//
// Mode per source, live (MOCK_MODE=false):
//   - solana_tracker_pnl / birdeye_wallet_pnl / birdeye_top_traders: 'live'
//     when their key env var is present, else 'missing_key' (docs-verified
//     adapters, key-gated — see solanaTracker.ts/birdeyeCandidates.ts).
//   - kolscan / gmgn_smart_money / cielo: always 'stub' (typed stubs, no
//     verified endpoint exists yet — see kolscanStub.ts/gmgnStub.ts/cielo.ts)
//     regardless of whether their key env var happens to be set, since a key
//     alone doesn't make an unverified endpoint real.
//   - dune: 'live' when DUNE_API_KEY is present, else 'missing_key'
//     (docs-verified Query Execution API client — see dune/client.ts).

import type { ProviderStatus } from '@flowradar/core';

export interface CandidateSourceStatusRow extends ProviderStatus {
  /** The ExternalWalletSource.name this status row describes (matches the seeded row's unique name). */
  sourceName: string;
}

interface SourceStatusSpec {
  sourceName: string;
  displayName: string;
  chains: ('SOLANA' | 'BSC')[];
  keyEnvVar: string;
  /** Docs-verified adapters resolve 'live'/'missing_key' by key presence; stub-only sources always report 'stub'. */
  hasLiveAdapter: boolean;
}

const SOURCE_SPECS: SourceStatusSpec[] = [
  {
    sourceName: 'solana_tracker_pnl',
    displayName: 'Solana Tracker',
    chains: ['SOLANA'],
    keyEnvVar: 'SOLANA_TRACKER_API_KEY',
    hasLiveAdapter: true
  },
  {
    sourceName: 'birdeye_wallet_pnl',
    displayName: 'Birdeye',
    chains: ['SOLANA', 'BSC'],
    keyEnvVar: 'BIRDEYE_API_KEY',
    hasLiveAdapter: true
  },
  {
    sourceName: 'birdeye_top_traders',
    displayName: 'Birdeye',
    chains: ['SOLANA', 'BSC'],
    keyEnvVar: 'BIRDEYE_API_KEY',
    hasLiveAdapter: true
  },
  {
    sourceName: 'kolscan',
    displayName: 'KOLScan (stub)',
    chains: ['SOLANA'],
    keyEnvVar: 'KOLSCAN_API_KEY',
    hasLiveAdapter: false
  },
  {
    sourceName: 'gmgn_smart_money',
    displayName: 'GMGN (stub)',
    chains: ['SOLANA', 'BSC'],
    keyEnvVar: 'GMGN_API_KEY',
    hasLiveAdapter: false
  },
  {
    sourceName: 'cielo',
    displayName: 'Cielo (stub)',
    chains: ['SOLANA', 'BSC'],
    keyEnvVar: 'CIELO_API_KEY',
    hasLiveAdapter: false
  },
  {
    sourceName: 'dune',
    displayName: 'Dune',
    chains: ['SOLANA', 'BSC'],
    keyEnvVar: 'DUNE_API_KEY',
    hasLiveAdapter: true
  }
];

function isMockMode(): boolean {
  return process.env.MOCK_MODE !== 'false';
}

/**
 * Reports the effective mode for every one of the 6 seeded ExternalWalletSource
 * names — one row per (source, chain) pair, same shape convention as
 * getProviderStatuses (mode: 'live'|'mock'|'missing_key'|'stub'). Never makes
 * a network call.
 */
export function getCandidateSourceStatuses(): CandidateSourceStatusRow[] {
  const mockMode = isMockMode();
  const statuses: CandidateSourceStatusRow[] = [];

  for (const spec of SOURCE_SPECS) {
    for (const chain of spec.chains) {
      if (mockMode) {
        statuses.push({
          sourceName: spec.sourceName,
          name: 'MockCandidateSource',
          chain,
          capability: 'candidateSource',
          mode: 'mock',
          note: 'MOCK_MODE active — serving the deterministic mock leaderboard.'
        });
        continue;
      }

      if (!spec.hasLiveAdapter) {
        statuses.push({
          sourceName: spec.sourceName,
          name: spec.displayName,
          chain,
          capability: 'candidateSource',
          mode: 'stub',
          note: 'No verified public API found — typed stub, returns no candidates. See file header TODO(provider).'
        });
        continue;
      }

      const hasKey = Boolean(process.env[spec.keyEnvVar]);
      statuses.push({
        sourceName: spec.sourceName,
        name: spec.displayName,
        chain,
        capability: 'candidateSource',
        mode: hasKey ? 'live' : 'missing_key',
        note: hasKey
          ? 'Live adapter active (docs-verified endpoint).'
          : `Missing ${spec.keyEnvVar}; fetchCandidates returns [] gracefully.`
      });
    }
  }

  return statuses;
}
