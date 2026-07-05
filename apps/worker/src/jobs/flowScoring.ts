// FlowRadar — flowScoring job (Task 5 brief decision 3).
//
// Thin wrapper around @flowradar/db's runFlowScoringPass — the actual
// per-token aggregate/risk/score/persist logic lives there (moved in Task 6
// so packages/db/src/seed.ts can call the identical code path rather than
// duplicating it; see packages/db/src/scoring-pass.ts's file header for the
// full history, including the aggregate-window-anchor bug found and fixed
// during this job's original Task 5 verification).

import { runFlowScoringPass } from '@flowradar/db';
import type { JobContext } from '../context.js';

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, providers, settings, log } = ctx;
  await runFlowScoringPass(prisma, settings, (chain) => providers(chain, 'risk'), log);
}
