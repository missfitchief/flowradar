// FlowRadar — signalDetection job (Task 15 binding decision 3).
//
// Thin wrapper around @flowradar/db's runSignalDetectionPass — the actual
// per-token aggregate/rule-evaluation/dedupe/persist logic lives there (same
// worker/seed-sharing pattern as apps/worker/src/jobs/flowScoring.ts's own
// runFlowScoringPass wrapper — see that file's header). Registered on
// settings.intervals.signalDetectionSec (apps/worker/src/index.ts).

import { runSignalDetectionPass } from '@flowradar/db';
import type { JobContext } from '../context';

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  await runSignalDetectionPass(prisma, settings, log);
}
