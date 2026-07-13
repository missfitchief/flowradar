// FlowRadar — complete-discovery sprint pilot: widened top-PnL extraction
// over ALL verified $10M+ runners -> Birdeye retry probe -> full dormancy/
// funding chain for newly discovered wallets -> DNA -> operator-root
// integrated capital outflow -> receiver enrollment -> roles + ENTITY DNA ->
// candidates -> FULL COVERAGE REPORT. PILOT DB ONLY. Foreground, bounded.
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
  buildDormantRunnerCandidates,
  buildCapitalOutflowPaths,
  buildReceiverEnrollments,
  buildTokenCandidateScores,
  buildEntityGraph,
  buildTopPnlExtractionStatus,
  buildCapitalChains
} = await import('@flowradar/db');
const { createBirdeyeTokenTopTraders } = await import('@flowradar/providers');
import { writeFileSync, mkdirSync } from 'node:fs';

async function main() {
  const t0 = Date.now();
  const runnersTotal = await prisma.tokenLifecycle.count({ where: { runnerClass: 'verified_above_10m' } });

  // Stage 1: WIDENED local top-PnL extraction (cap 10 -> 25 wallets/mint)
  // + a SMALL Birdeye retry probe (12 requests) to test whether the
  // compute-unit quota has reset — honest retryable states either way.
  const provider = createBirdeyeTokenTopTraders({ BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY });
  const discovery = await buildTokenTopPnlCandidates(prisma, {
    chain: 'SOLANA',
    limit: runnersTotal,
    perMintLocalCap: 25,
    provider,
    requestBudget: 12,
    retryErrored: true
  });
  console.log('[mining] discovery', JSON.stringify({ mints: discovery.mintsProcessed, localRows: discovery.localRowsWritten, provider: discovery.provider, errors: discovery.errors }));

  // Stage 2: wallets needing behavior/dormancy processing (new ones only).
  const localWallets = (
    await prisma.tokenTopPnlCandidate.findMany({
      where: { chain: 'SOLANA', validation: { notIn: ['provider_only', 'invalid'] } },
      select: { walletAddress: true }, distinct: ['walletAddress'], orderBy: { walletAddress: 'asc' }
    })
  ).map((w) => w.walletAddress);
  const withDna = new Set(
    (await prisma.walletDnaProfile.findMany({ where: { chain: 'SOLANA' }, select: { walletAddress: true } })).map((w) => w.walletAddress)
  );
  const newWallets = localWallets.filter((w) => !withDna.has(w));
  console.log('[mining] wallets', JSON.stringify({ total: localWallets.length, new: newWallets.length }));

  let reconstructed = 0;
  for (const w of newWallets) {
    try { await reconstructWalletBehavior(prisma, { chain: 'SOLANA', address: w }); reconstructed += 1; } catch { /* isolated */ }
  }
  if (newWallets.length > 0) {
    const t6 = await runActivityClassification(prisma, { chain: 'SOLANA', walletAddresses: newWallets, limit: newWallets.length });
    const t7 = await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: newWallets, limit: newWallets.length });
    const anchors = await prisma.addressDormancyObservation.count({ where: { chain: 'SOLANA', walletAddress: { in: newWallets } } });
    const t8 = await buildEntityDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: newWallets, limit: Math.max(1000, anchors) });
    const t9 = await buildFundingReactivationPaths(prisma, { chain: 'SOLANA', walletAddresses: newWallets, limit: Math.max(1000, anchors) });
    const t10 = await buildPostEntryBehaviors(prisma, { chain: 'SOLANA', walletAddresses: newWallets, limit: newWallets.length });
    console.log('[mining] chain(new)', JSON.stringify({ reconstructed, t6: t6.rowsWritten, t7: t7.observationsWritten, t8: t8.observationsWritten, t9: t9.pathsWritten, t10: t10.rowsWritten }));
  }
  // Repeat candidates over the FULL local-evidence universe (entity-adjusted).
  const t11 = await buildRepeatRunnerCandidates(prisma, { chain: 'SOLANA', walletAddresses: localWallets, limit: localWallets.length });
  const t12 = await buildDormantRunnerCandidates(prisma, { chain: 'SOLANA', walletAddresses: localWallets, limit: localWallets.length });
  // DNA for all local-evidence wallets (new get created; existing refreshed).
  const dna = await buildWalletDnaProfiles(prisma, { chain: 'SOLANA', walletAddresses: localWallets, limit: localWallets.length, forceReconstruct: false });
  console.log('[mining] t11/t12/dna', JSON.stringify({ t11: t11.byStatus, dna: dna.walletsWritten, dnaErrors: dna.errors }));

  // Stage 3: capital outflow — DNA wallets UNION operator roots as sources.
  const roots = await prisma.lineageRoot.findMany({ select: { wallet: { select: { address: true, chain: true } } } });
  const rootAddrs = roots.filter((r) => r.wallet.chain === 'SOLANA').map((r) => r.wallet.address);
  const sources = [...new Set([...localWallets, ...rootAddrs])].sort();
  const outflow = await buildCapitalOutflowPaths(prisma, { chain: 'SOLANA', walletAddresses: sources, limit: sources.length });
  const enroll = await buildReceiverEnrollments(prisma, { chain: 'SOLANA', limit: 1000 });
  console.log('[mining] outflow', JSON.stringify({ sources: sources.length, roots: rootAddrs.length, paths: outflow.pathsWritten, byTier: outflow.byTier, enrolled: enroll.enrolled }));

  // Stage 4: roles + ENTITY DNA.
  const graph = await buildEntityGraph(prisma, { chain: 'SOLANA' });
  console.log('[mining] graph', JSON.stringify({ roles: graph.rolesWritten, byRole: graph.byRole, entities: graph.entitiesWritten, multi: graph.multiWalletEntities, rootEntities: graph.rootEntities, errors: graph.errors }));

  // Stage 5: automatic token candidates over the widened universe.
  const cands = await buildTokenCandidateScores(prisma, { chain: 'SOLANA', limit: 500 });
  console.log('[mining] candidates', JSON.stringify({ byState: cands.byState, skippedLargeCap: cands.skippedLargeCap, errors: cands.errors }));

  // Stage 6: per-token extraction status + real capital chains.
  const extraction = await buildTopPnlExtractionStatus(prisma, { chain: 'SOLANA' });
  const chains = await buildCapitalChains(prisma, { chain: 'SOLANA' });
  console.log('[mining] extraction', JSON.stringify(extraction.byStatus));
  console.log('[mining] chains', JSON.stringify({ staging: chains.staging, deployment: chains.deployment, profitRotation: chains.profitRotation, endToEnd: chains.endToEndExamples, errors: chains.errors }));

  // ---- FULL COVERAGE REPORT -------------------------------------------------
  const [lc, enr, tpcByVal, uniqueWallets, dnaAgg, dormClasses, entClasses, sideWallets, rolesByRole, entityAgg, staging, deployedRecv, replayAgg] = await Promise.all([
    prisma.tokenLifecycle.groupBy({ by: ['runnerClass'], _count: { _all: true } }),
    prisma.tokenEnrichment.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.tokenTopPnlCandidate.groupBy({ by: ['validation'], where: { chain: 'SOLANA' }, _count: { _all: true } }),
    prisma.tokenTopPnlCandidate.groupBy({ by: ['walletAddress'], where: { chain: 'SOLANA' } }).then((r) => r.length),
    prisma.walletDnaProfile.aggregate({
      where: { chain: 'SOLANA' },
      _count: { _all: true },
      _sum: { completedPositions: true, winCount: true, lossCount: true, openPositions: true, unpricedPositions: true }
    }),
    prisma.addressDormancyObservation.groupBy({ by: ['overallClass'], where: { chain: 'SOLANA' }, _count: { _all: true } }),
    prisma.entityDormancyObservation.groupBy({ by: ['entityClass'], where: { chain: 'SOLANA' }, _count: { _all: true } }),
    prisma.walletRoleAssignment.count({ where: { chain: 'SOLANA', role: 'probable_side_wallet' } }),
    prisma.walletRoleAssignment.groupBy({ by: ['role'], where: { chain: 'SOLANA' }, _count: { _all: true } }),
    prisma.entityDnaProfile.aggregate({ where: { chain: 'SOLANA' }, _count: { _all: true } }),
    prisma.receiverEnrollment.count({ where: { chain: 'SOLANA' } }),
    prisma.receiverEnrollment.count({ where: { chain: 'SOLANA', deployedTokenCount: { gt: 0 } } }),
    prisma.replaySignalEvent.groupBy({ by: ['classification'], _count: { _all: true } })
  ]);
  const [wrWallets, evWallets, repeatEnt, oneWinnerEnt, entWithWR, dormWindows] = await Promise.all([
    prisma.walletDnaProfile.count({ where: { chain: 'SOLANA', winRate: { not: null } } }),
    prisma.walletDnaProfile.count({ where: { chain: 'SOLANA', evUsdPerCompletedPosition: { not: null } } }),
    prisma.entityDnaProfile.count({ where: { chain: 'SOLANA', repeatRunnerCount: { gte: 2 } } }),
    prisma.entityDnaProfile.count({ where: { chain: 'SOLANA', oneWinnerDependence: { gte: 0.8 } } }),
    prisma.entityDnaProfile.count({ where: { chain: 'SOLANA', winRate: { not: null } } }),
    prisma.addressDormancyObservation.findMany({
      where: { chain: 'SOLANA', overallClass: 'covered_dormant' },
      select: { maxCoveredDormantDays: true }
    })
  ]);
  const dw = { d7: 0, d14: 0, d30: 0, d90: 0, unknownDays: 0 };
  for (const o of dormWindows) {
    if (o.maxCoveredDormantDays === null) { dw.unknownDays += 1; continue; } // unknown is never bucketed as <7d
    const d = o.maxCoveredDormantDays;
    if (d >= 90) dw.d90 += 1;
    else if (d >= 30) dw.d30 += 1;
    else if (d >= 14) dw.d14 += 1;
    else if (d >= 7) dw.d7 += 1;
  }

  const report = {
    ts: new Date().toISOString(),
    durationSec: Math.round((Date.now() - t0) / 1000),
    tokenUniverse: {
      byRunnerClass: Object.fromEntries(lc.map((g) => [g.runnerClass ?? 'null', g._count._all])),
      enrichmentByStatus: Object.fromEntries(enr.map((g) => [g.status, g._count._all])),
      processingStates: {
        verified_runner: lc.find((g) => g.runnerClass === 'verified_above_10m')?._count._all ?? 0,
        conflicting: lc.find((g) => g.runnerClass === 'conflicting_evidence')?._count._all ?? 0,
        insufficient_history: lc.find((g) => g.runnerClass === 'insufficient_history')?._count._all ?? 0,
        pending_retry_enrichment: enr.find((g) => g.status === 'provider_error')?._count._all ?? 0
      }
    },
    topPnl: {
      byValidation: Object.fromEntries(tpcByVal.map((g) => [g.validation, g._count._all])),
      uniqueWallets,
      providerProbe: discovery.provider
    },
    dna: {
      wallets: dnaAgg._count._all,
      withWR: wrWallets,
      withEV: evWallets,
      completedPositions: dnaAgg._sum.completedPositions,
      wins: dnaAgg._sum.winCount,
      losses: dnaAgg._sum.lossCount,
      unresolved: (dnaAgg._sum.openPositions ?? 0) + (dnaAgg._sum.unpricedPositions ?? 0)
    },
    dormancy: {
      byClass: Object.fromEntries(dormClasses.map((g) => [g.overallClass, g._count._all])),
      coveredDormantByWindow: dw
    },
    entities: {
      entityDnaRows: entityAgg._count._all,
      withWR: entWithWR,
      repeatRunnerEntities: repeatEnt,
      oneWinnerDependent80pct: oneWinnerEnt,
      byEntityDormancyClass: Object.fromEntries(entClasses.map((g) => [g.entityClass, g._count._all])),
      probableSideWallets: sideWallets
    },
    roles: Object.fromEntries(rolesByRole.map((g) => [g.role, g._count._all])),
    extractionStatus: extraction.byStatus,
    capitalChains: { staging: chains.staging, deployment: chains.deployment, profitRotation: chains.profitRotation, endToEndExamples: chains.endToEndExamples },
    capital: { stagingReceivers: staging, deployedReceivers: deployedRecv },
    replay: Object.fromEntries(replayAgg.map((g) => [g.classification, g._count._all])),
    candidates: { byState: cands.byState, skippedLargeCap: cands.skippedLargeCap },
    honestGaps: [
      'Birdeye top-trader/enrichment retries remain quota-blocked when the probe reports provider errors (persisted retryable, resumable)',
      'GMGN has no verified public API — remains an honest typed stub, never guessed',
      'local trade coverage spans the shadow-run observation window — wallets outside it are honestly insufficient_history',
      'entity metrics aggregate address-DNA rollups (labeled approximation)'
    ]
  };
  mkdirSync('data/runner-mining', { recursive: true });
  writeFileSync('data/runner-mining/full-coverage-report.json', JSON.stringify(report, null, 2));
  console.log('[mining] REPORT', JSON.stringify(report));
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('[mining] FATAL', e?.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
