import { loadAdaptivePerformanceMetrics, prisma, runAdaptiveIntelligenceBackfill } from '@flowradar/db';

const startedAt = new Date();
const runId = process.env.ADAPTIVE_BACKFILL_RUN_ID || undefined;
try {
  const result = await runAdaptiveIntelligenceBackfill(prisma, { runId, now: startedAt });
  const counts = {
    entities: await prisma.intelligenceEntity.count(),
    memberships: await prisma.intelligenceEntityMembership.count(),
    entityVersions: await prisma.intelligenceEntityVersion.count(),
    decaySnapshots: await prisma.intelligenceEntityDecaySnapshot.count(),
    signals: await prisma.intelligenceSignal.count({ where: { status: 'active' } }),
    controlledTestSignals: await prisma.intelligenceSignal.count({ where: { status: 'controlled_test' } }),
    outcomes: await prisma.intelligenceSignalOutcome.count(),
    outcomeLabels: await prisma.intelligenceSignalOutcomeLabel.count(),
    buyCandidates: await prisma.intelligenceBuyCandidate.count(),
    weightProposals: await prisma.intelligenceWeightProposal.count(),
    replayRuns: await prisma.intelligenceReplayRun.count()
  };
  console.log(JSON.stringify({ startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), result, counts, performance: await loadAdaptivePerformanceMetrics(prisma) }, null, 2));
} finally {
  await prisma.$disconnect();
}
