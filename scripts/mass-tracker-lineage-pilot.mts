import { prisma, runMassTransactionTracker, streamLegacyLineageEvidence, buildStoredMassTrackerTraces } from '@flowradar/db';

const now = new Date();
const runId = `real-lineage-${now.toISOString().replace(/[:.]/g, '-')}`;
try {
  const metrics = await runMassTransactionTracker(prisma, streamLegacyLineageEvidence(prisma, { maxEdges: 100_000, maxBuys: 50_000, observedAt: now }), {
    runId, batchSize: 3_000, maxRetries: 4, retryBaseMs: 50, enrollReceivers: true,
    metadata: { dataset: 'targeted_existing_lineage_and_real_buys', canonicalModelVersion: 1 }
  });
  const traces = await buildStoredMassTrackerTraces(prisma, { from: new Date('2020-01-01T00:00:00Z'), to: now, maxHops: 5, maxEventsPerEntity: 200_000, runId });
  const samples = await prisma.massTrackerTrace.findMany({ orderBy: [{ confidence: 'desc' }, { traceId: 'asc' }], take: 10 });
  console.log(JSON.stringify({ runId, metrics, traces, samples: samples.map((x) => ({ sourceEntityKey: x.sourceEntityKey, sourceWallet: x.sourceWallet, terminalWallet: x.terminalWallet, tokenBought: x.tokenBought, route: x.route, eventIds: x.eventIds, confidence: x.confidence, grantsEligibility: x.grantsEligibility })) }, null, 2));
} finally { await prisma.$disconnect(); }
