// FlowRadar — shared flow-scoring pass (Task 6 brief: "move the reusable
// job-body into packages/db ... have BOTH worker job and seed call it — do
// not copy-paste the logic twice").
//
// This module carries the exact logic that was Task 5's
// apps/worker/src/pipeline/basicAggregate.ts (interim TokenWindowAggregate
// builder) + apps/worker/src/jobs/flowScoring.ts (the per-token loop that
// builds an aggregate, fetches risk, computes flowScore, persists one
// TokenFlowSnapshot row). Moved here verbatim (not reimplemented) so both the
// worker's scheduled job and the seed script call the identical code path —
// apps/worker/src/jobs/flowScoring.ts is now a thin wrapper around
// runFlowScoringPass() below.
//
// interim aggregate — replaced by @flowradar/core aggregateWindow in Task 15.
//
// Window anchor: "trailing 24h" is anchored to the TOKEN'S OWN most recent
// trade timestamp (not wall-clock `now`). The mock world's scenarios are
// scripted at different fixed points across its full 72h history, so
// anchoring to wall-clock `now` would make every scenario except the ones
// scripted in the final 24h permanently unscoreable (see Task 5 report "Bug
// found and fixed: aggregate window anchor" for the full incident writeup).
// Scoring "the most recent 24h this token actually traded in" is both the
// more generally useful definition for a real historical token and the one
// that makes every mock scenario's flowScore comparable and correct.

import { computeFlowScore } from '@flowradar/core';
import type { Chain, RiskReport, Settings, TokenWindowAggregate } from '@flowradar/core';
import type { PrismaClient } from '@prisma/client';

type ProfitableWalletThresholds = Settings['profitableWallet'];

const WINDOW_MINUTES = 1440; // trailing 24h, per Task 5 brief decision 3
const DEFAULT_WALLET_SCORE = 50;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Minimal risk-lookup shape a caller must provide — deliberately narrower than the full JobContext/ProviderResolver types (which live in apps/worker), so packages/db doesn't need to depend on apps/worker. */
export interface RiskProviderLike {
  getTokenRisk(chain: Chain, address: string): Promise<RiskReport>;
}

export type RiskProviderResolver = (chain: Chain) => RiskProviderLike;

export interface ScoringPassLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ScoringPassResult {
  tokensConsidered: number;
  scored: number;
  skippedNoWindow: number;
  errors: number;
}

interface BuyerAccumulator {
  walletId: string;
  buyUsd: number;
  sellUsd: number;
}

/**
 * Builds a TokenWindowAggregate for `tokenId` covering the trailing 24h up to
 * this token's own most recent BUY/SELL trade (not `now` — see file header).
 * `now` is still used for tokenAgeDays and as the fallback "to" bound when a
 * token has zero trades at all (in which case this returns null immediately
 * and `now` is never actually used — kept as a parameter for interface
 * symmetry with the rest of the job/ctx pattern and for the "as of when was
 * this snapshot computed" framing). Returns null if the token has zero
 * BUY/SELL trades ever (caller skips scoring tokens with no trade activity).
 */
