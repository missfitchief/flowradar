// FlowRadar — top-PnL discovery pilot (runner-mining scope correction).
// PILOT DB ONLY. Foreground, budgeted, resumable.
//
// Chain: token_top_pnl_candidates over ALL verified $10M+ runners (local
// reconstruction + REAL Birdeye top_traders under a request budget) ->
// discovered-wallet behavior reconstruction (existing engine) -> dormancy
// (T6/T7/T8) -> funding paths (T9) -> post-entry (T10) -> repeat/dormant
// candidates (T11/T12, entity-adjusted) -> Wallet DNA -> COVERAGE REPORT
// (real numbers; honest gaps; never claims completion beyond what ran).
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.join(HERE, '..', '..', 'flowradar', '.env') });

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
if (url.pathname !== '/flowradar_pilot') throw new Error('pilot DB only: ' + url.pathname);

const {
  prisma,
  buildTokenTopPnlCandidates,
  buildWalletDnaProfiles,
  reconstructWalletBehavior,
  runActivityClassification,
  buildAddressDormancyObservations,
  buildEntityDormancyObservations,
  buildFundingReactivationPaths,
  buildPostEntryBehaviors,
  buildRepeatRunnerCandidates,
  buildDormantRunnerCandidates
} = await import('@flowradar/db');
const { createBirdeyeTokenTopTraders } = await import('@flowradar/providers');
import { writeFileSync, mkdirSync } from 'node:fs';

const REQUEST_BUDGET = Number(process.env.TOPPNL_REQUEST_BUDGET ?? 400);
const PACE_MS = 1100; // plan ceiling ~1rps — pace every provider call

function paced<T extends { getTopTraders: (...a: never[]) => Promise<unknown> }>(provider: T): T {
  let last = 0;
  const inner = provider.getTopTraders.bind(provider);
  return {
    ...provider,
    async getTopTraders(...args: never[]) {
      const wait = last + PACE_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return inner(...args);
    }
  } as T;
}

