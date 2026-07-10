// FlowRadar — monitoringScheduler job (Wave C).
//
// Drives the queue-based monitoring scheduler. The poller's real work is to
// REOPEN the polled wallet's lineage expansion node(s) to pending, so the
// lineageExpansion job re-scans that wallet's transactions at its tier cadence
// (the scheduler decides WHICH wallets and WHEN under a request budget; the
// expansion job does the provider fetching). This is the honest integration —
// NOT a no-op. Never mutates wallet eligibility.

import { runMonitoringScheduler, type MonitoringPollFn } from '@flowradar/db';
import type { JobContext } from '../context';

// Bounded per tick — the scheduler's tier cadences keep most wallets not-due.
const REQUEST_BUDGET = 40;

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, log } = ctx;

  const poll: MonitoringPollFn = async ({ walletAddress }) => {
    try {
      // Reopen this wallet's completed/skipped expansion nodes so the next
      // lineageExpansion pass re-scans it. Idempotent; enrollment dedupes.
      await prisma.lineageExpansionNode.updateMany({
        where: { walletAddress, chain: 'SOLANA', status: { in: ['done', 'skipped'] } },
        data: { status: 'pending' }
      });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };

  const result = await runMonitoringScheduler(prisma, { requestBudget: REQUEST_BUDGET, poll });
  log?.info('monitoringScheduler pass complete', { ...result, byTier: JSON.stringify(result.byTier) });
}
