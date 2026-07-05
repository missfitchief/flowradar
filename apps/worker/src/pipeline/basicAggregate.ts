// interim aggregate — replaced by @flowradar/core aggregateWindow in Task 15
//
// Builds a minimal TokenWindowAggregate for one token from stored
// WalletTokenTrade/WalletStats/WalletClassification/TokenMarketSnapshot rows,
// covering the trailing 24h window only. This exists so flowScoring.ts (Task
// 5) has something real to feed computeFlowScore before Task 15 lands the
// full aggregateWindow() (which additionally needs clustering, rotation, and
// G-rule inputs that don't exist yet — see brief decision 3). Every field
// this interim builder can't yet compute honestly (uniqueEntityCount beyond
// smartWalletCount, liquidityChangePct, inflowSpike, exitedSmartPct,
// topHolderExits, newSmartBuyers) is set to a documented placeholder value
// rather than a fabricated number.
//
// Window anchor: "trailing 24h" is anchored to the TOKEN'S OWN most recent
// trade timestamp (not the caller-supplied `now`/wall clock). The mock
// world's 7 scenarios are deliberately scripted at different fixed points
// across its full 72h history (Spec-driven realism — a live system's tokens
// don't all trade "right now" either), so anchoring to wall-clock `now`
// would make every scenario except the ones scripted in the final 24h of
// that history permanently unscoreable, no matter how long the worker runs
// (the mock world's scripted content doesn't move forward in time — only
// `now` does, and it never catches up to a fixed-offset-from-genesis event
// that's already >24h in the past relative to the world's horizon). Scoring
// "the most recent 24h this token actually traded in" is both the more
// generally useful definition for a real historical token and the one that
// makes every mock scenario's flowScore comparable and correct — matching
// this task's NOVA-scores-highest verification requirement without
// special-casing the mock world.

import type { Chain, Settings, TokenWindowAggregate } from '@flowradar/core';
import type { PrismaClient } from '@flowradar/db';

type ProfitableWalletThresholds = Settings['profitableWallet'];

const WINDOW_MINUTES = 1440; // trailing 24h, per brief decision 3
const DEFAULT_WALLET_SCORE = 50;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
