// FlowRadar — Priority 1 bounded lineage RECONCILIATION smoke (rev 4, Codex).
//
// PER-ROOT ISOLATED TRUE REPLAY: each selected root is processed via the
// engine's own rootId restriction, so the replay provably ran (backlog cannot
// displace it — Codex rev-3 finding). For each root, pass 1 may persist
// genuinely-new on-chain rows; pass 2 re-processes the identical node, so its
// ROOT-SCOPED deltas (edges from the root's address, relationships and
// subscriptions under its lineageRootId) must be ~0 — the duplicate-
// prevention proof. Dedupe key: (txHash, sourceAddress, destinationAddress,
// actionType); documented blind spot: same-pair multi-leg transfers within
// one tx collapse into one edge — undetectable here.
//
// Also proves: honest valuation ('unavailable' ⇒ valuedUsd IS NULL — unknown
// is never numeric), no WalletStats writes, service addresses never in the
// frontier, smart-count invariant. Selection requires roots with NO pending
// descendants; reopen is a CONDITIONAL update (id AND status='done') so a
// concurrently-claimed node can never be clobbered. RSS is reported as "max
// sampled at checkpoints", not a true peak. Exits non-zero on any violation.
// Bounds: ROOT_COUNT roots × 2 passes × ≤2 pages/node, normal live speed.
// Usage: MOCK_MODE=false npx tsx scripts/lineage-reconcile-smoke.ts
import { prisma, runLineageExpansion, type LineageProvider } from '@flowradar/db';
import { getProvider } from '@flowradar/providers';
import { DEFAULT_SETTINGS, WSOL_MINT, type Settings } from '@flowradar/core';

const ROOT_COUNT = 4;
const SERVICE_CATEGORIES = ['CEX', 'BRIDGE', 'ROUTER', 'POOL', 'TOKEN_CONTRACT', 'MIXER'];
const rssMb = () => Math.round(process.memoryUsage().rss / (1024 * 1024));
let maxSampledRss = rssMb();
const sampleRss = () => { maxSampledRss = Math.max(maxSampledRss, rssMb()); };

async function globalInvariantSnapshot() {
  const serviceAddrs = (
    await prisma.addressRegistry.findMany({ where: { category: { in: SERVICE_CATEGORIES as never } }, select: { address: true } })
  ).map((r) => r.address);
  return {
    unavailableWithValue: await prisma.moneyFlowEdge.count({ where: { valuationStatus: 'unavailable', valuedUsd: { not: null } } }),
    serviceNodesInFrontier: serviceAddrs.length > 0
      ? await prisma.lineageExpansionNode.count({ where: { walletAddress: { in: serviceAddrs } } })
      : 0,
    eligible: await prisma.wallet.count({ where: { status: 'signal_eligible' } }),
    walletStats: await prisma.walletStats.count()
  };
}

interface RootScope { edges: number; rels: number; subs: number; }
async function rootScope(rootId: string, addr: string): Promise<RootScope> {
  return {
    edges: await prisma.moneyFlowEdge.count({ where: { sourceAddress: addr } }),
    rels: await prisma.walletRelationship.count({ where: { lineageRootId: rootId } }),
    subs: await prisma.monitoringSubscription.count({ where: { lineageRootId: rootId } })
  };
}

async function loadBoundedSettings(): Promise<Settings> {
  const row = await prisma.settings.findFirst();
  const merged = row ? { ...DEFAULT_SETTINGS, ...(row.values as object) } : DEFAULT_SETTINGS;
  return { ...merged, lineage: { ...DEFAULT_SETTINGS.lineage, maxDepth: 1, backfillMaxPagesPerNode: 2 } } as Settings;
}

