// FlowRadar — runWalletStatsRefresh: recomputes WalletStats for wallets whose
// PnL figures aren't CSV-authoritative (plan Task 30 binding decision 1).
//
// CSV import (packages/db/src/csv/importWalletsCsv.ts) is Layer-1
// authoritative per its own file header ("pnlConfidence 85, matching the
// 'high confidence, CSV is source of truth' framing in spec §6") — a human
// operator vetted those figures before import. This pass must NEVER
// overwrite/clobber a wallet whose LATEST WalletStats row (by computedAt) has
// source='csv'; those wallets are skipped entirely, every pass, forever
// (until a future task explicitly revisits the CSV-authority contract). This
// is the load-bearing anti-clobber guarantee this module exists to protect —
// see the "skip csv" test in test/walletStatsRefresh.test.ts.
//
// For every OTHER wallet that has >=1 WalletTokenTrade:
//   1. Group that wallet's trades by tokenId.
//   2. Per token, run @flowradar/core's computeFifoPnl against that token's
//      trade ledger. currentPriceUsd resolution order: latest
//      TokenMarketSnapshot.priceUsd for the token, else the latest trade's
//      own priceUsd (last-trade-price fallback), else null (computeFifoPnl
//      already prices this into its own confidence penalty).
//   3. Aggregate the per-token FIFO results into one wallet-level row:
//        pnlUsd           = sum(realizedUsd) + sum(unrealizedUsd, nulls as 0)
//        realizedPnlUsd   = sum(realizedUsd)
//        unrealizedPnlUsd = sum(unrealizedUsd, nulls as 0)
//        tradeCount       = sum(per-token tradeCount) — total BUY+SELL rows
//                           across every token, matching WalletStats.tradeCount's
//                           existing "how many trades went into this row" meaning
//                           (see importWalletsCsv.ts's tradeCount30d mapping).
//        winRate          = TRADE-WEIGHTED across the wallet's combined SELL
//                           ledger, not a simple average of per-token winRates
//                           (documented choice — a wallet with one 10-sell
//                           token at 80% winRate and one 1-sell token at 0%
//                           should read close to 80%, not 40%; weighting by
//                           each token's own sell count reproduces exactly
//                           what a single combined-ledger FIFO run would have
//                           reported, which is the more honest number).
//                           If the wallet has zero SELLs across every token
//                           (buys only, nothing realized yet), winRate is
//                           written as 0 — not null, not skipped — since there
//                           is no win/loss signal yet to report; this is a
//                           neutral "no data" zero, the same convention
//                           importWalletsCsv.ts uses when a CSV row has no
//                           sell-derived win rate.
//        avgTradeSizeUsd  = sum(amountUsd across all trades) / tradeCount.
//        pnlConfidence    = MIN of the per-token confidences (the aggregate
//                           is only as trustworthy as its least-confident
//                           constituent — an average would mask one token's
//                           genuinely bad data with others' good data).
//   4. Feed the aggregate into @flowradar/core's computeWalletScore. This
//      wallet's trade history alone carries no direct signal for
//      humanLikelihood/entryQuality/holdingQuality/recentPerf/botLikelihood
//      (same gap importWalletsCsv.ts's deriveWalletScoreInput documents for
//      CSV rows) — WalletClassification labels are the one piece of
//      derivable signal actually available here, so 'possible_bot'/'mev'
//      labels nudge botLikelihood up and humanLikelihood down (mirroring
//      deriveWalletScoreInput's own tags-driven bot nudge), everything else
//      held at the same neutral 0.6 default.
//   5. INSERT a fresh WalletStats row (source='computed', new computedAt) —
//      never update-in-place, matching the "latest by computedAt is the live
//      figure" convention already used everywhere else in this codebase
//      (see fetchAggregateInputs.ts's latestStatsByWallet reduction).

import type { PrismaClient } from '@prisma/client';
import { computeFifoPnl, computeWalletScore } from '@flowradar/core';
import type { FifoTradeRow } from '@flowradar/core';

export interface WalletStatsRefreshLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface WalletStatsRefreshResult {
  walletsConsidered: number;
  refreshed: number;
  skippedCsv: number;
  errors: number;
}

