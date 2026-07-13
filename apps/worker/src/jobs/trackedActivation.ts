import { scanTrackedTokenActivations } from '@flowradar/db';
import type { JobContext } from '../context';

const MAX_TRACKED_WALLETS_PER_PASS = 50_000;
const MAX_BUY_EVENTS_PER_PASS = 100_000;

export async function run(ctx: JobContext): Promise<void> {
  const report = await scanTrackedTokenActivations(ctx.prisma, {
    maxTrackedWallets: MAX_TRACKED_WALLETS_PER_PASS,
    maxBuyEvents: MAX_BUY_EVENTS_PER_PASS
  });
  ctx.log?.info('tracked activation scan complete', {
    runId: report.runId,
    trackedWallets: report.trackedWallets,
    newBuyEvents: report.newBuyEvents,
    tokensConsidered: report.tokensConsidered,
    alertsCreated: report.alertsCreated,
    honestEmpty: report.honestEmpty,
    byType: JSON.stringify(report.byType)
  });
}
