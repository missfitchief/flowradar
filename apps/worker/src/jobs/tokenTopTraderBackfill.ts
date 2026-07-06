// FlowRadar — tokenTopTraderBackfill job (Task 35, Wave 4.5, Spec §5b). Thin
// wrapper around @flowradar/db's runTokenTopTraderBackfill — the actual
// mcap-expansion check / candidate upsert logic lives there (same
// worker/seed-sharing pattern as apps/worker/src/jobs/externalWalletSource.ts's
// header, which this file mirrors almost exactly).
//
// resolveProvider: in MOCK_MODE, every chain resolves to the SAME shared
// MockTokenTopTradersProvider instance, built once against this process's
// own MockWorld (same genesis/horizon convention as externalWalletSource.ts's
// getSharedMockCandidateSource). Live mode (MOCK_MODE=false): no live Birdeye
// top-traders adapter exists yet, so the resolver returns null for every
// chain — runTokenTopTraderBackfill treats that as a graceful per-token
// no-op, never a crash.
//
// Registered on a daily-ish interval per Task 35 binding decision 3
// ("Register at a daily-ish interval") — reuses settings.connectors.syncHours
// * 4 (24h when syncHours is the default 6h) rather than introducing a new
// settings field, since this pass is meant to run far less often than the
// candidate sync/validation passes (mcap expansion is a slower-moving
// signal than "did a new candidate appear").

import { runTokenTopTraderBackfill } from '@flowradar/db';
import { MockTokenTopTradersProvider, createMockWorld } from '@flowradar/providers';
import type { TokenTopTradersProvider } from '@flowradar/providers';
import type { JobContext } from '../context';

const HOUR_MS = 60 * 60 * 1000;
const WORLD_HORIZON_HOURS = 72;

function isMockMode(): boolean {
  return process.env.MOCK_MODE !== 'false';
}

let sharedMockTopTradersProvider: TokenTopTradersProvider | null = null;

/** Lazily builds ONE shared MockTokenTopTradersProvider for the life of this process — same genesis convention as externalWalletSource.ts's getSharedMockCandidateSource. */
function getSharedMockTopTradersProvider(): TokenTopTradersProvider {
  if (!sharedMockTopTradersProvider) {
    const genesis = new Date(Date.now() - WORLD_HORIZON_HOURS * HOUR_MS);
    const world = createMockWorld({ genesis });
    sharedMockTopTradersProvider = new MockTokenTopTradersProvider(world);
  }
  return sharedMockTopTradersProvider;
}

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  await runTokenTopTraderBackfill(
    prisma,
    settings,
    () => {
      if (isMockMode()) {
        return getSharedMockTopTradersProvider();
      }
      // Live Birdeye top-traders adapter lands in a later task — every chain
      // is a graceful no-op (not a crash) until then.
      return null;
    },
    log
  );
}
