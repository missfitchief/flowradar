// FlowRadar — tokenRiskRefresh job (Task 1, Helius 429 fix).
//
// The ONE bounded job that proactively (re)fetches token risk from the real
// provider, keeping the canonical TokenRiskSnapshot cache warm so the scoring
// consumers (flowScoring, entityClustering) can read it instead of each
// calling Helius per-token per-pass. Bounded per run by
// settings.intervals.tokenRiskRefreshBatch — the hard cap on Helius risk calls
// per cycle regardless of universe size. Pending work is persisted in the
// snapshot rows (nextRefreshAt), so a restart resumes it; nothing is queued in
// memory. Registered on settings.intervals.tokenRiskRefreshSec.

import { runTokenRiskRefresh } from '@flowradar/db';
import type { JobContext } from '../context';
import { buildRiskCache } from '../risk';

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  const cache = buildRiskCache(ctx);
  const metrics = await runTokenRiskRefresh(cache, prisma, {
    limit: settings.intervals.tokenRiskRefreshBatch
  });
  log.info('tokenRiskRefresh cycle complete', { ...metrics });
}
