// FlowRadar — externalWalletSource job (Task 34, Wave 4.5, Spec §5b). Thin
// wrapper around @flowradar/db's runExternalWalletSourceSync — the actual
// per-source provider resolution / candidate upsert logic lives there (same
// worker/seed-sharing pattern as every other job in this directory — see
// apps/worker/src/jobs/walletDiscovery.ts's header).
//
// resolveSource: in MOCK_MODE (the only mode this task wires up — live
// per-source adapters are Task 36), EVERY ExternalWalletSource row resolves
// to the SAME shared MockCandidateSource instance (Task 34 binding decision
// 3: "MOCK_MODE ⇒ MockCandidateSource for ALL sources"), built once against
// the worker's shared MockWorld (ctx.providers is a plain function resolver
// with no way to hand back a world instance, so this job builds its own
// MockCandidateSource lazily from a fresh MockWorld — deterministic given the
// same seed/genesis, matching every other mock-mode code path in this repo).
// Live mode (MOCK_MODE=false): no per-source live adapters exist yet, so the
// resolver returns null for every source — runExternalWalletSourceSync treats
// that as a graceful per-source no-op, never a crash.

import { runExternalWalletSourceSync } from '@flowradar/db';
import { MockCandidateSource, createMockWorld } from '@flowradar/providers';
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

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  await runExternalWalletSourceSync(
    prisma,
    settings,
    () => {
      if (isMockMode()) {
        return getSharedMockCandidateSource();
      }
      // Live per-source adapters land in Task 36 — every source is a
      // graceful no-op (not a crash) until then.
      return null;
    },
    log
  );
}
