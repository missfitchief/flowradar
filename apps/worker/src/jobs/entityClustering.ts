// FlowRadar — entityClustering job (Task 22 binding decision 5/6).
//
// Thin wrapper around @flowradar/db's runEntityClustering — the actual
// pair-derivation/scoring/clustering/persist logic lives there (same
// worker/seed-sharing pattern as apps/worker/src/jobs/flowScoring.ts's own
// runFlowScoringPass wrapper — see that file's header).
//
// Ordering (binding decision 6): runEntityClustering stamps
// WalletTokenTrade.entityClusterId for every newly-clustered wallet, but
// TokenFlowSnapshot's uniqueEntityCount is only ever recomputed by the
// flow-SCORING pass (aggregateWindow, via fetchAggregateInputs' own
// EntityClusterWallet read). So this job re-runs runFlowScoringPass
// immediately after clustering completes — otherwise the freshly-written
// cluster memberships would sit unused until the next independently
// scheduled flowScoring tick, and a manual/one-shot run (e.g. the seed
// script) would never see uniqueEntityCount diverge from smartWalletCount
// at all. Registered on settings.intervals.entityClusteringSec.
import { runEntityClustering, runFlowScoringPass } from '@flowradar/db';
import type { JobContext } from '../context';

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, providers, settings, log } = ctx;
  await runEntityClustering(prisma, settings, log);
  // Re-score immediately so uniqueEntityCount reflects the clusters just
  // written (see file header "Ordering").
  await runFlowScoringPass(prisma, settings, (chain) => providers(chain, 'risk'), log);
}
