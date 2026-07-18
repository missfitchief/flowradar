import {
  WalletInvestigationService,
  persistInvestigationKnowledge,
  prisma,
  runIntelligenceLifecycle
} from '@flowradar/db';

const latest = await prisma.walletInvestigation.findFirst({
  where: { status: 'completed' },
  orderBy: { completedAt: 'desc' },
  select: { id: true, investigationKey: true, completedAt: true }
});

let knowledge: Awaited<ReturnType<typeof persistInvestigationKnowledge>> | null = null;
if (latest) {
  const service = new WalletInvestigationService(prisma);
  const result = await service.load(latest.investigationKey);
  if (result) knowledge = await persistInvestigationKnowledge(prisma, result, { now: latest.completedAt ?? new Date() });
}

const now = new Date();
const lifecycle = await runIntelligenceLifecycle(prisma, {
  since: new Date(now.getTime() - 24 * 60 * 60_000),
  now,
  maxProfiles: 5_000,
  maxEvents: 10_000
});
const counts = {
  profiles: await prisma.walletIntelligenceProfile.count(),
  clusters: await prisma.intelligenceCluster.count({ where: { status: 'active' } }),
  observations: await prisma.walletIntelligenceObservation.count(),
  activityEvents: await prisma.walletIntelligenceEvent.count(),
  signals: await prisma.intelligenceSignal.count(),
  buyCandidates: await prisma.intelligenceBuyCandidate.count()
};

console.log(JSON.stringify({ latestInvestigation: latest, knowledge, lifecycle, counts }, null, 2));
await prisma.$disconnect();
