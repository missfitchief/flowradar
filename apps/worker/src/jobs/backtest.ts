// FlowRadar — backtest job (Task 40 binding decision 3).
//
// Thin wrapper around @flowradar/db's runBacktestPass — evaluates every
// Signal older than 15 minutes with incomplete BacktestResult coverage
// against its token's TokenMarketSnapshot series (triggeredAt -> now),
// upserting one BacktestResult row per horizon. Registered on
// settings.intervals.backtestHours (hours, converted to ms in
// apps/worker/src/index.ts alongside the other *Hours-interval jobs).
import { runBacktestPass } from '@flowradar/db';
import type { JobContext } from '../context';

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  await runBacktestPass(prisma, settings, new Date(), log);
}
