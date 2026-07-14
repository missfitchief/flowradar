import { tierPriorityValue, type MonitoringTier } from '@flowradar/core';
import type { ChainId, PrismaClient } from '@prisma/client';

export function monitoringTierForRole(role: string): MonitoringTier {
  if (role === 'operator_root' || role === 'root_main') return 'root_permanent';
  if (role === 'fresh_funded_receiver' || role === 'dormant_funded_receiver' || role === 'dormant_reactivated') return 'fresh_receiver_hot';
  if (role === 'execution_wallet' || role === 'high_pnl_wallet' || role === 'priority_core_seed_candidate') return 'strong_link';
  if (['probable_side_wallet', 'bridge_linked_receiver', 'profit_collection_wallet', 'funding_wallet'].includes(role)) return 'probable_link';
  return 'standard';
}

export async function enrollObservationWallet(
  prisma: PrismaClient,
  input: { chain: ChainId; address: string; role: string; reason: string; firstSeenAt?: Date | null; lastActiveAt?: Date | null; now?: Date }
) {
  const now = input.now ?? new Date();
  const firstSeenAt = input.firstSeenAt ?? now;
  const lastActiveAt = input.lastActiveAt ?? firstSeenAt;
  const wallet = await prisma.wallet.upsert({
    where: { address_chain: { address: input.address, chain: input.chain } },
    create: {
      address: input.address,
      chain: input.chain,
      firstSeenAt,
      lastActiveAt,
      isWatched: true,
      status: 'observation_only',
      notes: `backend-intelligence:${input.reason}`
    },
    update: { isWatched: true }
  });
  await Promise.all([
    prisma.wallet.updateMany({ where: { id: wallet.id, firstSeenAt: { gt: firstSeenAt } }, data: { firstSeenAt } }),
    prisma.wallet.updateMany({ where: { id: wallet.id, lastActiveAt: { lt: lastActiveAt } }, data: { lastActiveAt } })
  ]);
  const tier = monitoringTierForRole(input.role);
  const root = await prisma.lineageRoot.findUnique({ where: { walletId: wallet.id }, select: { id: true } });
  const hotUntil = tier === 'fresh_receiver_hot' ? new Date(now.getTime() + 48 * 60 * 60_000) : null;
  const subscription = await prisma.monitoringSubscription.upsert({
    where: { walletId_priority: { walletId: wallet.id, priority: tier } },
    create: {
      walletId: wallet.id,
      priority: tier,
      active: true,
      tierPriority: tierPriorityValue(tier),
      reason: input.reason.slice(0, 500),
      lineageRootId: root?.id ?? null,
      nextPollAt: now,
      hotUntil
    },
    update: {
      active: true,
      tierPriority: tierPriorityValue(tier),
      reason: input.reason.slice(0, 500),
      nextPollAt: now,
      hotUntil
    }
  });
  return { wallet, subscription };
}