export async function buildBasicAggregate(
  prisma: PrismaClient,
  tokenId: string,
  chain: Chain,
  settings: Settings,
  now: Date
): Promise<TokenWindowAggregate | null> {
  const mostRecentTrade = await prisma.walletTokenTrade.findFirst({
    where: { tokenId, action: { in: ['BUY', 'SELL'] } },
    orderBy: { ts: 'desc' },
    select: { ts: true }
  });
  if (!mostRecentTrade) return null;

  const to = mostRecentTrade.ts;
  const from = new Date(to.getTime() - WINDOW_MINUTES * 60 * 1000);

  const trades = await prisma.walletTokenTrade.findMany({
    where: { tokenId, ts: { gte: from, lte: to }, action: { in: ['BUY', 'SELL'] } },
    orderBy: { ts: 'asc' },
    select: {
      walletId: true,
      action: true,
      amountUsd: true,
      ts: true,
      blockOrSlot: true,
      marketCapAtTrade: true
    }
  });

  if (trades.length === 0) return null; // unreachable in practice (mostRecentTrade.ts is always in [from, to]) — defensive

  const buyerMap = new Map<string, BuyerAccumulator>();
  for (const trade of trades) {
    let acc = buyerMap.get(trade.walletId);
    if (!acc) {
      acc = { walletId: trade.walletId, buyUsd: 0, sellUsd: 0 };
      buyerMap.set(trade.walletId, acc);
    }
    if (trade.action === 'BUY') {
      acc.buyUsd += Number(trade.amountUsd);
    } else {
      acc.sellUsd += Number(trade.amountUsd);
    }
  }

  // "First buy" (ts/blockOrSlot/marketCapAtTrade at entry) derived strictly
  // from BUY rows only, per wallet, earliest first (trades are ordered ts
  // asc, so the first BUY row encountered per wallet wins). A wallet whose
  // only trades in this window are SELLs (e.g. it bought earlier, outside
  // the 24h lookback) has no "first buy" *in this window* and is excluded
  // from `buyers` entirely — per the brief's "buyers (wallet, ...)" framing,
  // which is about entry behavior.
  const firstBuyByWallet = new Map<string, { ts: Date; blockOrSlot: bigint; marketCapAtTrade: number }>();
  for (const trade of trades) {
    if (trade.action !== 'BUY') continue;
    if (!firstBuyByWallet.has(trade.walletId)) {
      firstBuyByWallet.set(trade.walletId, {
        ts: trade.ts,
        blockOrSlot: trade.blockOrSlot,
        marketCapAtTrade: Number(trade.marketCapAtTrade)
      });
    }
  }

  const walletIds = [...buyerMap.keys()].filter((id) => firstBuyByWallet.has(id));

  const [walletStatsRows, classificationRows] = await Promise.all([
    prisma.walletStats.findMany({
      where: { walletId: { in: walletIds } },
      orderBy: { computedAt: 'desc' },
      select: {
        walletId: true,
        walletScore: true,
        pnlUsd: true,
        realizedPnlUsd: true,
        winRate: true,
        tradeCount: true,
        avgTradeSizeUsd: true,
        computedAt: true
      }
    }),
    prisma.walletClassification.findMany({
      where: { walletId: { in: walletIds } },
      select: { walletId: true, label: true }
    })
  ]);

  // Latest WalletStats row per wallet (rows already ordered computedAt desc,
  // so the first occurrence per walletId wins).
  const latestStatsByWallet = new Map<string, (typeof walletStatsRows)[number]>();
  for (const row of walletStatsRows) {
    if (!latestStatsByWallet.has(row.walletId)) {
      latestStatsByWallet.set(row.walletId, row);
    }
  }

  const labelsByWallet = new Map<string, string[]>();
  for (const row of classificationRows) {
    const list = labelsByWallet.get(row.walletId) ?? [];
    list.push(row.label);
    labelsByWallet.set(row.walletId, list);
  }

  const buyers: TokenWindowAggregate['buyers'] = walletIds.map((walletId) => {
    const acc = buyerMap.get(walletId)!;
    const firstBuy = firstBuyByWallet.get(walletId)!;
    const stats = latestStatsByWallet.get(walletId);
    return {
      walletId,
      walletScore: stats?.walletScore ?? DEFAULT_WALLET_SCORE,
      labels: labelsByWallet.get(walletId) ?? [],
      buyUsd: acc.buyUsd,
      sellUsd: acc.sellUsd,
      firstBuyTs: firstBuy.ts,
      blockOrSlot: firstBuy.blockOrSlot
    };
  });

  const trackedBuyVolumeUsd = buyers.reduce((sum, b) => sum + b.buyUsd, 0);
  const trackedSellVolumeUsd = buyers.reduce((sum, b) => sum + b.sellUsd, 0);
  const netFlowUsd = trackedBuyVolumeUsd - trackedSellVolumeUsd;
  const buySellRatio = trackedSellVolumeUsd > 0 ? trackedBuyVolumeUsd / trackedSellVolumeUsd : trackedBuyVolumeUsd > 0 ? 999 : 0;

  const smartWalletCount = buyers.filter((b) => {
    const stats = latestStatsByWallet.get(b.walletId);
    if (!stats) return false;
    return isProfitableWallet(stats, settings.profitableWallet);
  }).length;

  const humanLikeCount = buyers.filter((b) => b.labels.includes('human_like')).length;
  const possibleBotCount = buyers.filter((b) => b.labels.includes('possible_bot')).length;

  const totalBuyUsdForEntry = buyers.reduce((sum, b) => sum + b.buyUsd, 0);
  const avgEntryMcap =
    totalBuyUsdForEntry > 0
      ? buyers.reduce((sum, b) => {
          const firstBuy = firstBuyByWallet.get(b.walletId)!;
          return sum + b.buyUsd * firstBuy.marketCapAtTrade;
        }, 0) / totalBuyUsdForEntry
      : null;

  const latestMarketSnapshot = await prisma.tokenMarketSnapshot.findFirst({
    where: { tokenId },
    orderBy: { ts: 'desc' },
    select: { marketCapUsd: true, liquidityUsd: true }
  });
  const currentMcap = latestMarketSnapshot ? Number(latestMarketSnapshot.marketCapUsd) : null;
  const liquidityUsd = latestMarketSnapshot ? Number(latestMarketSnapshot.liquidityUsd) : null;

  const mcapExpansionFromAvgEntry =
    currentMcap !== null && avgEntryMcap !== null && avgEntryMcap > 0 ? currentMcap / avgEntryMcap - 1 : null;

  const token = await prisma.token.findUniqueOrThrow({ where: { id: tokenId }, select: { firstSeenAt: true } });
  const tokenAgeDays = (now.getTime() - token.firstSeenAt.getTime()) / MS_PER_DAY;

  return {
    tokenId,
    windowMinutes: WINDOW_MINUTES,
    from,
    to,
    buyers,
    trackedBuyVolumeUsd,
    trackedSellVolumeUsd,
    netFlowUsd,
    buySellRatio,
    smartWalletCount,
    humanLikeCount,
    possibleBotCount,
    whaleBuys: [], // interim: no whale threshold plumbed yet — computeFlowScore doesn't consume this field
    uniqueEntityCount: smartWalletCount, // clustering arrives Task 22
    largestClusterSize: smartWalletCount, // interim placeholder — not consumed by computeFlowScore
    avgEntryMcap,
    currentMcap,
    mcapExpansionFromAvgEntry,
    liquidityUsd,
    liquidityChangePct: null, // no historical baseline in this interim builder
    tokenAgeDays,
    inflowSpike: false,
    exitedSmartPct: 0,
    topHolderExits: 0,
    newSmartBuyers: 0
  };
}

