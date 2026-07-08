// FlowRadar — externalConfluence job (Task D, External Confluence). Thin
// wrapper around @flowradar/db's runExternalConfluencePass — the internal
// LiquidityRisk + per-source external-fetch logic lives there (same
// worker/seed-sharing pattern as socialIngest.ts).
//
// SHADOW-ONLY (design doc global rules 1-16): this job only computes internal
// LiquidityRisk from existing market data and reads external provider data for
// tokens ALREADY IN THE DB, writing only TokenConfluenceSnapshot rows. It
// never creates a Token/Signal/Alert/CandidateWallet, never touches FlowScore,
// never trades, and (GMGN) stays strictly query-only — no trading/execution-
// capability endpoints of any kind are referenced (design rules 7/8).
//
// resolveProvider: in MOCK_MODE, EVERY ExternalConfluenceSource row resolves to
// the SAME shared MockConfluenceProvider (same "MOCK_MODE => one shared mock
// for ALL sources" decision as socialIngest.ts). Live mode (MOCK_MODE=false)
// maps each source by its `provider` string to its config-gated factory:
// holderscan => createHolderScanProvider (null when HOLDERSCAN_API_KEY absent),
// clobr => createClobrProvider (STUB), gmgn => createGmgnProvider (query-only
// STUB), ag_paper/manual/anything-else => null (no automated reader — AG Paper
// is manual/stub-only). A null return is a graceful per-source skip.

import { runExternalConfluencePass } from '@flowradar/db';
import {
  MockConfluenceProvider,
  createHolderScanProvider,
  createClobrProvider,
  createGmgnProvider,
  createAgPaperProvider
} from '@flowradar/providers';
import type { ConfluenceProvider } from '@flowradar/providers';
import type { JobContext } from '../context';

function isMockMode(): boolean {
  return process.env.MOCK_MODE !== 'false';
}

let sharedMockConfluenceProvider: ConfluenceProvider | null = null;

/** Lazily builds ONE shared MockConfluenceProvider for the life of this process (deterministic ok results for demo). */
function getSharedMockConfluenceProvider(): ConfluenceProvider {
  if (!sharedMockConfluenceProvider) {
    sharedMockConfluenceProvider = new MockConfluenceProvider();
  }
  return sharedMockConfluenceProvider;
}

// Live-adapter cache — construct each factory at most once per process, keyed
// by the source `provider` string (the live factory choice is provider-driven).
const liveConfluenceCache = new Map<string, ConfluenceProvider | null>();

/**
 * Live-mode (MOCK_MODE=false) provider resolution by ExternalConfluenceSource
 * .provider. Each maps to its config-gated factory in @flowradar/providers/
 * confluence — every factory returns `null` when its key is absent OR when it
 * is stub-only, a graceful per-source skip. env values are read via
 * process.env only to PASS them to the factory (never logged/stored).
 */
function resolveLiveConfluenceProvider(provider: string): ConfluenceProvider | null {
  if (liveConfluenceCache.has(provider)) {
    return liveConfluenceCache.get(provider) ?? null;
  }

  let resolved: ConfluenceProvider | null;
  switch (provider) {
    case 'holderscan':
      resolved = createHolderScanProvider({ HOLDERSCAN_API_KEY: process.env.HOLDERSCAN_API_KEY });
      break;
    case 'clobr':
      resolved = createClobrProvider({ CLOBR_API_KEY: process.env.CLOBR_API_KEY });
      break;
    case 'gmgn':
      resolved = createGmgnProvider({ GMGN_API_KEY: process.env.GMGN_API_KEY });
      break;
    case 'ag_paper':
      resolved = createAgPaperProvider();
      break;
    default:
      resolved = null;
  }

  liveConfluenceCache.set(provider, resolved);
  return resolved;
}

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  await runExternalConfluencePass(
    prisma,
    settings,
    (source) => {
      if (isMockMode()) {
        return getSharedMockConfluenceProvider();
      }
      return resolveLiveConfluenceProvider(source.provider);
    },
    log
  );
}
