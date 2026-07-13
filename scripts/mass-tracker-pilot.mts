import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { prisma, runMassTransactionTracker, streamLegacyTrackerDataset, buildStoredMassTrackerTraces } from '@flowradar/db';

const maxEdges = envInt('MASS_TRACKER_MAX_EDGES', 250_000);
const maxBuys = envInt('MASS_TRACKER_MAX_BUYS', 50_000);
const batchSize = envInt('MASS_TRACKER_BATCH_SIZE', 1_000);
const runId = `real-local-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const startedAt = new Date();
let minTs: Date | null = null, maxTs: Date | null = null;
const chains = { SOLANA: 0, BSC: 0 };
const sourceCounts = { money_flow_edges: 0, wallet_token_trades: 0 };

try {
  const metrics = await runMassTransactionTracker(
    prisma,
    streamLegacyTrackerDataset(prisma, {
      maxEdges, maxBuys, observedAt: startedAt,
      onEvent(event, source) {
        chains[event.chain]++;
        sourceCounts[source]++;
        if (!minTs || event.ts < minTs) minTs = event.ts;
        if (!maxTs || event.ts > maxTs) maxTs = event.ts;
      }
    }),
    { runId, batchSize, maxRetries: 4, retryBaseMs: 50, enrollReceivers: true,
      metadata: { dataset: 'existing_local_real_evidence', maxEdges, maxBuys, canonicalModelVersion: 1 } }
  );
  const traceMetrics = minTs && maxTs ? await buildStoredMassTrackerTraces(prisma, {
    from: minTs, to: maxTs, maxHops: 5, maxEventsPerEntity: 100_000, runId
  }) : null;
  const traceSamples = await prisma.massTrackerTrace.findMany({
    where: { computedAt: { gte: startedAt } }, orderBy: [{ confidence: 'desc' }, { traceId: 'asc' }], take: 10
  });
  const report = {
    generatedAt: new Date().toISOString(), datasetTruth: 'real rows already persisted by live providers/pilots; no synthetic transaction generation',
    runId, requested: { maxEdges, maxBuys, batchSize }, sourceCounts, chains,
    observedRange: { from: minTs?.toISOString() ?? null, to: maxTs?.toISOString() ?? null },
    metrics, traceMetrics,
    traceSamples: traceSamples.map((t) => ({ traceId: t.traceId, sourceEntityKey: t.sourceEntityKey, sourceRole: t.sourceRole, sourceWallet: t.sourceWallet, terminalWallet: t.terminalWallet, tokenBought: t.tokenBought, route: t.route, eventIds: t.eventIds, fundingToBuyDelaySec: t.fundingToBuyDelaySec, confidence: t.confidence, grantsEligibility: t.grantsEligibility }))
  };
  const out = resolve('data/tracker/mass-tracker-pilot-report.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await prisma.$disconnect();
}

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}
