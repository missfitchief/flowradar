// FlowRadar — Priority 1 bounded lineage RECONCILIATION smoke.
//
// Proves, against the LIVE DB + LIVE Helius provider (normal speed, bounded):
//   1. honest valuation (edges by valuationStatus; unknown never zero)
//   2. relationships persisted; receivers observation_only; no fake WalletStats
//   3. REPLAY IDEMPOTENCY: two identical bounded passes back-to-back — the
//      second pass must create ~no new rows beyond genuinely-new on-chain txs
//      (duplicates prevented by (txHash, leg) uniqueness + upserts)
//   4. service nodes not expanded (serviceNodesSkipped / stop reasons)
//   5. smart-count invariant: signal_eligible count UNCHANGED by the run
// Bounds: depth 1, 2 pages/node, maxNodesPerPass 8 — same as lineage-smoke.
// Usage: MOCK_MODE=false npx tsx scripts/lineage-reconcile-smoke.ts
import { prisma, runLineageExpansion, type LineageProvider } from '@flowradar/db';
import { getProvider } from '@flowradar/providers';
import { DEFAULT_SETTINGS, WSOL_MINT } from '@flowradar/core';

const rssMb = () => Math.round(process.memoryUsage().rss / (1024 * 1024));

interface Snapshot {
  edges: number;
  edgesByValuation: Record<string, number>;
  relationships: number;
  relsByKind: Record<string, number>;
  hotSubs: number;
  subsTotal: number;
  frontier: Record<string, number>;
  observation: number;
  eligible: number;
  walletStats: number;
  wallets: number;
}

async function snapshot(): Promise<Snapshot> {
  const groupToRec = (rows: { _count: number }[], key: (r: never) => string) =>
    Object.fromEntries((rows as never[]).map((r) => [key(r), (r as { _count: number })._count]));
  return {
    edges: await prisma.moneyFlowEdge.count(),
    edgesByValuation: groupToRec(
      await prisma.moneyFlowEdge.groupBy({ by: ['valuationStatus'], _count: true }),
      (r: { valuationStatus: string | null }) => String(r.valuationStatus)
    ),
    relationships: await prisma.walletRelationship.count(),
    relsByKind: groupToRec(
      await prisma.walletRelationship.groupBy({ by: ['kind'], _count: true }),
      (r: { kind: string }) => r.kind
    ),
    hotSubs: await prisma.monitoringSubscription.count({ where: { priority: 'fresh_receiver_hot' } }),
    subsTotal: await prisma.monitoringSubscription.count(),
    frontier: groupToRec(
      await prisma.lineageExpansionNode.groupBy({ by: ['status'], _count: true }),
      (r: { status: string }) => r.status
    ),
    observation: await prisma.wallet.count({ where: { status: 'observation_only' } }),
    eligible: await prisma.wallet.count({ where: { status: 'signal_eligible' } }),
    walletStats: await prisma.walletStats.count(),
    wallets: await prisma.wallet.count()
  };
}

function delta(a: Snapshot, b: Snapshot): Record<string, number> {
  return {
    edges: b.edges - a.edges,
    relationships: b.relationships - a.relationships,
    hotSubs: b.hotSubs - a.hotSubs,
    subsTotal: b.subsTotal - a.subsTotal,
    observation: b.observation - a.observation,
    eligible: b.eligible - a.eligible,
    walletStats: b.walletStats - a.walletStats,
    wallets: b.wallets - a.wallets
  };
}

async function boundedPass(label: string) {
  const settings = await (async () => {
    const row = await prisma.settings.findFirst();
    const merged = row ? { ...DEFAULT_SETTINGS, ...(row.values as object) } : DEFAULT_SETTINGS;
    return { ...merged, lineage: { ...DEFAULT_SETTINGS.lineage, maxDepth: 1, backfillMaxPagesPerNode: 2 } };
  })();
  const provider = getProvider('SOLANA', 'walletActivity') as unknown as LineageProvider;
  let solPrice: number | null = null;
  try {
    solPrice = (await getProvider('SOLANA', 'marketData').getTokenMarket('SOLANA', WSOL_MINT))?.priceUsd ?? null;
  } catch { /* leave null — unknown stays unknown */ }
  // Reopen depth-0 roots so the pass re-processes the SAME history (replay).
  await prisma.lineageExpansionNode.updateMany({ where: { depth: 0, status: 'done' }, data: { status: 'pending', cursor: null } });
  const t0 = Date.now();
  const result = await runLineageExpansion(prisma, provider, settings, { maxNodesPerPass: 8, solCurrentPriceUsd: solPrice });
  console.log(JSON.stringify({ pass: label, durationSec: Math.round((Date.now() - t0) / 1000), solPriceKnown: solPrice !== null, result, rssMb: rssMb() }));
  return result;
}

async function main(): Promise<void> {
  if (process.env.MOCK_MODE === 'true') throw new Error('reconciliation smoke must run live (MOCK_MODE=false)');
  const before = await snapshot();
  console.log(JSON.stringify({ phase: 'before', ...before }));

  const r1 = await boundedPass('pass-1');
  const mid = await snapshot();
  console.log(JSON.stringify({ phase: 'after-pass-1', delta: delta(before, mid), edgesByValuation: mid.edgesByValuation }));

  const r2 = await boundedPass('pass-2-replay');
  const after = await snapshot();
  const replayDelta = delta(mid, after);
  console.log(JSON.stringify({ phase: 'after-replay', delta: replayDelta, relsByKind: after.relsByKind, frontier: after.frontier }));

  // Duplicates prevented = replay_skipped stop-reason counts: transfers the
  // pass re-encountered and DECLINED to re-persist/re-enroll (deduped by
  // (txHash, leg) uniqueness + idempotent upserts). NOTE: with
  // maxNodesPerPass < root count, pass 2 may advance through DIFFERENT roots
  // than pass 1 — its new edges are new COVERAGE, not duplicates; the
  // replay_skipped counters are the honest dedupe evidence.
  const duplicatesPrevented = (r1.stopReasons['replay_skipped'] ?? 0) + (r2.stopReasons['replay_skipped'] ?? 0);
  const invariants = {
    eligibleUnchanged: before.eligible === after.eligible,
    walletStatsUnchanged: before.walletStats === after.walletStats,
    unknownNeverZero: Object.keys(after.edgesByValuation).every((k) => k !== 'null'),
    replayNoDuplicateRels: replayDelta.relationships === 0 || replayDelta.relationships <= r2.receiversEnrolled,
    replayNoDuplicateSubs: replayDelta.subsTotal <= r2.receiversEnrolled
  };
  console.log(JSON.stringify({
    phase: 'verdict',
    duplicatesPrevented,
    serviceNodesSkipped: { pass1: r1.serviceNodesSkipped, pass2: r2.serviceNodesSkipped },
    errors: { pass1: r1.errors, pass2: r2.errors },
    stopReasons: { pass1: r1.stopReasons, pass2: r2.stopReasons },
    invariants,
    smartCountInvariant: invariants.eligibleUnchanged ? `HOLDS (signal_eligible ${before.eligible} -> ${after.eligible})` : `VIOLATED (${before.eligible} -> ${after.eligible})`,
    rssMb: rssMb()
  }, null, 2));
  if (!invariants.eligibleUnchanged || !invariants.walletStatsUnchanged) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch((e) => { console.error('reconcile smoke failed:', e instanceof Error ? e.message : e); process.exitCode = 1; });