async function main() {
  const t0 = Date.now();
  const runnersTotal = await prisma.tokenLifecycle.count({ where: { runnerClass: 'verified_above_10m' } });

  // --- Stage 1: candidate discovery over ALL verified runners --------------
  const rawProvider = createBirdeyeTokenTopTraders({ BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY });
  const provider = rawProvider ? paced(rawProvider) : null;
  const discovery = await buildTokenTopPnlCandidates(prisma, {
    chain: 'SOLANA',
    limit: runnersTotal,
    provider,
    requestBudget: REQUEST_BUDGET
  });
  const byValidation = Object.fromEntries(
    (await prisma.tokenTopPnlCandidate.groupBy({ by: ['validation'], where: { chain: 'SOLANA' }, _count: { _all: true } }))
      .map((g) => [g.validation, g._count._all])
  );
  const bySource = Object.fromEntries(
    (await prisma.tokenTopPnlCandidate.groupBy({ by: ['source'], where: { chain: 'SOLANA' }, _count: { _all: true } }))
      .map((g) => [g.source, g._count._all])
  );
  const fetchStates = Object.fromEntries(
    (await prisma.topPnlFetchState.groupBy({ by: ['status'], _count: { _all: true } }))
      .map((g) => [g.status, g._count._all])
  );
  console.log('[toppnl-pilot] stage1 discovery done', JSON.stringify({ byValidation, bySource, fetchStates }));

  // --- Stage 2: discovered wallets (dedup) ----------------------------------
  const candidateWallets = await prisma.tokenTopPnlCandidate.findMany({
    where: { chain: 'SOLANA' },
    select: { walletAddress: true, validation: true },
    orderBy: { walletAddress: 'asc' }
  });
  const allWallets = [...new Set(candidateWallets.map((c) => c.walletAddress))].sort();
  const localEvidenceWallets = [
    ...new Set(candidateWallets.filter((c) => c.validation !== 'provider_only' && c.validation !== 'invalid').map((c) => c.walletAddress))
  ].sort();
  const providerOnlyWallets = allWallets.filter((w) => !localEvidenceWallets.includes(w));

  // --- Stage 3: behavior reconstruction (existing engine, missing only) ----
  let reconstructed = 0;
  let reconstructErrors = 0;
  for (const w of localEvidenceWallets) {
    const exists = await prisma.walletBehaviorProfile.findUnique({
      where: { chain_walletAddress: { chain: 'SOLANA', walletAddress: w } },
      select: { id: true }
    });
    if (exists) continue;
    try {
      await reconstructWalletBehavior(prisma, { chain: 'SOLANA', address: w });
      reconstructed += 1;
    } catch {
      reconstructErrors += 1;
    }
  }
  console.log('[toppnl-pilot] stage3 reconstruction', JSON.stringify({ localEvidenceWallets: localEvidenceWallets.length, reconstructed, reconstructErrors }));

  // --- Stage 4: dormancy chain over the discovered cohort ------------------
  const t6 = await runActivityClassification(prisma, {
    chain: 'SOLANA', walletAddresses: localEvidenceWallets, limit: localEvidenceWallets.length
  });
  const t7 = await buildAddressDormancyObservations(prisma, {
    chain: 'SOLANA', walletAddresses: localEvidenceWallets, limit: localEvidenceWallets.length
  });
  const anchorCount = await prisma.addressDormancyObservation.count({
    where: { walletAddress: { in: localEvidenceWallets }, chain: 'SOLANA' }
  });
  const t8 = await buildEntityDormancyObservations(prisma, {
    chain: 'SOLANA', walletAddresses: localEvidenceWallets, limit: Math.max(1000, anchorCount)
  });
  const t9 = await buildFundingReactivationPaths(prisma, {
    chain: 'SOLANA', walletAddresses: localEvidenceWallets, limit: Math.max(1000, anchorCount)
  });
  const t10 = await buildPostEntryBehaviors(prisma, {
    chain: 'SOLANA', walletAddresses: localEvidenceWallets, limit: localEvidenceWallets.length
  });
  console.log('[toppnl-pilot] stage4 dormancy chain done');

  // Dormancy AT the profitable entries specifically (runner-token anchors).
  const runnerMints = (await prisma.tokenLifecycle.findMany({
    where: { runnerClass: 'verified_above_10m' }, select: { mint: true }
  })).map((r) => r.mint);
  const profitableEntryDormancy = Object.fromEntries(
    (await prisma.addressDormancyObservation.groupBy({
      by: ['overallClass'],
      where: { chain: 'SOLANA', walletAddress: { in: localEvidenceWallets }, anchorKey: { in: runnerMints } },
      _count: { _all: true }
    })).map((g) => [g.overallClass, g._count._all])
  );
  const profitableEntryEntity = Object.fromEntries(
    (await prisma.entityDormancyObservation.groupBy({
      by: ['entityClass'],
      where: { chain: 'SOLANA', walletAddress: { in: localEvidenceWallets }, anchorKey: { in: runnerMints } },
      _count: { _all: true }
    })).map((g) => [g.entityClass, g._count._all])
  );

  // --- Stage 5: repeat/dormant candidates (entity-adjusted) ----------------
  const t11 = await buildRepeatRunnerCandidates(prisma, {
    chain: 'SOLANA', walletAddresses: localEvidenceWallets, limit: localEvidenceWallets.length
  });
  const t12 = await buildDormantRunnerCandidates(prisma, {
    chain: 'SOLANA', walletAddresses: localEvidenceWallets, limit: localEvidenceWallets.length
  });

  // --- Stage 6: Wallet DNA over ALL discovered wallets ----------------------
  const dna = await buildWalletDnaProfiles(prisma, {
    chain: 'SOLANA', walletAddresses: allWallets, limit: allWallets.length
  });
  const dnaByCoverage = Object.fromEntries(
    (await prisma.walletDnaProfile.groupBy({
      by: ['coverage'], where: { chain: 'SOLANA', walletAddress: { in: allWallets } }, _count: { _all: true }
    })).map((g) => [g.coverage, g._count._all])
  );
  const dnaRows = await prisma.walletDnaProfile.findMany({
    where: { chain: 'SOLANA', walletAddress: { in: allWallets } },
    select: { completedPositions: true, winCount: true, lossCount: true, winRate: true, evUsdPerCompletedPosition: true }
  });
  const withCompleted = dnaRows.filter((d) => d.completedPositions > 0);
  const wrEv = {
    walletsWithDna: dnaRows.length,
    walletsWithCompletedPositions: withCompleted.length,
    walletsWithNullWinRate: dnaRows.filter((d) => d.winRate === null).length,
    totalCompletedPositions: dnaRows.reduce((a, d) => a + d.completedPositions, 0),
    totalWins: dnaRows.reduce((a, d) => a + d.winCount, 0),
    totalLosses: dnaRows.reduce((a, d) => a + d.lossCount, 0),
    medianWinRateOverCompleted: (() => {
      const v = withCompleted.map((d) => d.winRate as number).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    })()
  };

  // --- Idempotency probe (semantic, first 5 local-evidence wallets) ---------
  const probe = localEvidenceWallets.slice(0, 5);
  const snapshot = async () => ({
    candidates: await prisma.tokenTopPnlCandidate.findMany({
      where: { walletAddress: { in: probe } },
      orderBy: [{ mint: 'asc' }, { walletAddress: 'asc' }, { source: 'asc' }],
      select: { mint: true, walletAddress: true, source: true, validation: true, providerRank: true }
    }),
    dna: await prisma.walletDnaProfile.findMany({
      where: { walletAddress: { in: probe } },
      orderBy: { walletAddress: 'asc' },
      select: { walletAddress: true, coverage: true, completedPositions: true, winCount: true, lossCount: true }
    })
  });
  const before = await snapshot();
  await buildTokenTopPnlCandidates(prisma, { chain: 'SOLANA', limit: runnersTotal, provider: null });
  await buildWalletDnaProfiles(prisma, { chain: 'SOLANA', walletAddresses: probe, limit: probe.length });
  const after = await snapshot();

  const report = {
    ts: new Date().toISOString(),
    durationSec: Math.round((Date.now() - t0) / 1000),
    coverage: {
      runnerUniverse: runnersTotal,
      mintsProcessed: discovery.mintsProcessed,
      mintErrors: discovery.errors,
      provider: discovery.provider,
      fetchStates,
      note: 'provider window is 24h PRESENT-time (doc cap) — current-day traders, never a historical leaderboard; local reconstruction is the historical source'
    },
    candidates: { bySource, byValidation, localRowsWritten: discovery.localRowsWritten, providerRowsWritten: discovery.providerRowsWritten },
    wallets: {
      discovered: allWallets.length,
      withLocalEvidence: localEvidenceWallets.length,
      providerOnly: providerOnlyWallets.length,
      behaviorReconstructed: reconstructed,
      reconstructErrors
    },
    dormancyChain: {
      t6: { rowsWritten: t6.rowsWritten, byClass: t6.byClass, errors: t6.errors, walletsWithTruncation: t6.walletsWithTruncation },
      t7: { observations: t7.observationsWritten, byOverallClass: t7.byOverallClass, errors: t7.errors },
      t8: { observations: t8.observationsWritten, byEntityClass: t8.byEntityClass, errors: t8.errors },
      t9: { paths: t9.pathsWritten, byStatus: t9.byStatus, errors: t9.errors },
      t10: { rows: t10.rowsWritten, byPrimaryClass: t10.byPrimaryClass, errors: t10.errors },
      profitableEntryDormancy,
      profitableEntryEntity
    },
    repeatCandidates: { t11: { byStatus: t11.byStatus, entities: t11.entitiesConsidered, errors: t11.errors }, t12: { byPattern: t12.byPattern, errors: t12.errors } },
    walletDna: { batch: { written: dna.walletsWritten, errors: dna.errors, reconstructed: dna.reconstructed }, byCoverage: dnaByCoverage, wrEv },
    idempotency: { identical: JSON.stringify(before) === JSON.stringify(after) },
    honestGaps: [
      'provider top_traders is a 24h present-window (hard doc cap) — historical top traders of past runners are NOT retrievable from this endpoint',
      'unpriced local trades produce incomplete validations and unpriced positions (never fabricated $0)',
      'coverage below the full runner universe (budget/errors) is recorded in fetchStates — completion is never claimed beyond what ran'
    ]
  };
  mkdirSync('data/runner-mining', { recursive: true });
  writeFileSync('data/runner-mining/toppnl-pilot-report.json', JSON.stringify(report, null, 2));
  console.log('[toppnl-pilot] REPORT', JSON.stringify(report, null, 2));
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('[toppnl-pilot] FATAL', e?.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
