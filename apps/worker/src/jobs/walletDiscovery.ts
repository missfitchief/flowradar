// FlowRadar — walletDiscovery job (plan Task 30 binding decision 2).
//
// Thin wrapper around @flowradar/db's runWalletDiscovery — the actual
// per-chain provider resolution / candidate upsert logic lives there (same
// worker/seed-sharing pattern as every other job in this directory — see
// apps/worker/src/jobs/flowScoring.ts's header). Registered on
// settings.intervals.walletDiscoveryHours (converted hours -> ms by
// apps/worker/src/index.ts, same treatment as intervals.backtestHours).
//
// The getProviderFn passed to runWalletDiscovery wraps ctx.providers in a
// try/catch: in live mode, @flowradar/providers's getProvider THROWS for any
// (chain, capability) pair with no implemented live adapter yet (see
// registry.ts's getProvider — walletDiscovery has no live adapter branch on
// either chain today), rather than returning a sentinel. Catching that here
// and returning null lets runWalletDiscovery's own "no provider" no-op path
// handle both "resolver returned null" and "resolver threw" the same way,
// so this job never crashes past its own boundary either way (belt-and-
// suspenders with runWalletDiscovery's internal try/catch per chain).

import { runWalletDiscovery } from '@flowradar/db';
import type { JobContext } from '../context';

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, providers, log } = ctx;
  await runWalletDiscovery(
    prisma,
    settings,
    (chain) => {
      try {
        return providers(chain, 'walletDiscovery');
      } catch {
        return null;
      }
    },
    log
  );
}