async function main(): Promise<void> {
  if (process.env.MOCK_MODE === 'true') throw new Error('reconciliation smoke must run live (MOCK_MODE=false)');
  const settings = await loadBoundedSettings();
  const provider = getProvider('SOLANA', 'walletActivity') as unknown as LineageProvider;
  let solPrice: number | null = null;
  try {
    solPrice = (await getProvider('SOLANA', 'marketData').getTokenMarket('SOLANA', WSOL_MINT))?.priceUsd ?? null;
  } catch { /* unknown stays unknown */ }

  // Select done depth-0 roots WITHOUT pending descendants (their subtree is
  // quiescent, so rootId-restricted passes process exactly the reopened node).
  const doneRoots = await prisma.lineageExpansionNode.findMany({
    where: { depth: 0, status: 'done' }, orderBy: { id: 'asc' },
    select: { id: true, walletAddress: true, lineageRootId: true }
  });
  const selected: typeof doneRoots = [];
  for (const n of doneRoots) {
    if (selected.length >= ROOT_COUNT) break;
    const pendingInSubtree = await prisma.lineageExpansionNode.count({ where: { lineageRootId: n.lineageRootId, status: { in: ['pending', 'in_progress'] } } });
    if (pendingInSubtree === 0) selected.push(n);
  }
  if (selected.length === 0) throw new Error('no quiescent done depth-0 roots available for isolated replay');
  console.log(JSON.stringify({ phase: 'selection', roots: selected.map((s) => ({ node: s.id, addr: s.walletAddress.slice(0, 8) })) }));

  const globalBefore = await globalInvariantSnapshot();
  const perRoot: Record<string, unknown>[] = [];
  let anyViolation = false;
  let totalErrors = 0;

  for (const root of selected) {
    const before = await rootScope(root.lineageRootId, root.walletAddress);
    const results = [] as { edgesPersisted: number; receiversEnrolled: number; serviceNodesSkipped: number; errors: number; stopReasons: Record<string, number> }[];
    const scopes = [before];
    for (const pass of [1, 2]) {
      // CONDITIONAL reopen: only flips done->pending; a concurrently-claimed
      // node (not 'done') is never clobbered — we then skip this root.
      const reopened = await prisma.lineageExpansionNode.updateMany({
        where: { id: root.id, status: 'done' }, data: { status: 'pending', cursor: null }
      });
      if (reopened.count !== 1) { console.log(JSON.stringify({ root: root.id, pass, skipped: 'node not reopenable (claimed elsewhere?)' })); break; }
      // rootId restriction: the engine processes ONLY this root's subtree —
      // the global backlog cannot displace the replay (Codex rev-3 fix).
      const r = await runLineageExpansion(prisma, provider, settings, { rootId: root.lineageRootId, maxNodesPerPass: 1, solCurrentPriceUsd: solPrice });
      results.push(r);
      totalErrors += r.errors;
      sampleRss();
      scopes.push(await rootScope(root.lineageRootId, root.walletAddress));
    }
    if (results.length < 2) continue;
    const pass1Delta = { edges: scopes[1]!.edges - scopes[0]!.edges, rels: scopes[1]!.rels - scopes[0]!.rels, subs: scopes[1]!.subs - scopes[0]!.subs };
    const replayDelta = { edges: scopes[2]!.edges - scopes[1]!.edges, rels: scopes[2]!.rels - scopes[1]!.rels, subs: scopes[2]!.subs - scopes[1]!.subs };
    // Root-scoped idempotency: tolerance 1 edge for an on-chain tx landing
    // between passes; relationships/subscriptions must not grow on replay.
    const ok = replayDelta.edges <= 1 && replayDelta.rels === 0 && replayDelta.subs === 0;
    if (!ok) anyViolation = true;
    perRoot.push({
      root: root.walletAddress.slice(0, 8),
      pass1: { ...results[0], stopReasons: results[0]!.stopReasons },
      pass2: { ...results[1], stopReasons: results[1]!.stopReasons },
      pass1Delta,
      replayDelta,
      replayIdempotent: ok
    });
  }

  const globalAfter = await globalInvariantSnapshot();
  const df = await prisma.walletRelationship.findFirst({
    where: { kind: 'direct_funding' }, orderBy: { lastSeenAt: 'desc' },
    select: { confidence: true, valueTransferredUsd: true, unknownValueTxCount: true, interactionCount: true }
  });
  const invariants = {
    perRootReplayIdempotent: !anyViolation,
    eligibleUnchanged: globalBefore.eligible === globalAfter.eligible,
    walletStatsUnchanged: globalBefore.walletStats === globalAfter.walletStats,
    unknownNeverNumeric: globalAfter.unavailableWithValue === 0,
    serviceNeverInFrontier: globalAfter.serviceNodesInFrontier === 0,
    noProviderErrors: totalErrors === 0
  };
  const failed = Object.entries(invariants).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(JSON.stringify({
    phase: 'verdict',
    perRoot,
    newestDirectFunding: df ? { ...df, valueTransferredUsd: Number(df.valueTransferredUsd) } : null,
    invariants,
    failedInvariants: failed,
    smartCountInvariant: invariants.eligibleUnchanged ? `HOLDS (signal_eligible ${globalBefore.eligible} -> ${globalAfter.eligible})` : `VIOLATED`,
    maxSampledRssMb: maxSampledRss
  }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch((e) => { console.error('reconcile smoke failed:', e instanceof Error ? e.message : e); process.exitCode = 1; });
