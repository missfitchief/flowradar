// FlowRadar — live-DB census (Prerequisite A, Capital Lineage 6b).
// READ-ONLY: reports synthetic-vs-live composition. Operator roots are
// identified by their LineageRoot records; everything else in a DB that has
// only ever been seeded + root-imported is mock-world synthetic.

import { prisma } from '@flowradar/db';

const walletsByStatus = await prisma.wallet.groupBy({ by: ['status'], _count: true });
const rootWalletIds = (await prisma.lineageRoot.findMany({ select: { walletId: true } })).map((r) => r.walletId);
const rootCount = rootWalletIds.length;
const nonRootWallets = await prisma.wallet.count({ where: { id: { notIn: rootWalletIds } } });
const rootsWithStats = await prisma.walletStats.count({ where: { walletId: { in: rootWalletIds } } });
const rootsWithTrades = await prisma.walletTokenTrade.count({ where: { walletId: { in: rootWalletIds } } });
const statsBySource = await prisma.walletStats.groupBy({ by: ['source'], _count: true });
const tokens = await prisma.token.count();
const trades = await prisma.walletTokenTrade.count();
const marketSnapshots = await prisma.tokenMarketSnapshot.groupBy({ by: ['source'], _count: true });
const subsByPriority = await prisma.monitoringSubscription.groupBy({ by: ['priority'], _count: true });
const flowEdges = await prisma.moneyFlowEdge.count();
const candidates = await prisma.candidateWallet.count();
const registry = await prisma.addressRegistry.count();
const sources = await prisma.externalWalletSource.count();
const chains = await prisma.chain.count();
const settings = await prisma.settings.count();
const signals = await prisma.signal.count();
const socialMentions = await prisma.socialMention.count();

console.log(
  JSON.stringify(
    {
      operatorRoots: { lineageRoots: rootCount, rootsWithStats, rootsWithTrades },
      walletsByStatus,
      nonRootWallets_syntheticMockWorld: nonRootWallets,
      statsBySource_allSyntheticIfNoLiveIngest: statsBySource,
      tokens_allSynthetic: tokens,
      trades_allSynthetic: trades,
      marketSnapshotsBySource: marketSnapshots,
      flowEdges_synthetic: flowEdges,
      candidates_synthetic: candidates,
      signals_synthetic: signals,
      socialMentions_synthetic: socialMentions,
      subscriptionsByPriority: subsByPriority,
      preservedConfig: { chains, settings, addressRegistry: registry, externalWalletSources: sources }
    },
    null,
    2
  )
);
await prisma.$disconnect();
