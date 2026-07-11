// FlowRadar — enrichment phase 2: Birdeye-backed resolution of the runner
// cohort + control verification + early-buyer bands. PILOT DB ONLY.
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.join(HERE, '..', '.env') });
loadDotenv({ path: path.join(HERE, '..', '..', 'flowradar', '.env') }); // main worktree keys (worktrees do not share .env)

const { prisma, enrichTokenHistory, classifyRunnerCohort, buildControlMatches, extractEarlyBuyers } = await import('@flowradar/db');
import { writeFileSync, mkdirSync } from 'node:fs';

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
if (url.pathname !== '/flowradar_pilot') throw new Error('phase2 must run against flowradar_pilot — refusing: ' + url.pathname);
const KEY = process.env.BIRDEYE_API_KEY;

async function main() {
  // Target set 1: every current verified runner (includes the 37 suspects).
  const runners = (await prisma.tokenLifecycle.findMany({
    where: { runnerClass: 'verified_above_10m' },
    orderBy: { mint: 'asc' },
    select: { mint: true }
  })).map((r) => r.mint);

  // Target set 2: deterministic control candidates by PRE-outcome features:
  // covered universe, baseline < $1M, ordered by mint, bounded.
  const controlCandidates = (await prisma.tokenLifecycle.findMany({
    where: { coverage: 'covered', runnerClass: { not: 'verified_above_10m' }, baselineMcapUsd: { lt: 1_000_000, gt: 0 } },
    orderBy: { mint: 'asc' },
    take: 500,
    select: { mint: true }
  })).map((r) => r.mint);

  const mints = [...runners, ...controlCandidates];
  console.log(`[phase2] enrichment targets: ${runners.length} runners + ${controlCandidates.length} control candidates`);
  const enrichReport = await enrichTokenHistory(prisma, { mints, apiKey: KEY, maxRequests: 2000 });
  console.log('[phase2] enrichment:', JSON.stringify(enrichReport));

  // Rerun classification ONCE (enrichment precedence inside), then matching, then entries.
  let cursor: string | null = null;
  const byClass: Record<string, number> = {};
  for (;;) {
    const r = await classifyRunnerCohort(prisma, { batchSize: 1000, cursor });
    for (const [k, v] of Object.entries(r.byClass)) byClass[k] = (byClass[k] ?? 0) + v;
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  const matches = await buildControlMatches(prisma);
  const entries = await extractEarlyBuyers(prisma, { maxMints: 400 });

  // Suspect resolution audit: what happened to the >=1e10 local-ATH class?
  const remainingSuspects = await prisma.tokenLifecycle.count({ where: { runnerClass: 'verified_above_10m', athMcapUsd: { gte: 1e10 } } });
  const confirmed = await prisma.tokenLifecycle.count({ where: { runnerClass: 'verified_above_10m' } });
  const verifiedBelow = await prisma.tokenLifecycle.count({ where: { runnerClass: 'verified_below_10m' } });
  const conflicting = await prisma.tokenLifecycle.count({ where: { runnerClass: 'conflicting_evidence' } });

  const report = {
    ts: new Date().toISOString(),
    enrichment: enrichReport,
    classification: byClass,
    confirmedRunners: confirmed,
    remainingHighAthRunners_ge_10B: remainingSuspects,
    verifiedNonRunners: verifiedBelow,
    conflictingEvidence: conflicting,
    controls: matches,
    earlyBuyers: entries
  };
  mkdirSync('data/runner-mining', { recursive: true });
  writeFileSync('data/runner-mining/phase2-report.json', JSON.stringify(report, null, 2));
  console.log('[phase2] REPORT', JSON.stringify(report, null, 2));
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error('[phase2] FATAL', e?.message ?? e); await prisma.$disconnect(); process.exit(1); });