function isProfitableWallet(
  stats: { pnlUsd: unknown; realizedPnlUsd: unknown; winRate: number; tradeCount: number; avgTradeSizeUsd: unknown },
  thresholds: ProfitableWalletThresholds
): boolean {
  const pnl30d = Number(stats.pnlUsd);
  const realized = Number(stats.realizedPnlUsd);
  const avgTradeSizeUsd = Number(stats.avgTradeSizeUsd);
  return (
    pnl30d >= thresholds.pnl30d &&
    stats.tradeCount >= thresholds.minTrades &&
    stats.winRate >= thresholds.minWinRate &&
    realized >= thresholds.minRealized &&
    avgTradeSizeUsd >= thresholds.minAvgTradeSizeUsd
  );
}

/**
 * Runs one full flow-scoring pass: for every token with >=1 BUY/SELL trade
 * ever, builds an interim aggregate, fetches a RiskReport from the resolved
 * risk provider, runs computeFlowScore, and persists one TokenFlowSnapshot
 * row (windowMinutes 1440, signalStatus 'watching'). Shared by
 * apps/worker/src/jobs/flowScoring.ts (scheduled worker tick) and
 * packages/db/src/seed.ts (one-shot seed pass) — identical logic, single
 * source of truth, per Task 6 brief's explicit "do not copy-paste" instruction.
 */
export async function runFlowScoringPass(
  prisma: PrismaClient,
  settings: Settings,
  resolveRiskProvider: RiskProviderResolver,
  log?: ScoringPassLogger
): Promise<ScoringPassResult> {
  const now = new Date();

  // Every token that has at least one trade, ever (a token with zero trades
  // has nothing to aggregate and is skipped — buildBasicAggregate would
  // return null for it anyway, but this avoids the query entirely for the
  // common case of many never-traded noise tokens).
  const tokensWithTrades = await prisma.token.findMany({
    where: { trades: { some: {} } },
    select: { id: true, chain: true, address: true, symbol: true }
  });

  let scored = 0;
  let skippedNoWindow = 0;
  let errors = 0;

  for (const token of tokensWithTrades) {
    try {
      const agg = await buildBasicAggregate(prisma, token.id, token.chain as Chain, settings, now);
      if (!agg) {
        skippedNoWindow += 1;
        continue;
      }

      const riskProvider = resolveRiskProvider(token.chain as Chain);
      const risk = await riskProvider.getTokenRisk(token.chain as Chain, token.address);

      const result = computeFlowScore(agg, risk, settings);

      await prisma.tokenFlowSnapshot.create({
        data: {
          tokenId: token.id,
          ts: now,
          windowMinutes: agg.windowMinutes,
          flowScore: result.score,
          smartWalletCount: agg.smartWalletCount,
          humanLikeCount: agg.humanLikeCount,
          possibleBotCount: agg.possibleBotCount,
          uniqueEntityCount: agg.uniqueEntityCount,
          clusterAdjustedWalletCount: agg.uniqueEntityCount,
          entityConcentrationRisk: 0,
          trackedBuyVolumeUsd: agg.trackedBuyVolumeUsd,
          trackedSellVolumeUsd: agg.trackedSellVolumeUsd,
          netFlowUsd: agg.netFlowUsd,
          buySellRatio: agg.buySellRatio,
          avgEntryMcap: agg.avgEntryMcap ?? 0,
          currentMcap: agg.currentMcap ?? 0,
          mcapExpansionFromAvgEntry: agg.mcapExpansionFromAvgEntry ?? 0,
          holdersGrowth: 0,
          liquidityChange: agg.liquidityChangePct ?? 0,
          signalStatus: 'watching',
          componentBreakdown: result.components
        }
      });
      scored += 1;
    } catch (err) {
      errors += 1;
      log?.error(`flowScoring: failed to score ${token.symbol}`, {
        tokenId: token.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const summary: ScoringPassResult = {
    tokensConsidered: tokensWithTrades.length,
    scored,
    skippedNoWindow,
    errors
  };
  log?.info('flowScoring cycle complete', { ...summary });
  return summary;
}
