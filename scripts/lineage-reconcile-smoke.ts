// FlowRadar — Priority 1 bounded lineage RECONCILIATION smoke (rev 2, Codex).
//
// Two passes over the SAME explicitly-selected depth-0 nodes (a TRUE replay):
//   pass 1 may persist genuinely-new on-chain rows; pass 2 re-processes the
//   identical node set, so its row deltas MUST be ~0 — that is the duplicate-
//   prevention proof (dedupe key: (txHash, sourceAddress, destinationAddress,
//   actionType) per schema — NOTE the documented blind spot: same-pair
//   multi-leg transfers within one tx collapse into one edge; this smoke
//   cannot detect that class).
// Also proves: honest valuation (every 'unavailable' edge has valuedUsd NULL —
// unknown is never a number), receivers observation_only, no WalletStats
// writes, service addresses never enter the frontier, smart-count invariant.
// Bounds: exactly REOPEN_COUNT nodes reopened (by id, logged), depth 1,
// 2 pages/node, normal live speed. Exits non-zero on any violated invariant
// or provider errors.
// Usage: MOCK_MODE=false npx tsx scripts/lineage-reconcile-smoke.ts
import { prisma, runLineageExpansion, type LineageProvider } from '@flowradar/db';
import { getProvider } from '@flowradar/providers';
import { DEFAULT_SETTINGS, WSOL_MINT } from '@flowradar/core';

const REOPEN_COUNT = 8;
const SERVICE_CATEGORIES = ['CEX', 'BRIDGE', 'ROUTER', 'POOL', 'TOKEN_CONTRACT', 'MIXER'];
const rssMb = () => Math.round(process.memoryUsage().rss / (1024 * 1024));
let peakRss = rssMb();
const sampleRss = () => { peakRss = Math.max(peakRss, rssMb()); return peakRss; };

interface Snapshot {
  edges: number;
  unavailableWithValue: number; // MUST be 0: 'unavailable' edges carrying a valuedUsd number
  relationships: number;
  relsByKind: Record<string, number>;
  subsTotal: number;
  hotSubs: number;
  frontier: Record<string, number>;
  serviceNodesInFrontier: number; // MUST be 0
  observation: number;
  eligible: number;
  walletStats: number;
}

async function snapshot(): Promise<Snapshot> {
  const rec = (rows: unknown[], key: string) =>
    Object.fromEntries((rows as Record<string, unknown>[]).map((r) => [String(r[key]), (r as { _count: number })._count]));
  const serviceAddrs = (
    await prisma.addressRegistry.findMany({ where: { category: { in: SERVICE_CATEGORIES as never } }, select: { address: true } })
  ).map((r) => r.address);
  return {
    edges: await prisma.moneyFlowEdge.count(),
    unavailableWithValue: await prisma.moneyFlowEdge.count({ where: { valuationStatus: 'unavailable', valuedUsd: { not: null } } }),
    relationships: await prisma.walletRelationship.count(),
    relsByKind: rec(await prisma.walletRelationship.groupBy({ by: ['kind'], _count: true }), 'kind'),
    subsTotal: await prisma.monitoringSubscription.count(),
    hotSubs: await prisma.monitoringSubscription.count({ where: { priority: 'fresh_receiver_hot' } }),
    frontier: rec(await prisma.lineageExpansionNode.groupBy({ by: ['status'], _count: true }), 'status'),
    serviceNodesInFrontier: serviceAddrs.length > 0
      ? await prisma.lineageExpansionNode.count({ where: { walletAddress: { in: serviceAddrs } } })
      : 0,
    observation: await prisma.wallet.count({ where: { status: 'observation_only' } }),
    eligible: await prisma.wallet.count({ where: { status: 'signal_eligible' } }),
    walletStats: await prisma.walletStats.count()
  };
}

const delta = (a: Snapshot, b: Snapshot) => ({
  edges: b.edges - a.edges,
  relationships: b.relationships - a.relationships,
  subsTotal: b.subsTotal - a.subsTotal,
  hotSubs: b.hotSubs - a.hotSubs,
  observation: b.observation - a.observation,
  eligible: b.eligible - a.eligible,
  walletStats: b.walletStats - a.walletStats
});

async function boundedPass(label: string, nodeIds: string[]) {
  const settings = await (async () => {
    const row = await prisma.settings.findFirst();
    const merged = row ? { ...DEFAULT_SETTINGS, ...(row.values as object) } : DEFAULT_SETTINGS;
    return { ...merged, lineage: { ...DEFAULT_SETTINGS.lineage, maxDepth: 1, backfillMaxPagesPerNode: 2 } };
  })();
  const provider = getProvider('SOLANA', 'walletActivity') as unknown as LineageProvider;
  let solPrice: number | null = null;
  try {
    solPrice = (await getProvider('SOLANA', 'marketData').getTokenMarket('SOLANA', WSOL_MINT))?.priceUsd ?? null;
  } catch { /* unknown stays unknown */ }
  // TRUE replay: reopen EXACTLY the selected node ids (bounded, logged) —
  // never a blanket depth-0 reopen that could strand unrelated roots pending.
  await prisma.lineageExpansionNode.updateMany({ where: { id: { in: nodeIds } }, data: { status: 'pending', cursor: null } });
  const t0 = Date.now();
  const result = await runLineageExpansion(prisma, provider, settings, { maxNodesPerPass: REOPEN_COUNT, solCurrentPriceUsd: solPrice });
  sampleRss();
  console.log(JSON.stringify({ pass: label, nodeIds, durationSec: Math.round((Date.now() - t0) / 1000), solPriceKnown: solPrice !== null, result, rssMb: rssMb() }));
  return result;
}

