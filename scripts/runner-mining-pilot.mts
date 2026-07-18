// FlowRadar — bounded real runner-mining pilot (RM Tasks 1-4). Runs the
// universe -> cohort -> controls -> early-buyers chain over the DB in
// DATABASE_URL (a PILOT COPY of live data — never the live shadow DB) and
// prints + persists a machine-readable report. Bounded + resumable via the
// builders' own cursors.
import { prisma } from '@flowradar/db';
import { buildTokenUniverse, classifyRunnerCohort, buildControlMatches, extractEarlyBuyers } from '@flowradar/db';
import { writeFileSync, mkdirSync } from 'node:fs';

const BATCH = 1000;
const MAX_BATCHES = 30; // hard bound: 30k tokens max this pilot

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
  if (url.pathname !== '/flowradar_pilot') throw new Error('pilot must run against the flowradar_pilot DB copy (pathname check) — refusing: ' + url.pathname);

  // Task 1 — universe (cursor loop, bounded)
  const universeTotals: Record<string, number> = {};
  let cursor: string | null = null;
  let created = 0, updated = 0, scanned = 0, errors = 0, batches = 0;
  for (;;) {
    if (batches >= MAX_BATCHES) { console.log('[pilot] batch bound reached — resumable via cursor', cursor); break; }
    const r = await buildTokenUniverse(prisma, { batchSize: BATCH, cursor });
    batches += 1; scanned += r.scanned; created += r.created; updated += r.updated; errors += r.errors;
    for (const [k, v] of Object.entries(r.byCoverage)) universeTotals[k] = (universeTotals[k] ?? 0) + v;
    console.log(`[pilot] universe batch ${batches}: scanned=${r.scanned} cursor=${r.nextCursor?.slice(0, 8) ?? 'END'}`);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }

  // Task 2 — runner classification (cursor loop)
  const classTotals: Record<string, number> = {};
  let ccursor: string | null = null; let cerrors = 0; let cbatches = 0;
  for (;;) {
    if (cbatches >= MAX_BATCHES) break;
    const r = await classifyRunnerCohort(prisma, { batchSize: BATCH, cursor: ccursor });
    cbatches += 1; cerrors += r.errors;
    for (const [k, v] of Object.entries(r.byClass)) classTotals[k] = (classTotals[k] ?? 0) + v;
    if (!r.nextCursor) break;
    ccursor = r.nextCursor;
  }

  // Task 3 — matched controls
  const matchReport = await buildControlMatches(prisma);

  // Task 4 — early buyers over matched cohorts
  const earlyReport = await extractEarlyBuyers(prisma, { maxMints: 400 });

  // Evidence samples (receipts) for the report
  const runnerSamples = await prisma.tokenLifecycle.findMany({
    where: { runnerClass: 'verified_above_10m' },
    take: 5, orderBy: { athMcapUsd: 'desc' },
    select: { mint: true, athMcapUsd: true, athTs: true, confidence: true, evidenceJson: true }
  });
  const belowSamples = await prisma.tokenLifecycle.findMany({
    where: { runnerClass: 'verified_below_10m' }, take: 3,
    select: { mint: true, athMcapUsd: true, confidence: true, evidenceJson: true }
  });
  const confidenceDist = await prisma.tokenLifecycle.groupBy({ by: ['confidence'], _count: { _all: true }, where: { runnerClass: { not: null } } });

  // Idempotency proof: rerun one universe batch + classify batch — zero new rows
  const before = await prisma.tokenLifecycle.count();
  await buildTokenUniverse(prisma, { batchSize: BATCH });
  await classifyRunnerCohort(prisma, { batchSize: BATCH });
  const after = await prisma.tokenLifecycle.count();

  const report = {
    ts: new Date().toISOString(),
    universe: { scanned, created, updated, errors, byCoverage: universeTotals },
    classification: { byClass: classTotals, errors: cerrors, confidenceDistribution: Object.fromEntries(confidenceDist.map((c) => [c.confidence ?? 'null', c._count._all])) },
    controls: matchReport,
    earlyBuyers: earlyReport,
    idempotency: { lifecyclesBeforeRerun: before, lifecyclesAfterRerun: after, identical: before === after },
    samples: { runners: runnerSamples, nonRunners: belowSamples },
    limitations: [
      'local-data-only pilot: mcap series = live-observed market snapshots + per-trade marketCapAtTrade (2026-07-11 run window); Birdeye OHLCV enrichment is the documented next step',
      'most tokens entered observation mid-life -> below-$10M verdicts require launch anchoring, so insufficient_history dominates by design (survivorship honesty)',
      'early-buyer confidence is LOW: bounded polling cannot prove completeness before observed trades'
    ]
  };
  mkdirSync('data/runner-mining', { recursive: true });
  writeFileSync('data/runner-mining/pilot-report.json', JSON.stringify(report, null, 2));
  console.log('[pilot] REPORT', JSON.stringify(report, null, 2).slice(0, 4000));
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error('[pilot] FATAL', e?.message ?? e); await prisma.$disconnect(); process.exit(1); });
