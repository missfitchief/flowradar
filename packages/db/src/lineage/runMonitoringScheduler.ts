// FlowRadar — Capital Lineage (Wave C): monitoring scheduler.
//
// QUEUE-based, NO per-wallet timers. One bounded pass:
//   1. reclaim stale claims (a crashed pass leaves claimedAt set);
//   2. expire fresh_receiver_hot subscriptions past hotUntil -> probable_link;
//   3. select DUE active subscriptions (nextPollAt<=now or null) in priority
//      order, up to a provider request BUDGET;
//   4. atomically CLAIM each (claimedAt), invoke the poll callback, then set
//      nextPollAt (with exponential backoff on error), lastPolledAt, counters,
//      and clear the claim.
// service nodes are never subscribed, so they are never polled here. The
// scheduler NEVER mutates Wallet.status/eligibility. Holds the global job lock.

import type { PrismaClient } from '@prisma/client';
import {
  DEFAULT_MONITORING_SCHEDULE,
  computeNextPollAt,
  tierRank,
  type MonitoringScheduleConfig,
  type MonitoringTier
} from '@flowradar/core';
import { withGlobalJobLock } from '../locks/globalJobLock';

export interface MonitoringPollContext {
  walletId: string;
  walletAddress: string;
  tier: MonitoringTier;
  lineageRootId: string | null;
}

/** Polls one wallet. Returns ok=false to trigger backoff. Must not throw for a single wallet. */
export type MonitoringPollFn = (ctx: MonitoringPollContext) => Promise<{ ok: boolean }>;

export interface MonitoringSchedulerResult {
  reclaimed: number;
  hotExpired: number;
  due: number;
  polled: number;
  pollErrors: number;
  budgetExhausted: boolean;
  byTier: Record<string, number>;
}

export interface MonitoringSchedulerOptions {
  /** Max wallets polled this pass (the provider request budget). */
  requestBudget?: number;
  now?: Date;
  config?: MonitoringScheduleConfig;
  /** Injected poller; default is a no-op (schedule-only advance). */
  poll?: MonitoringPollFn;
  /** Narrow to subscriptions whose wallet address starts with this prefix (targeted scheduling / test isolation). */
  walletAddressStartsWith?: string;
}

export async function runMonitoringScheduler(
  prisma: PrismaClient,
  opts: MonitoringSchedulerOptions = {}
): Promise<MonitoringSchedulerResult> {
  return withGlobalJobLock('monitoring-scheduler', async () => {
    const now = opts.now ?? new Date();
    const config = opts.config ?? DEFAULT_MONITORING_SCHEDULE;
    const budget = opts.requestBudget ?? 100;
    const poll: MonitoringPollFn = opts.poll ?? (async () => ({ ok: true }));
    const scope = opts.walletAddressStartsWith ? { wallet: { address: { startsWith: opts.walletAddressStartsWith } } } : {};

    const result: MonitoringSchedulerResult = {
      reclaimed: 0,
      hotExpired: 0,
      due: 0,
      polled: 0,
      pollErrors: 0,
      budgetExhausted: false,
      byTier: {}
    };

    // 1. Reclaim stale claims (crashed prior pass — the lock guarantees no
    // concurrent scheduler, so any claim older than the window is orphaned).
    const staleBefore = new Date(now.getTime() - config.staleClaimSec * 1000);
    const reclaimed = await prisma.monitoringSubscription.updateMany({
      where: { claimedAt: { lt: staleBefore }, ...scope },
      data: { claimedAt: null }
    });
    result.reclaimed = reclaimed.count;

    // 2. Expire fresh_receiver_hot subscriptions past their hot window.
    const hotExpired = await prisma.monitoringSubscription.updateMany({
      where: { priority: 'fresh_receiver_hot', hotUntil: { lte: now }, ...scope },
      data: { priority: 'probable_link' }
    });
    result.hotExpired = hotExpired.count;

    // 3. Select DUE active, unclaimed subscriptions in priority order, bounded
    // by the request budget. weak_cold/cold_archive still appear (cold, low
    // frequency) but their long intervals keep them rarely due.
    const dueSubs = await prisma.monitoringSubscription.findMany({
      where: {
        active: true,
        claimedAt: null,
        OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }],
        ...scope
      },
      orderBy: [{ nextPollAt: 'asc' }],
      take: budget * 4, // over-fetch, then priority-sort in memory + trim to budget
      include: { wallet: { select: { id: true, address: true } } }
    });
    // Priority-sort (tier rank) then due-time; trim to budget.
    dueSubs.sort((a, b) => tierRank(a.priority as MonitoringTier) - tierRank(b.priority as MonitoringTier) || (a.nextPollAt?.getTime() ?? 0) - (b.nextPollAt?.getTime() ?? 0));
    result.due = dueSubs.length;
    const batch = dueSubs.slice(0, budget);
    if (dueSubs.length > budget) result.budgetExhausted = true;

    for (const sub of batch) {
      // Atomic claim — a concurrent/duplicate scheduler cannot double-claim.
      const claim = await prisma.monitoringSubscription.updateMany({
        where: { id: sub.id, claimedAt: null },
        data: { claimedAt: now }
      });
      if (claim.count === 0) continue; // someone else claimed it

      const tier = sub.priority as MonitoringTier;
      let ok = true;
      try {
        const res = await poll({ walletId: sub.walletId, walletAddress: sub.wallet.address, tier, lineageRootId: sub.lineageRootId });
        ok = res.ok;
      } catch {
        ok = false; // per-wallet error isolation — never aborts the pass
      }

      const consecutiveErrors = ok ? 0 : sub.consecutiveErrors + 1;
      await prisma.monitoringSubscription.update({
        where: { id: sub.id },
        data: {
          claimedAt: null,
          lastPolledAt: now,
          pollCount: { increment: 1 },
          consecutiveErrors,
          nextPollAt: computeNextPollAt(tier, now, consecutiveErrors, config)
        }
      });

      result.polled += 1;
      if (!ok) result.pollErrors += 1;
      result.byTier[tier] = (result.byTier[tier] ?? 0) + 1;
    }

    return result;
  });
}