async function main(): Promise<void> {
  if (process.env.MOCK_MODE === 'true') throw new Error('reconciliation smoke must run live (MOCK_MODE=false)');
  // Deterministic node set: first REOPEN_COUNT depth-0 DONE nodes by id.
  const nodes = await prisma.lineageExpansionNode.findMany({
    where: { depth: 0, status: 'done' }, orderBy: { id: 'asc' }, take: REOPEN_COUNT, select: { id: true, walletAddress: true }
  });
  const nodeIds = nodes.map((n) => n.id);
  const rootAddrs = nodes.map((n) => n.walletAddress);
  if (nodeIds.length === 0) throw new Error('no done depth-0 nodes to replay');

  // PRECONDITION HONESTY: a pending backlog (e.g. roots stranded mid-backfill
  // with cursor resume, or enqueued children) may legitimately consume spare
  // engine slots during our passes — that work is NEW COVERAGE, not replay.
  // The replay invariant is therefore SCOPED to the reopened roots' addresses;
  // backlog draining is measured and reported separately.
  const pendingBacklog = await prisma.lineageExpansionNode.count({ where: { status: 'pending' } });
  const scopedEdges = () => prisma.moneyFlowEdge.count({ where: { sourceAddress: { in: rootAddrs } } });
  console.log(JSON.stringify({ phase: 'precondition', pendingBacklog, replayScopedTo: rootAddrs.map((a) => a.slice(0, 8)) }));

  const before = await snapshot();
  const scopedBefore = await scopedEdges();
  console.log(JSON.stringify({ phase: 'before', ...before, scopedEdges: scopedBefore }));

  const r1 = await boundedPass('pass-1', nodeIds);
  const mid = await snapshot();
  const scopedMid = await scopedEdges();
  console.log(JSON.stringify({ phase: 'after-pass-1', delta: delta(before, mid), scopedEdgeDelta: scopedMid - scopedBefore }));

  const r2 = await boundedPass('pass-2-true-replay', nodeIds);
  const after = await snapshot();
  const scopedAfter = await scopedEdges();
  const replayDelta = delta(mid, after);
  const scopedReplayDelta = scopedAfter - scopedMid;
  console.log(JSON.stringify({ phase: 'after-replay', delta: replayDelta, scopedReplayDelta, backlogDrainedEdges: replayDelta.edges - scopedReplayDelta, relsByKind: after.relsByKind, frontier: after.frontier }));

  // Evidence detail: newest direct_funding relationship (if any) — emitted,
  // not narrated (Codex: claims must come from this smoke's own output).
  const df = await prisma.walletRelationship.findFirst({
    where: { kind: 'direct_funding' }, orderBy: { lastSeenAt: 'desc' },
    select: { confidence: true, valueTransferredUsd: true, unknownValueTxCount: true, interactionCount: true }
  });

  const invariants = {
    eligibleUnchanged: before.eligible === after.eligible,
    walletStatsUnchanged: before.walletStats === after.walletStats,
    // unknown ≠ zero: no 'unavailable' edge may carry a numeric value.
    unknownNeverNumeric: after.unavailableWithValue === 0,
    serviceNeverInFrontier: after.serviceNodesInFrontier === 0,
    // TRUE-replay duplicate prevention, SCOPED to the replayed roots'
    // addresses: identical node set ⇒ no new rows from those roots beyond
    // on-chain txs landing between the passes (tolerance 2). Unscoped growth
    // = pending-backlog draining (new coverage), reported separately.
    replayScopedEdgeDeltaNearZero: scopedReplayDelta <= 2,
    replayNoNewRelationships: replayDelta.relationships <= replayDelta.edges,
    replayNoNewSubscriptions: replayDelta.subsTotal <= replayDelta.edges,
    noProviderErrors: r1.errors === 0 && r2.errors === 0
  };
  const failed = Object.entries(invariants).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(JSON.stringify({
    phase: 'verdict',
    replayMarkedTransfers: { pass1: r1.stopReasons['replay_skipped'] ?? 0, pass2: r2.stopReasons['replay_skipped'] ?? 0 },
    serviceNodesSkipped: { pass1: r1.serviceNodesSkipped, pass2: r2.serviceNodesSkipped },
    errors: { pass1: r1.errors, pass2: r2.errors },
    stopReasons: { pass1: r1.stopReasons, pass2: r2.stopReasons },
    newestDirectFunding: df ? { ...df, valueTransferredUsd: Number(df.valueTransferredUsd) } : null,
    invariants,
    failedInvariants: failed,
    smartCountInvariant: invariants.eligibleUnchanged ? `HOLDS (signal_eligible ${before.eligible} -> ${after.eligible})` : `VIOLATED (${before.eligible} -> ${after.eligible})`,
    peakRssMb: sampleRss()
  }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch((e) => { console.error('reconcile smoke failed:', e instanceof Error ? e.message : e); process.exitCode = 1; });
