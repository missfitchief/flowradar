// FlowRadar — flowScoring job (Task 5 brief decision 3).
//
// Thin wrapper around @flowradar/db's runFlowScoringPass — the actual
// per-token aggregate/risk/score/persist logic lives there (moved in Task 6
// so packages/db/src/seed.ts can call the identical code path rather than
// duplicating it; see packages/db/src/scoring-pass.ts's file header for the
// full history, including the aggregate-window-anchor bug found and fixed
// during this job's original Task 5 verification).

import { runFlowScoringPass, warmingRiskResolver } from '@flowradar/db';
import type { JobContext } from '../context';
import { buildRiskCache } from '../risk';

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  // Task 1 (Helius 429 fix): score off the cached risk layer. The warming
  // resolver serves fresh/stale cached penalties verbatim (FlowScore
  // unchanged) and inline-fetches (deduped) only for a genuinely new token —
  // eliminating the per-token-per-pass Helius burst without changing scores.
  const riskCache = buildRiskCache(ctx);
  await runFlowScoringPass(prisma, settings, warmingRiskResolver(riskCache), log);
}
