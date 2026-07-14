// FlowRadar — monitoringScheduler job (Wave C).
//
// Drives the queue-based monitoring scheduler. The poller's real work is to
// REOPEN the polled wallet's lineage expansion node(s) to pending, so the
// lineageExpansion job re-scans that wallet's transactions at its tier cadence
// (the scheduler decides WHICH wallets and WHEN under a request budget; the
// expansion job does the provider fetching). This is the honest integration —
// NOT a no-op. Never mutates wallet eligibility.

import { createMassTrackerSession, expandWalletCapitalGraph, runMonitoringScheduler, type MonitoringPollContext, type MonitoringPollFn } from '@flowradar/db';
import { createLiveWalletCapitalScanner } from '@flowradar/providers';
import type { JobContext } from '../context';

// Bounded per tick — the scheduler's tier cadences keep most wallets not-due.
const REQUEST_BUDGET = 40;

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, log } = ctx;
  const liveScanner = process.env.MOCK_MODE === 'false' ? createLiveWalletCapitalScanner(process.env) : null;
  const due: MonitoringPollContext[] = [];

  const poll: MonitoringPollFn = async (item) => {
    const { walletAddress, walletChain } = item;
    try {
      due.push(item);
      // Reopen this wallet's completed/skipped expansion nodes so the next
      // lineageExpansion pass re-scans it. Idempotent; enrollment dedupes.
      // Provider FETCHING happens in lineageExpansion (its own per-node error
      // isolation + the node stays pending for retry). We surface provider
      // health back to the scheduler's backoff by reporting ok=false when the
      // wallet's LAST expansion ended in an error stop reason — so a
      // persistently-failing wallet is polled less often.
      const errored = await prisma.lineageExpansionNode.findFirst({
        where: { walletAddress, chain: walletChain, stopReason: { startsWith: 'error' } },
        select: { id: true }
      });
      await prisma.lineageExpansionNode.updateMany({
        where: { walletAddress, chain: walletChain, status: { in: ['done', 'skipped'] } },
        data: { status: 'pending' }
      });
      return { ok: errored === null };
    } catch {
      return { ok: false };
    }
  };

  const result = await runMonitoringScheduler(prisma, { requestBudget: REQUEST_BUDGET, poll });
  let livePolled = 0;
  let liveEvents = 0;
  let liveErrors = 0;
  if (liveScanner) {
    const [coreWatches, lineageRoots] = await Promise.all([
      prisma.operatorWatch.findMany({ where: { targetType: 'core_wallet', active: true }, select: { targetKey: true } }),
      prisma.lineageRoot.findMany({
        where: { id: { in: due.map((item) => item.lineageRootId).filter((value): value is string => Boolean(value)) } },
        select: { id: true, wallet: { select: { address: true } } }
      })
    ]);
    const coreTargets = new Set(coreWatches.map((watch) => watch.targetKey));
    const rootTarget = new Map(lineageRoots.map((root) => [root.id, root.wallet.address]));
    const coreDue = due.filter((item) => item.walletChain !== 'SOLANA' && (
      coreTargets.has(item.walletAddress) || Boolean(item.lineageRootId && coreTargets.has(rootTarget.get(item.lineageRootId) ?? ''))
    ));
    const outcomes = await mapConcurrent(coreDue, 3, async (item) => {
      try {
        const since = item.previousLastPolledAt
          ? new Date(item.previousLastPolledAt.getTime() - 5 * 60_000)
          : new Date(Date.now() - 24 * 60 * 60_000);
        const scan = await liveScanner.scanAddress(item.walletChain, item.walletAddress, { root: item.tier === 'root_permanent', maxPages: 1, since });
        if (!scan.events.length) return { ok: true, events: 0 };
        const tracker = await createMassTrackerSession(prisma, {
          enrollReceivers: true,
          metadata: { workflow: 'core_wallet_monitoring', chain: item.walletChain, wallet: item.walletAddress, tier: item.tier, since: since.toISOString() }
        });
        let metrics;
        try {
          await tracker.ingest(scan.events.map((event) => ({ ...event, metadata: { ...event.metadata, coreWalletMonitoringPoll: true } })));
          metrics = await tracker.complete();
        } catch (error) {
          await tracker.fail(error);
          throw error;
        }
        if (metrics.persistedEvents > 0) {
          await expandWalletCapitalGraph(prisma, {
            chain: item.walletChain, walletAddress: item.walletAddress, maxDepth: 4,
            maxNodes: item.tier === 'root_permanent' ? 100 : 30, maxEventsPerNode: 500
          });
        }
        return { ok: true, events: metrics.persistedEvents };
      } catch (error) {
        await prisma.monitoringSubscription.updateMany({
          where: { walletId: item.walletId, priority: item.tier, active: true },
          data: { consecutiveErrors: { increment: 1 }, nextPollAt: new Date(Date.now() + 5 * 60_000) }
        });
        log?.error('core EVM monitoring poll failed', {
          chain: item.walletChain, wallet: item.walletAddress,
          error: error instanceof Error ? error.message : String(error)
        });
        return { ok: false, events: 0 };
      }
    });
    livePolled = outcomes.length;
    liveEvents = outcomes.reduce((sum, outcome) => sum + outcome.events, 0);
    liveErrors = outcomes.filter((outcome) => !outcome.ok).length;
  }
  log?.info('monitoringScheduler pass complete', { ...result, livePolled, liveEvents, liveErrors, byTier: JSON.stringify(result.byTier) });
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, fn: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await fn(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
