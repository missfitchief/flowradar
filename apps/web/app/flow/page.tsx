import { prisma } from '@/lib/db';
import { FlowSummaryCards } from '@/components/flow/FlowSummaryCards';
import { FlowSankey } from '@/components/flow/FlowSankey';
import type { FlowSankeyLink, FlowSankeyNode } from '@/components/flow/FlowSankey';
import { RotationsTable } from '@/components/flow/RotationsTable';
import type { RotationRow } from '@/components/flow/RotationsTable';
import { ClustersTable } from '@/components/flow/ClustersTable';
import type { ClusterRow } from '@/components/flow/ClustersTable';
import { BridgeFlowsTable } from '@/components/flow/BridgeFlowsTable';
import type { BridgeFlowRow } from '@/components/flow/BridgeFlowsTable';
import { buildRotationSankey } from '@flowradar/core';
import { pairBridgeLegRows, CONFIRMED_CONFIDENCE, LOW_CONFIDENCE } from '@flowradar/db';
import type { BridgeLeg } from '@flowradar/db';

// DB-backed dashboard — must render per-request, never freeze at build time
// (same invariant every other DB page in this app follows: /, /tokens,
// /tokens/[id], /wallets, /alerts, /graph).
export const dynamic = 'force-dynamic';

function fillUrlTemplate(template: string | null | undefined, address: string): string | null {
  if (!template) return null;
  return template.replaceAll('{address}', address);
}

/**
 * Money Flow page (product brief Module 9 (Money Flow page) / plan Task 24).
 * Server component — replaces the Task-7 shell. Surfaces Wave-3 signals:
 * cross-token profit rotations (ProfitRotationSignal), entity clusters
 * (EntityCluster/EntityClusterWallet), and bridge flows (MoneyFlowEdge
 * bridge_deposit/bridge_withdrawal pairs), plus a Sankey built from the
 * top rotation's chain via @flowradar/core's buildRotationSankey.
 *
 * Query shape: independent fetches in one Promise.all —
 *   1. Chain rows (2: SOLANA/BSC) -> explorer URL templates, keyed by ChainId.
 *   2. ProfitRotationSignal.findMany, include sourceWallet/destWallet/
 *      sourceToken/destToken -> table A + summary cards + Sankey source.
 *   3. EntityCluster.findMany, include wallets (+ nested wallet) and trades
 *      (WalletTokenTrade rows stamped with this cluster's id, include token
 *      for symbol) -> table B, derived tokensTraded/recentBuys/recentExits,
 *      AND the Sankey's Cluster-node lookup (which cluster, if any, a given
 *      wallet address belongs to).
 *   4. MoneyFlowEdge.findMany where actionType in bridge_deposit/withdrawal
 *      -> table C, paired via @flowradar/db's pairBridgeLegRows (the SAME
 *      pure helper packages/db/src/bridgeFlow.ts's runBridgeFlow job wraps
 *      for its DB-writing pass — no reimplemented pairing logic here anymore)
 *      WITHOUT writing back to the DB (this page only reads); displayed
 *      confidence uses the canonical CONFIRMED_CONFIDENCE(95)/LOW_CONFIDENCE(35)
 *      constants, not each leg's raw per-ingest confidence (always 100 and
 *      meaningless for "was this leg matched").
 * Plus one follow-up fetch for the top-funder summary card (MoneyFlowEdge
 * `transfer` rows, small table, aggregated in-memory).
 *
 * Every Prisma.Decimal is converted via Number(...) at this query boundary;
 * FlowSankey (a 'use client' component) receives plain name/category/value
 * data only (no Decimal/Date at all — Sankey data carries no timestamps).
 */
