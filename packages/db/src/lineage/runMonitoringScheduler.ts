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

import type { ChainId, PrismaClient } from '@prisma/client';
import {
  DEFAULT_MONITORING_SCHEDULE,
  computeNextPollAt,
  coldTransition,
  tierPriorityValue,
  type MonitoringScheduleConfig,
  type MonitoringTier
} from '@flowradar/core';
import { withGlobalJobLock } from '../locks/globalJobLock';

/**
 * Transitions a subscription to a new tier, honoring the
 * @@unique([walletId, priority]) constraint (Wave C Codex P1): if the target
 * tier already exists for the wallet, the transitioning row is DELETED
 * (deduplicate — the wallet is already monitored at the target) rather than
 * updated into a collision; otherwise it is updated in place. Never throws
 * P2002.
 */
async function transitionTier(
  prisma: PrismaClient,
  subId: string,
  walletId: string,
  toTier: MonitoringTier
): Promise<'updated' | 'deduped'> {
  const collision = await prisma.monitoringSubscription.findUnique({
    where: { walletId_priority: { walletId, priority: toTier } },
    select: { id: true }
  });
  if (collision && collision.id !== subId) {
    await prisma.monitoringSubscription.delete({ where: { id: subId } });
    return 'deduped';
  }
  await prisma.monitoringSubscription.update({
    where: { id: subId },
    data: { priority: toTier, tierPriority: tierPriorityValue(toTier) }
  });
  return 'updated';
}

export interface MonitoringPollContext {
  walletId: string;
  walletAddress: string;
  walletChain: ChainId;
  previousLastPolledAt: Date | null;
  tier: MonitoringTier;
  lineageRootId: string | null;
}

/** Polls one wallet. Returns ok=false to trigger backoff. Must not throw for a single wallet. */
export type MonitoringPollFn = (ctx: MonitoringPollContext) => Promise<{ ok: boolean }>;

export interface MonitoringSchedulerResult {
  reclaimed: number;
  hotExpired: number;
  coldDemoted: number;
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
      coldDemoted: 0,
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

    // 2. Expire fresh_receiver_hot past its hot window -> probable_link,
    // per-row (collision-safe, Wave C Codex P1). BOUNDED scan (Codex round-2:
    // an unbounded expiry backlog could hold the lock too long).
    const MAINT_LIMIT = 500;
    const expiring = await prisma.monitoringSubscription.findMany({
      where: { priority: 'fresh_receiver_hot', hotUntil: { lte: now }, ...scope },
      select: { id: true, walletId: true },
      take: MAINT_LIMIT
    });
    for (const s of expiring) {
      await transitionTier(prisma, s.id, s.walletId, 'probable_link');
      result.hotExpired += 1;
    }

    // 3. Cold-demote idle non-permanent subscriptions one step toward
    // cold_archive (wires the pure coldTransition). Filter to genuinely IDLE
    // wallets (lastActiveAt older than coldAfterDays), OLDEST first, so a burst
    // of recent rows can't starve idle ones (Codex round-2).
    const coldBefore = new Date(now.getTime() - config.coldAfterDays * 86_400_000);
    const coldCandidates = await prisma.monitoringSubscription.findMany({
      where: {
        active: true,
        priority: { in: ['strong_link', 'probable_link', 'standard', 'weak_cold'] },
        // Priority core seeds are deliberately permanent monitoring
        // candidates. Historical inactivity is their value proposition, not
        // a reason to push them into the cold archive; real enrichment may
        // later change their intelligence scores, but age alone may not.
        NOT: { reason: { startsWith: 'priority_core_seed' } },
        wallet: { lastActiveAt: { lt: coldBefore } },
        ...scope
      },
      select: { id: true, priority: true, walletId: true, wallet: { select: { lastActiveAt: true } } },
      orderBy: { wallet: { lastActiveAt: 'asc' } },
      take: MAINT_LIMIT
    });
    for (const s of coldCandidates) {
      const to = coldTransition(s.priority as MonitoringTier, s.wallet.lastActiveAt, now, config);
      if (to) {
        await transitionTier(prisma, s.id, s.walletId, to);
        result.coldDemoted += 1;
      }
    }

    // 4. Select DUE active, unclaimed subscriptions ordered by the EXPLICIT
    // tierPriority integer (the enum's on-disk order is migration order, not
    // tier order — Codex round-2) then due time, nulls FIRST (never-scheduled
    // == due now). Take exactly the budget — the DB ordering selects the
    // highest-priority due rows, not an over-fetch window.
    const safeBudget = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 100;
    const batch = await prisma.monitoringSubscription.findMany({
      where: {
        active: true,
        claimedAt: null,
        OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }],
        ...scope
      },
      orderBy: [{ tierPriority: 'asc' }, { nextPollAt: { sort: 'asc', nulls: 'first' } }],
      take: safeBudget,
      include: { wallet: { select: { id: true, address: true, chain: true } } }
    });
    result.due = batch.length;
    // Exhaustion: is there at least one more due row beyond the budget?
    if (batch.length === safeBudget) {
      const more = await prisma.monitoringSubscription.count({
        where: { active: true, claimedAt: null, OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }], ...scope }
      });
      if (more > safeBudget) result.budgetExhausted = true;
    }

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
        const res = await poll({ walletId: sub.walletId, walletAddress: sub.wallet.address, walletChain: sub.wallet.chain, previousLastPolledAt: sub.lastPolledAt, tier, lineageRootId: sub.lineageRootId });
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
