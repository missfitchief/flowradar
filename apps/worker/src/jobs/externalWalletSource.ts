// FlowRadar — externalWalletSource job (Task 34, Wave 4.5, Spec §5b). Thin
// wrapper around @flowradar/db's runExternalWalletSourceSync — the actual
// per-source provider resolution / candidate upsert logic lives there (same
// worker/seed-sharing pattern as every other job in this directory — see
// apps/worker/src/jobs/walletDiscovery.ts's header).
//
// resolveSource: in MOCK_MODE, EVERY ExternalWalletSource row resolves to the
// SAME shared MockCandidateSource instance (Task 34 binding decision 3:
// "MOCK_MODE ⇒ MockCandidateSource for ALL sources"), built once against the
// worker's shared MockWorld (ctx.providers is a plain function resolver with
// no way to hand back a world instance, so this job builds its own
// MockCandidateSource lazily from a fresh MockWorld — deterministic given the
// same seed/genesis, matching every other mock-mode code path in this repo).
//
// Live mode (MOCK_MODE=false, Task 36): each ExternalWalletSource.name maps to
// its own live-or-stub adapter factory (see packages/providers/src/candidates/
// {solanaTracker,birdeyeCandidates,cielo,kolscanStub,gmgnStub}.ts for the
// docs-verified-vs-stub rationale per source). Every factory either returns a
// working provider (self-reporting missing_key/stub via
// getCandidateSourceStatuses, but NEVER throwing or crashing from
// fetchCandidates itself — missing keys just mean fetchCandidates resolves to
// []) or, for the two key-gated docs-verified adapters, `null` when their key
// env var is absent — resolveSource treats a null return the same as "no
// provider resolved", which runExternalWalletSourceSync already handles as a
// graceful per-source skip (never a crash for any other enabled source).

import { runExternalWalletSourceSync } from '@flowradar/db';
import {
  MockCandidateSource,
  createMockWorld,
  createSolanaTrackerCandidateSource,
  createBirdeyeWalletPnlCandidateSource,
  createBirdeyeTopTradersCandidateSource,
  createCieloCandidateSource,
  createKolscanCandidateSource,
  createGmgnCandidateSource
} from '@flowradar/providers';
import type { CandidateSourceProvider } from '@flowradar/providers';
import type { JobContext } from '../context';

const HOUR_MS = 60 * 60 * 1000;
const WORLD_HORIZON_HOURS = 72;

function isMockMode(): boolean {
  return process.env.MOCK_MODE !== 'false';
}

let sharedMockCandidateSource: CandidateSourceProvider | null = null;

/** Lazily builds ONE shared MockCandidateSource for the life of this process — same genesis convention as registry.ts's getSharedMockWorld. */
function getSharedMockCandidateSource(): CandidateSourceProvider {
  if (!sharedMockCandidateSource) {
    const genesis = new Date(Date.now() - WORLD_HORIZON_HOURS * HOUR_MS);
    const world = createMockWorld({ genesis });
    sharedMockCandidateSource = new MockCandidateSource(world);
  }
  return sharedMockCandidateSource;
}

// Live-adapter cache (Task 36) — same "construct the factory at most once per
// process, reuse the returned instance (and its single internal rate
// limiter) on every subsequent call" rationale as registry.ts's
// liveProviderCache. Cleared only by process restart; no test in this repo
// flips MOCK_MODE/env mid-process for this job the way registry.test.ts does
// for getProvider, so no exported reset hook is needed here.
const liveCandidateSourceCache = new Map<string, CandidateSourceProvider | null>();

/**
 * Live-mode (MOCK_MODE=false) source resolution by ExternalWalletSource.name
 * (Task 36). Each name maps to its own factory in @flowradar/providers/
 * candidates — key-gated docs-verified adapters (solana_tracker_pnl,
 * birdeye_wallet_pnl, birdeye_top_traders) return `null` when their key env
 * var is absent (treated as "no provider resolved", a graceful per-source
 * skip); the three stub factories (kolscan, gmgn_smart_money, cielo) always
 * return a working provider whose fetchCandidates resolves to [] (see each
 * file's header for the docs-verified-or-stub rationale). Unrecognized
 * source names (e.g. a future admin-added row) resolve to null, same
 * graceful-skip treatment.
 */
function resolveLiveCandidateSource(sourceName: string): CandidateSourceProvider | null {
  if (liveCandidateSourceCache.has(sourceName)) {
    return liveCandidateSourceCache.get(sourceName) ?? null;
  }

  let resolved: CandidateSourceProvider | null;
  switch (sourceName) {
    case 'solana_tracker_pnl':
      resolved = createSolanaTrackerCandidateSource({ SOLANA_TRACKER_API_KEY: process.env.SOLANA_TRACKER_API_KEY });
      break;
    case 'birdeye_wallet_pnl':
      resolved = createBirdeyeWalletPnlCandidateSource({ BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY });
      break;
    case 'birdeye_top_traders':
      resolved = createBirdeyeTopTradersCandidateSource({ BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY });
      break;
    case 'cielo':
      resolved = createCieloCandidateSource({ CIELO_API_KEY: process.env.CIELO_API_KEY });
      break;
    case 'kolscan':
      resolved = createKolscanCandidateSource({
        KOLSCAN_API_KEY: process.env.KOLSCAN_API_KEY,
        KOLSCAN_API_BASE: process.env.KOLSCAN_API_BASE
      });
      break;
    case 'gmgn_smart_money':
      resolved = createGmgnCandidateSource({
        GMGN_API_KEY: process.env.GMGN_API_KEY,
        GMGN_API_BASE: process.env.GMGN_API_BASE
      });
      break;
    default:
      resolved = null;
  }

  liveCandidateSourceCache.set(sourceName, resolved);
  return resolved;
}

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  await runExternalWalletSourceSync(
    prisma,
    settings,
    (source) => {
      if (isMockMode()) {
        return getSharedMockCandidateSource();
      }
      return resolveLiveCandidateSource(source.name);
    },
    log
  );
}
