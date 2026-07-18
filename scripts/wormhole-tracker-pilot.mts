import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { prisma, runMassTransactionTracker, type MassTrackerSourceItem } from '@flowradar/db';
import { streamWormholeSolanaBscEvents } from '@flowradar/providers';

const pages = Math.max(1, Math.min(100, Number(process.env.WORMHOLE_PILOT_PAGES ?? 10)));
const observedAt = new Date();
const runId = `wormhole-real-${observedAt.toISOString().replace(/[:.]/g, '-')}`;
async function* source(): AsyncIterable<MassTrackerSourceItem> {
  for await (const event of streamWormholeSolanaBscEvents({ pages, pageSize: 100, observedAt })) yield { event };
}
try {
  const metrics = await runMassTransactionTracker(prisma, source(), {
    runId, batchSize: 500, maxRetries: 4, retryBaseMs: 250, enrollReceivers: false,
    metadata: { dataset: 'official_wormholescan_mainnet_solana_bsc', pages, officialApi: true }
  });
  const correlations = await prisma.massBridgeCorrelation.findMany({
    where: { correlatedAt: { gte: observedAt }, status: 'verified' }, orderBy: { correlationId: 'asc' }, take: 20
  });
  const report = { generatedAt: new Date().toISOString(), runId, pages, metrics, verifiedSamples: correlations };
  const out = resolve('data/tracker/wormhole-pilot-report.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally { await prisma.$disconnect(); }
