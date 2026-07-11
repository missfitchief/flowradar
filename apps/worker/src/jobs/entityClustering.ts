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
import { runEntityClustering, runFlowScoringPass, cachedRiskResolver } from '@flowradar/db';
import type { JobContext, JobLogger } from '../context';
import { buildRiskCache } from '../risk';

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  const clusteringResult = await runEntityClustering(prisma, settings, log);
  // Re-score immediately so uniqueEntityCount reflects the clusters just
  // written (see file header "Ordering"). runFlowScoringPass emits its own
  // "flowScoring cycle complete" line; wrap the logger so that sub-call is
  // clearly attributed as part of THIS entityClustering tick rather than
  // masquerading as an independent flowScoring cycle in the worker output.
  const subLog: JobLogger = {
    info: (message, meta) => log.info(`entityClustering→${message}`, meta),
    error: (message, meta) => log.error(`entityClustering→${message}`, meta),
  };
  // Task 1: re-score off the cached risk layer as a PURE read (no inline
  // fetch). flowScoring already warms the shared TokenRiskSnapshot cache each
  // cycle, and the bounded tokenRiskRefresh job keeps it fresh — so this
  // re-score issues ZERO Helius risk calls (the double-pass burst is gone).
  const riskCache = buildRiskCache(ctx);
  const scoringResult = await runFlowScoringPass(
    prisma,
    settings,
    cachedRiskResolver(riskCache),
    subLog,
  );
  // The entityClustering job's OWN cycle-complete line, labelled as itself so a
  // WORKER_FAST run shows entityClustering reporting under its own name.
  log.info('entityClustering cycle complete', {
    walletsClustered: clusteringResult.walletsClustered,
    clustersCreated: clusteringResult.clustersCreated,
    rescoredTokens: scoringResult.scored,
  });
}
