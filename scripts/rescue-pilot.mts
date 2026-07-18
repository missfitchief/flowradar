// FlowRadar — product-rescue pilot: valuation backfill -> golden cohort ->
// Wallet DNA v2 -> no-lookahead replay -> candidate feed rebuild.
// PILOT DB ONLY. Foreground, bounded, idempotent.
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.join(HERE, '..', '..', 'flowradar', '.env') });

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
if (url.pathname !== '/flowradar_pilot') throw new Error('pilot DB only: ' + url.pathname);

const {
  prisma,
  backfillTradeValuations,
  buildGoldenCohort,
  buildWalletDnaProfiles,
  runNoLookaheadReplay,
  buildTokenCandidateScores,
  buildCapitalOutflowPaths,
  buildReceiverEnrollments
} = await import('@flowradar/db');
import { writeFileSync, mkdirSync } from 'node:fs';

async function main() {
  const t0 = Date.now();

  // 1. Valuation backfill over every enriched token (bounded, idempotent).
  const backfill = await backfillTradeValuations(prisma, { chain: 'SOLANA', limit: 300 });
  console.log('[rescue] backfill', JSON.stringify({ backfilled: backfill.backfilled, bySource: backfill.bySource, unpriceable: backfill.unpriceable, mcapFilled: backfill.mcapFilled, errors: backfill.errors }));

  // 2. Golden cohort selection (post-backfill coverage metrics).
  const cohort = await buildGoldenCohort(prisma, { chain: 'SOLANA' });
  console.log('[rescue] cohort', JSON.stringify(cohort));

  // 3. Wallet DNA v2 recompute — FORCE reconstruct (trades changed).
  const allWallets = (
    await prisma.tokenTopPnlCandidate.findMany({
      where: { chain: 'SOLANA' }, select: { walletAddress: true }, distinct: ['walletAddress'], orderBy: { walletAddress: 'asc' }
    })
  ).map((w) => w.walletAddress);
  const dna = await buildWalletDnaProfiles(prisma, {
    chain: 'SOLANA', walletAddresses: allWallets, limit: allWallets.length, forceReconstruct: true
  });
  const dnaRows = await prisma.walletDnaProfile.findMany({
    where: { chain: 'SOLANA', walletAddress: { in: allWallets } },
    select: { walletAddress: true, completedPositions: true, winCount: true, lossCount: true, winRate: true, evUsdPerCompletedPosition: true, medianReturn: true, repeatRunnerCount: true, oneWinnerDependence: true }
  });
  const withWR = dnaRows.filter((d) => d.winRate !== null);
  const hardMin = dnaRows.filter((d) => d.winRate !== null && d.completedPositions >= 2);
  console.log('[rescue] dna', JSON.stringify({
    written: dna.walletsWritten, errors: dna.errors,
    withCompleted: dnaRows.filter((d) => d.completedPositions > 0).length,
    withWR: withWR.length, withWRand2Completed: hardMin.length,
    totalCompleted: dnaRows.reduce((a, d) => a + d.completedPositions, 0),
    totalWins: dnaRows.reduce((a, d) => a + d.winCount, 0),
    totalLosses: dnaRows.reduce((a, d) => a + d.lossCount, 0)
  }));

  // 4. No-lookahead historical replay over the golden cohort.
  const replay = await runNoLookaheadReplay(prisma, { chain: 'SOLANA' });
  console.log('[rescue] replay', JSON.stringify(replay));

  // 5. Rebuild outflow/receivers/candidates on the now-priced data.
  const outflow = await buildCapitalOutflowPaths(prisma, { chain: 'SOLANA', limit: 300 });
  const enroll = await buildReceiverEnrollments(prisma, { chain: 'SOLANA', limit: 500 });
  const candidates = await buildTokenCandidateScores(prisma, { chain: 'SOLANA', limit: 500 });
  console.log('[rescue] candidates', JSON.stringify({ byState: candidates.byState, skippedLargeCap: candidates.skippedLargeCap, errors: candidates.errors }));

  const topDna = dnaRows
    .filter((d) => d.winRate !== null)
    .sort((a, b) => (b.completedPositions - a.completedPositions))
    .slice(0, 10);

  const report = {
    ts: new Date().toISOString(),
    durationSec: Math.round((Date.now() - t0) / 1000),
    backfill: { backfilled: backfill.backfilled, bySource: backfill.bySource, unpriceable: backfill.unpriceable, mcapFilled: backfill.mcapFilled, tradesExamined: backfill.tradesExamined, errors: backfill.errors, errorReceipts: backfill.errorReceipts.slice(0, 5) },
    cohort,
    dna: {
      written: dna.walletsWritten,
      errors: dna.errors,
      withCompleted: dnaRows.filter((d) => d.completedPositions > 0).length,
      withWR: withWR.length,
      withWRand2Completed: hardMin.length,
      totalCompleted: dnaRows.reduce((a, d) => a + d.completedPositions, 0),
      totalWins: dnaRows.reduce((a, d) => a + d.winCount, 0),
      totalLosses: dnaRows.reduce((a, d) => a + d.lossCount, 0),
      topWallets: topDna.map((d) => ({
        wallet: d.walletAddress, completed: d.completedPositions, wins: d.winCount, losses: d.lossCount,
        winRate: d.winRate, ev: d.evUsdPerCompletedPosition === null ? null : Number(d.evUsdPerCompletedPosition),
        medianReturn: d.medianReturn, repeatRunners: d.repeatRunnerCount, oneWinnerDependence: d.oneWinnerDependence
      }))
    },
    replay: { ...replay, errorReceipts: replay.errorReceipts.slice(0, 5) },
    candidates: { byState: candidates.byState, skippedLargeCap: candidates.skippedLargeCap, errors: candidates.errors },
    outflow: { pathsWritten: outflow.pathsWritten, byTier: outflow.byTier, errors: outflow.errors },
    enrollment: { enrolled: enroll.enrolled, byClass: enroll.byClass, errors: enroll.errors },
    honestGaps: [
      'valuations from prior snapshots (conf 70) and prior 1D candle closes (conf 40) are explicit estimates — labeled per trade, never silent',
      'replay entity/KOL mappings are current-state approximations (receipted per event)',
      'post-entry behavior is post-T and excluded from replay at-event evidence'
    ]
  };
  mkdirSync('data/runner-mining', { recursive: true });
  writeFileSync('data/runner-mining/rescue-pilot-report.json', JSON.stringify(report, null, 2));
  console.log('[rescue] REPORT WRITTEN');
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('[rescue] FATAL', e?.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
