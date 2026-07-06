// FlowRadar — walletStatsRefresh job (plan Task 30 binding decision 1).
//
// Thin wrapper around @flowradar/db's runWalletStatsRefresh — the actual
// per-token FIFO computation / aggregation / CSV-skip logic lives there (same
// worker/seed-sharing pattern as apps/worker/src/jobs/flowScoring.ts's own
// runFlowScoringPass wrapper — see that file's header). Registered on
// settings.intervals.walletStatsRefreshHours (converted hours -> ms by
// apps/worker/src/index.ts, same treatment as intervals.backtestHours).

import { runWalletStatsRefresh } from '@flowradar/db';
import type { JobContext } from '../context';

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, log } = ctx;
  await runWalletStatsRefresh(prisma, log);
}
