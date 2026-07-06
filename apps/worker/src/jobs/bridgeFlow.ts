// FlowRadar — bridgeFlow job (Task 23 binding decision 4).
//
// Thin wrapper around @flowradar/db's runBridgeFlow — matches
// bridge_deposit<->bridge_withdrawal MoneyFlowEdge pairs (asset+amount
// 95-105%+time<60m+protocol) and annotates confidence/metadata on each leg.
// Registered on settings.intervals.bridgeFlowSec.

import { runBridgeFlow } from '@flowradar/db';
import type { JobContext } from '../context';

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, log } = ctx;
  await runBridgeFlow(prisma, new Date(), 24, log);
}
