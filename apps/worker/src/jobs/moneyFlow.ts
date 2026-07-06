// FlowRadar — moneyFlow job (Task 23 binding decision 4).
//
// Thin wrapper around @flowradar/db's runMoneyFlowRefresh — see that file's
// header for why this job is a documented no-op-safe stub (MoneyFlowEdge
// rows are already captured at ingest time by walletActivity's own
// ingestNormalizedTxs call; this job reports health-check counts rather than
// performing a separate write path). Registered on
// settings.intervals.moneyFlowSec.

import { runMoneyFlowRefresh } from '@flowradar/db';
import type { JobContext } from '../context';

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, log } = ctx;
  await runMoneyFlowRefresh(prisma, new Date(), 24, log);
}
