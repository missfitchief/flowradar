import { getProductionHealth, prisma } from '@flowradar/db';

try {
  const [health, seedProfiles, seedSubscriptions, subscriptionsByPriority, providerCursors, latestTracker, latestLifecycle, latestBackupIntegrity] = await Promise.all([
    getProductionHealth(prisma),
    prisma.walletIntelligenceProfile.count({ where: { discoverySource: 'priority_core_wallet_seed' } }),
    prisma.monitoringSubscription.count({ where: { active: true, wallet: { intelligenceProfile: { discoverySource: 'priority_core_wallet_seed' } } } }),
    prisma.monitoringSubscription.groupBy({ by: ['priority', 'active'], _count: { _all: true } }),
    prisma.providerSyncState.groupBy({ by: ['provider'], _count: { _all: true }, _max: { lastSyncAt: true }, _sum: { failCount: true } }),
    prisma.massTrackerRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    prisma.intelligenceLifecycleRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    prisma.productionIntegrityRun.findFirst({ orderBy: { startedAt: 'desc' } })
  ]);
  console.log(JSON.stringify({
    generatedAt: new Date(),
    seedWallets: { profiles: seedProfiles, activeMonitoringSubscriptions: seedSubscriptions },
    subscriptionsByPriority,
    providerCursors,
    health,
    latestTracker,
    latestLifecycle,
    latestIntegrity: latestBackupIntegrity
  }, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
} finally {
  await prisma.$disconnect();
}
