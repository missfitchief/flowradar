// FlowRadar — duneQuery job (Task 37, Wave 4.6). Thin wrapper around
// @flowradar/db's runDuneQuerySync — refreshes every ENABLED DuneQuerySource
// row credit-safely (same worker/seed-sharing pattern as every other job in
// this directory — see apps/worker/src/jobs/externalWalletSource.ts's
// header, which this file mirrors).
//
// resolveClient: in MOCK_MODE, every call resolves to the SAME shared
// MockDuneClient (createMockDuneClient wrapping this process's own
// MockWorld — same genesis/horizon convention as
// externalWalletSource.ts's getSharedMockCandidateSource). Live mode
// (MOCK_MODE=false): createDuneClient(env) — returns null when
// DUNE_API_KEY is absent, a graceful per-cycle no-op (runDuneQuerySync treats
// a null resolver return the same as "no client available" for every
// enabled row, never a crash).
//
// CREDIT SAFETY: this job (and runDuneQuerySync) never overrides
// useLatestCached — createDuneClient's own env-derived default applies
// (DUNE_USE_LATEST_RESULT, default true), so a scheduled duneQuery cycle
// NEVER executes a fresh (credit-consuming) query unless the operator has
// separately set DUNE_EXECUTE_FRESH=true.

import { runDuneQuerySync } from '@flowradar/db';
import { createDuneClient, createMockDuneClient, createMockWorld } from '@flowradar/providers';
import type { DuneClient } from '@flowradar/providers';
import type { JobContext } from '../context';

const HOUR_MS = 60 * 60 * 1000;
const WORLD_HORIZON_HOURS = 72;

function isMockMode(): boolean {
  return process.env.MOCK_MODE !== 'false';
}

let sharedMockDuneClient: DuneClient | null = null;

/** Lazily builds ONE shared mock DuneClient for the life of this process — same genesis convention as externalWalletSource.ts's getSharedMockCandidateSource. */
function getSharedMockDuneClient(): DuneClient {
  if (!sharedMockDuneClient) {
    const genesis = new Date(Date.now() - WORLD_HORIZON_HOURS * HOUR_MS);
    const world = createMockWorld({ genesis });
    sharedMockDuneClient = createMockDuneClient(world);
  }
  return sharedMockDuneClient;
}

let liveDuneClientCache: DuneClient | null | undefined;

/** Live-mode client resolution (Task 37) — constructed at most once per process, reused on every subsequent call (same rationale as registry.ts's liveProviderCache). Returns null when DUNE_API_KEY is absent (missing_key, graceful skip). */
function resolveLiveDuneClient(): DuneClient | null {
  if (liveDuneClientCache !== undefined) return liveDuneClientCache;
  liveDuneClientCache = createDuneClient({
    DUNE_API_KEY: process.env.DUNE_API_KEY,
    DUNE_USE_LATEST_RESULT: process.env.DUNE_USE_LATEST_RESULT,
    DUNE_EXECUTE_FRESH: process.env.DUNE_EXECUTE_FRESH
  });
  return liveDuneClientCache;
}

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  await runDuneQuerySync(
    prisma,
    settings,
    () => (isMockMode() ? getSharedMockDuneClient() : resolveLiveDuneClient()),
    log
  );
}
