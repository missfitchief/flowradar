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

// DB-backed dashboard — must render per-request, never freeze at build time
// (same invariant every other DB page in this app follows: /, /tokens,
// /tokens/[id], /wallets, /alerts, /graph).
export const dynamic = 'force-dynamic';

const BRIDGE_MATCH_WINDOW_MS = 60 * 60_000; // 60 minutes — mirrors packages/db/src/bridgeFlow.ts's own window
const MIN_AMOUNT_MATCH_PCT = 95;
const MAX_AMOUNT_MATCH_PCT = 105;

function fillUrlTemplate(template: string | null | undefined, address: string): string | null {
  if (!template) return null;
  return template.replaceAll('{address}', address);
}

/**
 * Money Flow page (Task 24). Server component — replaces the Task-7 shell.
 * Surfaces Wave-3 signals: cross-token profit rotations (ProfitRotationSignal),
 * entity clusters (EntityCluster/EntityClusterWallet), and bridge flows
 * (MoneyFlowEdge bridge_deposit/bridge_withdrawal pairs), plus a Sankey built
 * from the seeded $ALPHA -> $BETA rotation chain.
 *
 * Query shape: independent fetches in one Promise.all —
 *   1. Chain rows (2: SOLANA/BSC) -> explorer URL templates, keyed by ChainId.
 *   2. ProfitRotationSignal.findMany, include sourceWallet/destWallet/
 *      sourceToken/destToken -> table A + summary cards + Sankey source.
 *   3. EntityCluster.findMany, include wallets (+ nested wallet) and trades
 *      (WalletTokenTrade rows stamped with this cluster's id, include token
 *      for symbol) -> table B, derived tokensTraded/recentBuys/recentExits.
 *   4. MoneyFlowEdge.findMany where actionType in bridge_deposit/withdrawal
 *      -> table C, paired read-only in-memory (mirrors bridgeFlow.ts's
 *      tolerance: same asset+protocol, amount ratio 95-105%, time gap <60min,
 *      closest-ratio-first greedy) WITHOUT writing back to the DB (this page
 *      only reads).
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
  // Table C: Bridge Flows — read-only pairing (deposit <-> withdrawal),
  // mirrors packages/db/src/bridgeFlow.ts's tolerance without writing back.
  // -----------------------------------------------------------------------
  const deposits = bridgeEdges.filter((e) => e.actionType === 'bridge_deposit');
  const withdrawals = bridgeEdges.filter((e) => e.actionType === 'bridge_withdrawal');

  interface Candidate {
    depositIdx: number;
    withdrawalIdx: number;
    ratio: number;
  }
  const candidates: Candidate[] = [];
  for (let di = 0; di < deposits.length; di++) {
    const dep = deposits[di]!;
    const depUsd = Number(dep.amountUsd);
    if (depUsd <= 0) continue;
    for (let wi = 0; wi < withdrawals.length; wi++) {
      const wd = withdrawals[wi]!;
      const wdUsd = Number(wd.amountUsd);
      if (wdUsd <= 0) continue;
      if (dep.asset !== wd.asset) continue;
      if ((dep.bridgeProtocol ?? null) !== (wd.bridgeProtocol ?? null)) continue;
      const timeDiff = Math.abs(wd.ts.getTime() - dep.ts.getTime());
      if (timeDiff > BRIDGE_MATCH_WINDOW_MS) continue;
      const matchPct = (Math.min(depUsd, wdUsd) / Math.max(depUsd, wdUsd)) * 100;
      if (matchPct < MIN_AMOUNT_MATCH_PCT || matchPct > MAX_AMOUNT_MATCH_PCT) continue;
      candidates.push({ depositIdx: di, withdrawalIdx: wi, ratio: matchPct });
    }
  }
  candidates.sort((a, b) => b.ratio - a.ratio);

  const usedDeposits = new Set<number>();
  const usedWithdrawals = new Set<number>();
  const bridgeRows: BridgeFlowRow[] = [];

  for (const c of candidates) {
    if (usedDeposits.has(c.depositIdx) || usedWithdrawals.has(c.withdrawalIdx)) continue;
    usedDeposits.add(c.depositIdx);
    usedWithdrawals.add(c.withdrawalIdx);
    const dep = deposits[c.depositIdx]!;
    const wd = withdrawals[c.withdrawalIdx]!;
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
      confidence: Math.max(dep.confidence, wd.confidence),
      matched: true,
    });
  }
  for (let di = 0; di < deposits.length; di++) {
    if (usedDeposits.has(di)) continue;
    const dep = deposits[di]!;
    bridgeRows.push({
      id: dep.id,
      sourceChain: dep.sourceChain,
      destChain: dep.destinationChain,
      sourceAddress: dep.sourceAddress,
      destAddress: dep.destinationAddress,
      asset: dep.asset,
      amountUsd: Number(dep.amountUsd),
      bridgeProtocol: dep.bridgeProtocol ?? 'unknown',
      ts: dep.ts.toISOString(),
      confidence: dep.confidence,
      matched: false,
    });
  }
  for (let wi = 0; wi < withdrawals.length; wi++) {
    if (usedWithdrawals.has(wi)) continue;
    const wd = withdrawals[wi]!;
    bridgeRows.push({
      id: wd.id,
      sourceChain: wd.sourceChain,
      destChain: wd.destinationChain,
      sourceAddress: wd.sourceAddress,
      destAddress: wd.destinationAddress,
      asset: wd.asset,
      amountUsd: Number(wd.amountUsd),
      bridgeProtocol: wd.bridgeProtocol ?? 'unknown',
      ts: wd.ts.toISOString(),
      confidence: wd.confidence,
      matched: false,
    });
  }

  // -----------------------------------------------------------------------
  // Sankey: Token(source) -> source wallet -> Bridge -> dest wallet ->
  // Token(dest), built from the top rotation by transferredValueUsd (the
  // seeded $ALPHA -> $BETA scenario). Guarded empty if no rotations exist.
  // -----------------------------------------------------------------------
  const sankeyNodes: FlowSankeyNode[] = [];
  const sankeyLinks: FlowSankeyLink[] = [];
  const topRotation = [...rotations].sort((a, b) => Number(b.transferredValueUsd) - Number(a.transferredValueUsd))[0];

  if (topRotation) {
    const sourceTokenName = `$${topRotation.sourceToken.symbol}`;
    const sourceWalletName = `Wallet ${topRotation.sourceWallet.address.slice(0, 6)}`;
    const bridgeName = 'Bridge (Wormhole)';
    const destWalletName = `Wallet ${topRotation.destWallet.address.slice(0, 6)}`;
    const destTokenName = `$${topRotation.destToken.symbol}`;

    sankeyNodes.push(
      { name: sourceTokenName, category: 'token' },
      { name: sourceWalletName, category: 'wallet' },
      { name: bridgeName, category: 'bridge' },
      { name: destWalletName, category: 'wallet' },
      { name: destTokenName, category: 'token' },
    );

    const realizedProfit = Number(topRotation.realizedProfitUsd);
    const transferredValue = Number(topRotation.transferredValueUsd);

    sankeyLinks.push(
      { source: sourceTokenName, target: sourceWalletName, value: realizedProfit },
      { source: sourceWalletName, target: bridgeName, value: transferredValue },
      { source: bridgeName, target: destWalletName, value: transferredValue },
      { source: destWalletName, target: destTokenName, value: transferredValue },
    );
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