const BOT_LABELS = new Set(['possible_bot', 'mev']);

/**
 * Runs one full wallet-stats refresh pass. Shared by
 * apps/worker/src/jobs/walletStatsRefresh.ts (scheduled worker tick) and
 * optionally packages/db/src/seed.ts (one-shot self-check pass) — same
 * "single source of truth" pattern as runFlowScoringPass/runEntityClustering.
 */
export async function runWalletStatsRefresh(
  prisma: PrismaClient,
  log?: WalletStatsRefreshLogger
): Promise<WalletStatsRefreshResult> {
  // Every wallet with >=1 trade, ever — a wallet with zero trades has
  // nothing to FIFO-compute and is skipped entirely (not counted as
  // "considered" at all, mirroring scoring-pass.ts's "token with zero
  // trades... skipped" framing for tokensWithTrades).
  const walletsWithTrades = await prisma.wallet.findMany({
    where: { trades: { some: {} } },
    select: { id: true }
  });

  const walletIds = walletsWithTrades.map((w) => w.id);
  if (walletIds.length === 0) {
    const summary: WalletStatsRefreshResult = { walletsConsidered: 0, refreshed: 0, skippedCsv: 0, errors: 0 };
    log?.info('walletStatsRefresh cycle complete', { ...summary });
    return summary;
  }

  // Latest WalletStats row per wallet (ordered computedAt desc, first
  // occurrence per walletId wins — same reduction pattern as
  // fetchAggregateInputs.ts's latestStatsByWallet) — this is the ONLY read
  // needed to decide the CSV skip; it is deliberately a separate, narrow
  // query rather than joining full stats history, since only `source` on the
  // single latest row matters here.
  const statsRows = await prisma.walletStats.findMany({
    where: { walletId: { in: walletIds } },
    orderBy: { computedAt: 'desc' },
    select: { walletId: true, source: true }
  });
  const latestSourceByWallet = new Map<string, string>();
  for (const row of statsRows) {
    if (!latestSourceByWallet.has(row.walletId)) {
      latestSourceByWallet.set(row.walletId, row.source);
    }
  }

  const walletIdsToRefresh = walletIds.filter((id) => latestSourceByWallet.get(id) !== 'csv');
  const skippedCsv = walletIds.length - walletIdsToRefresh.length;

  let refreshed = 0;
  let errors = 0;

  for (const walletId of walletIdsToRefresh) {
    try {
      await refreshOneWallet(prisma, walletId);
      refreshed += 1;
    } catch (err) {
      errors += 1;
      log?.error('walletStatsRefresh: failed to refresh wallet', {
        walletId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const summary: WalletStatsRefreshResult = {
    walletsConsidered: walletIds.length,
    refreshed,
    skippedCsv,
    errors
  };
  log?.info('walletStatsRefresh cycle complete', { ...summary });
  return summary;
}

interface PerTokenFifo {
  tokenId: string;
  realizedUsd: number;
  unrealizedUsd: number | null;
  winRate: number;
  tradeCount: number;
  confidence: number;
  sellCount: number;
  amountUsdSum: number;
}

async function refreshOneWallet(prisma: PrismaClient, walletId: string): Promise<void> {
  const [tradeRows, labelRows] = await Promise.all([
    prisma.walletTokenTrade.findMany({
      where: { walletId, action: { in: ['BUY', 'SELL'] } },
      orderBy: { ts: 'asc' },
      select: { tokenId: true, action: true, amountToken: true, amountUsd: true, priceUsd: true, ts: true }
    }),
    prisma.walletClassification.findMany({
      where: { walletId },
      select: { label: true }
    })
  ]);

  if (tradeRows.length === 0) return; // defensive — findMany's `some: {}` filter already excludes this case

  const tokenIds = [...new Set(tradeRows.map((t) => t.tokenId))];

  // Latest TokenMarketSnapshot.priceUsd per token — batched, not N+1 (one
  // query for every token this wallet has ever traded, same "select all then
  // reduce in memory" pattern as fetchAggregateInputs.ts).
  const snapshotRows = await prisma.tokenMarketSnapshot.findMany({
    where: { tokenId: { in: tokenIds } },
    orderBy: { ts: 'desc' },
    select: { tokenId: true, priceUsd: true }
  });
  const latestPriceByToken = new Map<string, number>();
  for (const row of snapshotRows) {
    if (!latestPriceByToken.has(row.tokenId)) {
      latestPriceByToken.set(row.tokenId, Number(row.priceUsd));
    }
  }

  const tradesByToken = new Map<string, typeof tradeRows>();
  for (const row of tradeRows) {
    const list = tradesByToken.get(row.tokenId) ?? [];
    list.push(row);
    tradesByToken.set(row.tokenId, list);
  }

  const perToken: PerTokenFifo[] = [];
  for (const [tokenId, rows] of tradesByToken) {
    const fifoRows: FifoTradeRow[] = rows.map((r) => ({
      action: r.action as 'BUY' | 'SELL',
      amountToken: Number(r.amountToken),
      amountUsd: Number(r.amountUsd),
      ts: r.ts
    }));

    // currentPrice resolution: latest TokenMarketSnapshot for this token,
    // else this token's own latest trade priceUsd (rows are ordered ts asc,
    // so the last element is the latest trade), else null.
    const lastTradePrice = rows.length > 0 ? Number(rows[rows.length - 1]!.priceUsd) : null;
    const currentPriceUsd = latestPriceByToken.get(tokenId) ?? lastTradePrice ?? null;

    const result = computeFifoPnl(fifoRows, currentPriceUsd);
    const sellCount = fifoRows.filter((r) => r.action === 'SELL').length;
    const amountUsdSum = rows.reduce((sum, r) => sum + Number(r.amountUsd), 0);

    perToken.push({
      tokenId,
      realizedUsd: result.realizedUsd,
      unrealizedUsd: result.unrealizedUsd,
      winRate: result.winRate,
      tradeCount: result.tradeCount,
      confidence: result.confidence,
      sellCount,
      amountUsdSum
    });
  }

  const realizedPnlUsd = perToken.reduce((sum, p) => sum + p.realizedUsd, 0);
  const unrealizedPnlUsd = perToken.reduce((sum, p) => sum + (p.unrealizedUsd ?? 0), 0);
  const pnlUsd = realizedPnlUsd + unrealizedPnlUsd;
  const tradeCount = perToken.reduce((sum, p) => sum + p.tradeCount, 0);
  const totalAmountUsd = perToken.reduce((sum, p) => sum + p.amountUsdSum, 0);
  const avgTradeSizeUsd = tradeCount > 0 ? totalAmountUsd / tradeCount : 0;

  // Trade-weighted winRate across the combined SELL ledger (documented
  // choice — see file header). A token with zero sells contributes zero
  // weight and is naturally excluded by the weighted sum below.
  const totalSells = perToken.reduce((sum, p) => sum + p.sellCount, 0);
  const winRate =
    totalSells > 0
      ? perToken.reduce((sum, p) => sum + p.winRate * p.sellCount, 0) / totalSells
      : 0;

  // pnlConfidence = MIN across per-token confidences (see file header).
  const pnlConfidence = perToken.length > 0 ? Math.min(...perToken.map((p) => p.confidence)) : 10;

  const labels = labelRows.map((r) => r.label);
  const looksLikeBot = labels.some((l) => BOT_LABELS.has(l));

  const scoreInput = {
    pnl30d: pnlUsd,
    winRate,
    tradeCount,
    humanLikelihood: looksLikeBot ? 0.2 : 0.6,
    entryQuality: 0.6,
    holdingQuality: 0.6,
    recentPerf: 0.6,
    botLikelihood: looksLikeBot ? 0.5 : 0,
    pnlConfidence
  };
  const scoreResult = computeWalletScore(scoreInput);

  await prisma.walletStats.create({
    data: {
      walletId,
      window: '30d',
      pnlUsd,
      realizedPnlUsd,
      unrealizedPnlUsd,
      winRate,
      tradeCount,
      avgTradeSizeUsd,
      walletScore: scoreResult.score,
      scoreComponents: scoreResult.components,
      pnlConfidence,
      source: 'computed',
      computedAt: new Date()
    }
  });
}