export default async function MoneyFlowPage() {
  const [chains, rotations, clusters, bridgeEdges, transferEdges] = await Promise.all([
    prisma.chain.findMany(),
    prisma.profitRotationSignal.findMany({
      orderBy: { realizedProfitUsd: 'desc' },
      include: { sourceWallet: true, destWallet: true, sourceToken: true, destToken: true },
    }),
    prisma.entityCluster.findMany({
      orderBy: { walletCount: 'desc' },
      include: {
        wallets: { include: { wallet: true } },
        trades: { include: { token: true } },
      },
    }),
    prisma.moneyFlowEdge.findMany({
      where: { actionType: { in: ['bridge_deposit', 'bridge_withdrawal'] } },
      orderBy: { ts: 'desc' },
    }),
    prisma.moneyFlowEdge.findMany({
      where: { actionType: 'transfer' },
      select: { sourceAddress: true, destinationAddress: true, amountUsd: true },
    }),
  ]);

  const explorerUrlByChain = new Map(chains.map((c) => [c.id, c.explorerAddressUrl]));

  // -----------------------------------------------------------------------
  // Table A: Suspicious Rotations
  // -----------------------------------------------------------------------
  const rotationRows: RotationRow[] = rotations.map((r) => ({
    id: r.id,
    sourceWalletAddress: r.sourceWallet.address,
    sourceWalletExplorerUrl: fillUrlTemplate(explorerUrlByChain.get(r.sourceWallet.chain), r.sourceWallet.address),
    destWalletAddress: r.destWallet.address,
    destWalletExplorerUrl: fillUrlTemplate(explorerUrlByChain.get(r.destWallet.chain), r.destWallet.address),
    sourceTokenId: r.sourceTokenId,
    sourceTokenSymbol: r.sourceToken.symbol,
    destTokenId: r.destTokenId,
    destTokenSymbol: r.destToken.symbol,
    realizedProfitUsd: Number(r.realizedProfitUsd),
    transferredValueUsd: Number(r.transferredValueUsd),
    chainPath: r.chainPath,
    timeGapMin: r.timeGapMin,
    confidence: r.confidence,
    currentDestPerfPct: r.currentDestPerfPct,
  }));

  // -----------------------------------------------------------------------
  // Table B: Entity Clusters
  // -----------------------------------------------------------------------
  const largestClusterId = clusters[0]?.id ?? null;
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60_000;

  const clusterRows: ClusterRow[] = clusters.map((c) => {
    const distinctTokenIds = new Set(c.trades.map((t) => t.tokenId));
    const recentTrades = c.trades.filter((t) => now - t.ts.getTime() <= DAY_MS);
    const recentBuys24h = recentTrades.filter((t) => t.action === 'BUY').length;
    const recentExits24h = recentTrades.filter((t) => t.action === 'SELL').length;

    return {
      id: c.id,
      walletCount: c.walletCount,
      total30dPnlUsd: Number(c.total30dPnlUsd),
      chains: c.chains,
      tokensTraded: distinctTokenIds.size,
      confidence: c.confidence,
      mainFundingSource: c.mainFundingSource,
      recentBuys24h,
      recentExits24h,
      isLargest: c.id === largestClusterId,
    };
  });

  // -----------------------------------------------------------------------
  // Table C: Bridge Flows — read-only pairing via @flowradar/db's
  // pairBridgeLegRows, the SAME pure helper packages/db/src/bridgeFlow.ts's
  // runBridgeFlow job wraps for its DB-writing pass (no reimplemented
  // pairing logic here). Displayed confidence uses the canonical
  // CONFIRMED_CONFIDENCE/LOW_CONFIDENCE constants rather than each leg's raw
  // per-ingest confidence (always 100, meaningless for match status).
  // -----------------------------------------------------------------------
  const edgeById = new Map(bridgeEdges.map((e) => [e.id, e]));
  const toBridgeLeg = (e: (typeof bridgeEdges)[number]): BridgeLeg => ({
    id: e.id,
    sourceAddress: e.sourceAddress,
    destinationAddress: e.destinationAddress,
    asset: e.asset,
    amountUsd: Number(e.amountUsd),
    ts: e.ts,
    bridgeProtocol: e.bridgeProtocol,
  });
  const depositLegs = bridgeEdges.filter((e) => e.actionType === 'bridge_deposit').map(toBridgeLeg);
  const withdrawalLegs = bridgeEdges.filter((e) => e.actionType === 'bridge_withdrawal').map(toBridgeLeg);

  const { matched, unmatched } = pairBridgeLegRows(depositLegs, withdrawalLegs);

  const bridgeRows: BridgeFlowRow[] = [];

  for (const { deposit, withdrawal } of matched) {
    const dep = edgeById.get(deposit.id)!;
    const wd = edgeById.get(withdrawal.id)!;
    bridgeRows.push({
      id: `${dep.id}:${wd.id}`,
      sourceChain: dep.sourceChain,
      destChain: wd.destinationChain,
      sourceAddress: dep.sourceAddress,
      destAddress: wd.destinationAddress,
      asset: dep.asset,
      amountUsd: Number(dep.amountUsd),
      bridgeProtocol: dep.bridgeProtocol ?? 'unknown',
      ts: dep.ts.toISOString(),
      confidence: CONFIRMED_CONFIDENCE,
      matched: true,
    });
  }
  // `direction` (deposit/withdrawal) only affects the persisted `reason`
  // string runBridgeFlow writes to metadata; this read-only table doesn't
  // surface it, so it's intentionally unused here.
  for (const { leg } of unmatched) {
    const e = edgeById.get(leg.id)!;
    bridgeRows.push({
      id: e.id,
      sourceChain: e.sourceChain,
      destChain: e.destinationChain,
      sourceAddress: e.sourceAddress,
      destAddress: e.destinationAddress,
      asset: e.asset,
      amountUsd: Number(e.amountUsd),
      bridgeProtocol: e.bridgeProtocol ?? 'unknown',
      ts: e.ts.toISOString(),
      confidence: LOW_CONFIDENCE,
      matched: false,
    });
  }

  // -----------------------------------------------------------------------
  // Sankey: Token(source) -> Cluster|Wallet(source) -> Bridge -> Wallet(dest)
  // -> Token(dest), built from the top rotation by transferredValueUsd via
  // @flowradar/core's buildRotationSankey (the seeded $ALPHA -> $BETA
  // scenario's source wallet is unclustered, so it hits the Wallet fallback
  // branch — see buildRotationSankey's own header/tests for the Cluster
  // branch proof). Guarded empty if no rotations exist.
  // -----------------------------------------------------------------------
  // Cluster-membership lookup (walletId -> {id, walletCount}), used to decide
  // whether the Sankey's source-side second hop is a Cluster or Wallet node.
  const clusterByWalletId = new Map<string, { id: string; walletCount: number }>();
  for (const c of clusters) {
    for (const ecw of c.wallets) {
      clusterByWalletId.set(ecw.walletId, { id: c.id, walletCount: c.walletCount });
    }
  }

  let sankeyNodes: FlowSankeyNode[] = [];
  let sankeyLinks: FlowSankeyLink[] = [];
  const topRotation = [...rotations].sort((a, b) => Number(b.transferredValueUsd) - Number(a.transferredValueUsd))[0];

  if (topRotation) {
    const sankeyData = buildRotationSankey({
      sourceTokenSymbol: topRotation.sourceToken.symbol,
      sourceWalletAddress: topRotation.sourceWallet.address,
      sourceWalletCluster: clusterByWalletId.get(topRotation.sourceWallet.id) ?? null,
      destWalletAddress: topRotation.destWallet.address,
      destTokenSymbol: topRotation.destToken.symbol,
      bridgeName: 'Bridge (Wormhole)',
      realizedProfitUsd: Number(topRotation.realizedProfitUsd),
      transferredValueUsd: Number(topRotation.transferredValueUsd),
    });
    sankeyNodes = sankeyData.nodes;
    sankeyLinks = sankeyData.links;
  }

  // -----------------------------------------------------------------------
  // Summary cards
  // -----------------------------------------------------------------------
  const sortedByProfit = [...rotations].sort((a, b) => Number(b.realizedProfitUsd) - Number(a.realizedProfitUsd));
  const sortedByTransferred = [...rotations].sort(
    (a, b) => Number(b.transferredValueUsd) - Number(a.transferredValueUsd),
  );

  const topExit = sortedByProfit[0];
  const topLanding = sortedByTransferred[0];
  // "Fresh-wallet entry" proxy: same rotation set's dest-side buy, ranked by
  // the dest wallet's post-rotation performance (currentDestPerfPct) as a
  // stand-in for "how fresh/successful this entry turned out to be" —
  // documented in FlowSummaryCards as a proxy metric (no dedicated Rule-E
  // "funded then bought within N minutes" feed is queried by this page).
  const sortedByDestPerf = [...rotations].sort((a, b) => b.currentDestPerfPct - a.currentDestPerfPct);
  const topFreshEntry = sortedByDestPerf[0];

  // Top funder proxy: MoneyFlowEdge `transfer` rows grouped by sourceAddress,
  // ranked by out-degree (count of distinct outbound transfers) — a simple
  // proxy for "funds many other wallets", not a full funding-graph traversal.
  const funderAgg = new Map<string, { outDegree: number; totalSentUsd: number }>();
  for (const e of transferEdges) {
    let agg = funderAgg.get(e.sourceAddress);
    if (!agg) {
      agg = { outDegree: 0, totalSentUsd: 0 };
      funderAgg.set(e.sourceAddress, agg);
    }
    agg.outDegree += 1;
    agg.totalSentUsd += Number(e.amountUsd);
  }
  const topFunderEntry = [...funderAgg.entries()].sort((a, b) => b[1].outDegree - a[1].outDegree)[0];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Money Flow</h1>
        <p className="mt-2 text-sm text-muted-foreground">Capital rotation, entity clusters &amp; bridge movement</p>
      </div>

      <FlowSummaryCards
        biggestExit={
          topExit
            ? {
                walletAddress: topExit.sourceWallet.address,
                tokenSymbol: topExit.sourceToken.symbol,
                realizedProfitUsd: Number(topExit.realizedProfitUsd),
              }
            : null
        }
        biggestLanding={
          topLanding
            ? {
                walletAddress: topLanding.destWallet.address,
                tokenSymbol: topLanding.destToken.symbol,
                transferredValueUsd: Number(topLanding.transferredValueUsd),
              }
            : null
        }
        biggestFreshEntry={
          topFreshEntry
            ? {
                walletAddress: topFreshEntry.destWallet.address,
                tokenSymbol: topFreshEntry.destToken.symbol,
                transferredValueUsd: Number(topFreshEntry.transferredValueUsd),
              }
            : null
        }
        topFunder={
          topFunderEntry
            ? {
                address: topFunderEntry[0],
                outDegree: topFunderEntry[1].outDegree,
                totalSentUsd: topFunderEntry[1].totalSentUsd,
              }
            : null
        }
      />

      <div>
        <h2 className="mb-3 text-lg font-medium tracking-tight">Capital rotation flow</h2>
        <div className="rounded-lg border border-border p-4">
          <FlowSankey nodes={sankeyNodes} links={sankeyLinks} />
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-medium tracking-tight">Suspicious rotations</h2>
        <RotationsTable rows={rotationRows} />
      </div>

      <div>
        <h2 className="mb-3 text-lg font-medium tracking-tight">Entity clusters</h2>
        <ClustersTable rows={clusterRows} />
      </div>

      <div>
        <h2 className="mb-3 text-lg font-medium tracking-tight">Bridge flows</h2>
        <BridgeFlowsTable rows={bridgeRows} />
      </div>
    </div>
  );
}
