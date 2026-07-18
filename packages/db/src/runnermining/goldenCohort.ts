// FlowRadar — golden cohort selection (product-rescue sprint).
//
// Deterministic PRODUCT-VALIDATION cohort from the existing historical
// universe — the tokens/wallets with the strongest honest coverage, each
// with persisted selection receipts. NOT a replacement for the full
// resumable universe (that remains token_lifecycles / top-PnL discovery).

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';

export const GOLDEN_COHORT_ENGINE_VERSION = 1;

export interface GoldenCohortReport {
  tokens: number;
  wallets: number;
  controls: number;
  wiped: number;
}

export async function buildGoldenCohort(
  prisma: PrismaClient,
  opts: { chain?: 'SOLANA' | 'BSC'; tokenCount?: number; walletCount?: number; controlCount?: number; now?: Date } = {}
): Promise<GoldenCohortReport> {
  const chain = opts.chain ?? 'SOLANA';
  const tokenCount = opts.tokenCount ?? 20;
  const walletCount = opts.walletCount ?? 20;
  const controlCount = opts.controlCount ?? 20;
  const now = opts.now ?? new Date();

  // Deterministic rebuild — computed FIRST, then swapped in atomically so a
  // mid-build failure can never leave a partial/empty cohort.
  const pending: Prisma.GoldenCohortMemberCreateManyInput[] = [];

  // --- Tokens: verified runners ranked by honest local+provider coverage ---
  const runners = await prisma.tokenLifecycle.findMany({
    where: { runnerClass: 'verified_above_10m' },
    orderBy: { mint: 'asc' },
    take: 2000,
    select: { mint: true }
  });
  const runnerMints = runners.map((r) => r.mint);
  const enrichments = await prisma.tokenEnrichment.findMany({
    where: { mint: { in: runnerMints }, status: 'enriched' },
    select: { mint: true, candleCount: true }
  });
  const candleCountOf = new Map(enrichments.map((e) => [e.mint, e.candleCount]));
  const tokens = await prisma.token.findMany({
    where: { chain, address: { in: runnerMints } },
    select: { id: true, address: true }
  });
  const tokenIdOf = new Map(tokens.map((t) => [t.address, t.id]));

  const tokenMetrics: {
    mint: string;
    pricedBuys: number;
    pricedTrades: number;
    totalTrades: number;
    candleCount: number;
    snapshots: number;
  }[] = [];
  for (const mint of runnerMints) {
    const tokenId = tokenIdOf.get(mint);
    if (!tokenId) continue;
    const candleCount = candleCountOf.get(mint) ?? 0;
    const [pricedBuys, priced, total, snapshots] = await Promise.all([
      prisma.walletTokenTrade.count({ where: { tokenId, chain, action: 'BUY', amountUsd: { gt: 0 } } }),
      prisma.walletTokenTrade.count({ where: { tokenId, chain, amountUsd: { gt: 0 } } }),
      prisma.walletTokenTrade.count({ where: { tokenId, chain } }),
      prisma.tokenMarketSnapshot.count({ where: { tokenId } })
    ]);
    // Replay needs PRICED BUY events (signal walk) AND a price series
    // (outcome) — candles or local snapshots both qualify.
    if (pricedBuys === 0) continue;
    if (candleCount === 0 && snapshots === 0) continue;
    tokenMetrics.push({ mint, pricedBuys, pricedTrades: priced, totalTrades: total, candleCount, snapshots });
  }
  tokenMetrics.sort(
    (a, b) =>
      b.pricedBuys - a.pricedBuys ||
      b.pricedTrades - a.pricedTrades ||
      b.candleCount - a.candleCount ||
      (a.mint < b.mint ? -1 : 1)
  );
  const selectedTokens = tokenMetrics.slice(0, tokenCount);
  for (const [i, t] of selectedTokens.entries()) {
    pending.push({
        chain,
        kind: 'token',
        key: t.mint,
        rank: i + 1,
        selectionMetricsJson: t as unknown as Prisma.InputJsonValue,
        reasonCodes: ['verified_above_10m', 'enriched_price_series', `priced_trades:${t.pricedTrades}`, `total_trades:${t.totalTrades}`],
        engineVersion: GOLDEN_COHORT_ENGINE_VERSION,
        selectedAt: now
      });
  }

  // --- Wallets: local-evidence discovered wallets ranked by priced coverage --
  const discovered = await prisma.tokenTopPnlCandidate.findMany({
    where: { chain, validation: { notIn: ['provider_only', 'invalid'] } },
    orderBy: { walletAddress: 'asc' },
    select: { walletAddress: true },
    distinct: ['walletAddress'],
    take: 2000
  });
  const walletMetrics: { address: string; pricedTrades: number; totalTrades: number; pricedSells: number }[] = [];
  for (const d of discovered) {
    const w = await prisma.wallet.findUnique({
      where: { address_chain: { address: d.walletAddress, chain } },
      select: { id: true }
    });
    if (!w) continue;
    const [priced, total, pricedSells] = await Promise.all([
      prisma.walletTokenTrade.count({ where: { walletId: w.id, chain, amountUsd: { gt: 0 } } }),
      prisma.walletTokenTrade.count({ where: { walletId: w.id, chain } }),
      prisma.walletTokenTrade.count({ where: { walletId: w.id, chain, action: 'SELL', amountUsd: { gt: 0 } } })
    ]);
    walletMetrics.push({ address: d.walletAddress, pricedTrades: priced, totalTrades: total, pricedSells });
  }
  walletMetrics.sort(
    (a, b) => b.pricedTrades - a.pricedTrades || b.pricedSells - a.pricedSells || b.totalTrades - a.totalTrades || (a.address < b.address ? -1 : 1)
  );
  const selectedWallets = walletMetrics.slice(0, walletCount);
  for (const [i, w] of selectedWallets.entries()) {
    pending.push({
        chain,
        kind: 'wallet',
        key: w.address,
        rank: i + 1,
        selectionMetricsJson: w as unknown as Prisma.InputJsonValue,
        reasonCodes: ['local_top_pnl_evidence', `priced_trades:${w.pricedTrades}`, `priced_sells:${w.pricedSells}`],
        engineVersion: GOLDEN_COHORT_ENGINE_VERSION,
        selectedAt: now
      });
  }

  // --- Controls: matched controls of the selected tokens, with local trades --
  const matches = await prisma.cohortMatch.findMany({
    where: { runnerMint: { in: selectedTokens.map((t) => t.mint) } },
    orderBy: [{ runnerMint: 'asc' }, { controlMint: 'asc' }],
    take: 2000,
    select: { runnerMint: true, controlMint: true, tier: true }
  });
  let controlRank = 0;
  const seenControls = new Set<string>();
  for (const m of matches) {
    if (controlRank >= controlCount) break;
    if (m.controlMint === null || seenControls.has(m.controlMint)) continue;
    const tokenId = tokenIdOf.get(m.controlMint) ?? (
      await prisma.token.findUnique({ where: { chain_address: { chain, address: m.controlMint } }, select: { id: true } })
    )?.id;
    if (!tokenId) continue;
    const total = await prisma.walletTokenTrade.count({ where: { tokenId, chain } });
    if (total === 0) continue;
    seenControls.add(m.controlMint);
    controlRank += 1;
    pending.push({
        chain,
        kind: 'control_token',
        key: m.controlMint,
        rank: controlRank,
        selectionMetricsJson: { matchedRunner: m.runnerMint, tier: m.tier, totalTrades: total } as unknown as Prisma.InputJsonValue,
        reasonCodes: ['matched_control_of_selected_runner', `tier:${m.tier}`],
        engineVersion: GOLDEN_COHORT_ENGINE_VERSION,
        selectedAt: now
      });
  }

  // Atomic swap: wipe + insert in ONE transaction.
  const [wipedRes] = await prisma.$transaction([
    prisma.goldenCohortMember.deleteMany({ where: { chain } }),
    prisma.goldenCohortMember.createMany({ data: pending })
  ]);
  return { tokens: selectedTokens.length, wallets: selectedWallets.length, controls: controlRank, wiped: wipedRes.count };
}
