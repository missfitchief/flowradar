// FlowRadar — working-loop pilot: capital outflow -> receiver enrollment ->
// automatic token-candidate feed. PILOT DB ONLY. Foreground, bounded.
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.join(HERE, '..', '..', 'flowradar', '.env') });

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
if (url.pathname !== '/flowradar_pilot') throw new Error('pilot DB only: ' + url.pathname);

const { prisma, buildCapitalOutflowPaths, buildReceiverEnrollments, buildTokenCandidateScores } = await import('@flowradar/db');
import { writeFileSync, mkdirSync } from 'node:fs';

async function main() {
  const t0 = Date.now();

  // Stage 1: capital outflow from the full qualified DNA cohort.
  const outflow = await buildCapitalOutflowPaths(prisma, { chain: 'SOLANA', limit: 300 });
  console.log('[candidates-pilot] outflow', JSON.stringify(outflow.byTier), 'errors', outflow.errors);

  // Stage 2: receiver enrollment (observation_only) + deployment detection.
  const enrollment = await buildReceiverEnrollments(prisma, { chain: 'SOLANA', limit: 500 });
  console.log('[candidates-pilot] enrollment', JSON.stringify(enrollment.byClass), 'errors', enrollment.errors);

  // Stage 3: automatic token-candidate feed over cohort + receivers.
  const candidates = await buildTokenCandidateScores(prisma, { chain: 'SOLANA', limit: 500 });
  console.log('[candidates-pilot] candidates', JSON.stringify(candidates.byState), 'errors', candidates.errors);

  // Idempotency probe (semantic re-run).
  const before = await prisma.tokenCandidateScore.findMany({
    where: { chain: 'SOLANA' },
    orderBy: { mint: 'asc' },
    select: { mint: true, state: true, score: true, independentEntityCount: true }
  });
  await buildTokenCandidateScores(prisma, { chain: 'SOLANA', limit: 500 });
  const after = await prisma.tokenCandidateScore.findMany({
    where: { chain: 'SOLANA' },
    orderBy: { mint: 'asc' },
    select: { mint: true, state: true, score: true, independentEntityCount: true }
  });

  const topCandidates = await prisma.tokenCandidateScore.findMany({
    where: { chain: 'SOLANA' },
    orderBy: [{ score: 'desc' }, { mint: 'asc' }],
    take: 15,
    select: {
      mint: true, state: true, score: true, confidence: true, independentEntityCount: true,
      qualifiedBuyerCount: true, dormantReactivations: true, kolContamination: true,
      currentMcapUsd: true, nonCohortBuyerCount: true
    }
  });

  const report = {
    ts: new Date().toISOString(),
    durationSec: Math.round((Date.now() - t0) / 1000),
    outflow: {
      walletsConsidered: outflow.walletsConsidered,
      walletsProcessed: outflow.walletsProcessed,
      pathsWritten: outflow.pathsWritten,
      byTier: outflow.byTier,
      byReceiverClass: outflow.byReceiverClass,
      errors: outflow.errors,
      errorReceipts: outflow.errorReceipts.slice(0, 5)
    },
    enrollment: {
      receiversConsidered: enrollment.receiversConsidered,
      enrolled: enrollment.enrolled,
      byClass: enrollment.byClass,
      deploymentsDetected: enrollment.deploymentsDetected,
      errors: enrollment.errors,
      errorReceipts: enrollment.errorReceipts.slice(0, 5)
    },
    candidates: {
      mintsConsidered: candidates.mintsConsidered,
      mintsWritten: candidates.mintsWritten,
      byState: candidates.byState,
      errors: candidates.errors,
      errorReceipts: candidates.errorReceipts.slice(0, 5)
    },
    topCandidates: topCandidates.map((c) => ({
      ...c,
      currentMcapUsd: c.currentMcapUsd === null ? null : Number(c.currentMcapUsd)
    })),
    idempotency: { identical: JSON.stringify(before) === JSON.stringify(after) },
    honestGaps: [
      'outflow/receiver discovery is bounded local observation — unobserved transfers cannot be excluded',
      'the pilot DB is a frozen copy — candidate states describe the frozen observation window, not live-market now',
      'cex_correlation paths never attribute downstream receivers; bridge paths never attribute destination-chain continuations'
    ]
  };
  mkdirSync('data/runner-mining', { recursive: true });
  writeFileSync('data/runner-mining/candidates-pilot-report.json', JSON.stringify(report, null, 2));
  console.log('[candidates-pilot] REPORT', JSON.stringify(report, null, 2));
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('[candidates-pilot] FATAL', e?.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
