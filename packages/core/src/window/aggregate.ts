// FlowRadar — window/aggregate.ts: pure TokenWindowAggregate builder.
//
// Normative source: Task 15 binding decision 1 (task-15-brief.md's
// wallet-driven scope-correction addendum is binding). This REPLACES Task
// 5's interim `buildBasicAggregate` in packages/db/src/scoring-pass.ts (see
// that file's own header for the deletion) — the worker's signal-detection
// job, the scoring pass, and the seed script all call THIS function from
// now on, fed by DB rows shaped into the four input row types below.
//
// packages/core is PURE (zero I/O): this module takes only plain data (row
// arrays + `now`) and returns a plain TokenWindowAggregate. All DB
// fetching/joining lives in packages/db/src/fetchAggregateInputs.ts.
//
// ---------------------------------------------------------------------------
// Anchoring (carried decision from Task 5, re-affirmed here)
// ---------------------------------------------------------------------------
// effective `to` = min(now, latest trade ts across the ENTIRE `trades` input
// — not just in-window trades). This is what makes a bounded mock/seed
// history scoreable: the mock world's scenarios are scripted at fixed
// offsets from a genesis far in the past, so anchoring purely to wall-clock
// `now` would put every scenario's window in a dead zone with zero trades
// once enough real time has passed since the world was seeded. Anchoring to
// "whichever is earlier, now or the last trade we've ever seen for this
// token" means a token that IS still trading right now scores off the true
// live window, while a token whose most recent activity is in the past (a
// seeded demo world, or a token that went quiet) still gets a meaningful
// window ending at its own last trade instead of an empty one.
// `from` is always `to - windowMinutes`.
//
// ---------------------------------------------------------------------------
// Field-by-field derivation notes (see each block comment below for detail)
// ---------------------------------------------------------------------------
//   - buyers[]: wallets with >=1 BUY in [from, to]. buyUsd/sellUsd sum ALL
//     in-window BUY/SELL trades for that wallet (SELLs count even if the
//     wallet's only BUY was earlier — a buyer can sell an out-of-window
//     entry position within this window). firstBuyTs/blockOrSlot are the
//     EARLIEST in-window BUY only.
//   - smartWalletCount = buyers where isWatched OR meetsProfitable (union).
//   - whaleBuys: per-wallet MAX single BUY trade amountUsd, only wallets
//     whose max reaches $10,000 (Task 13 threshold, hardcoded — this is a
//     structural definition of "whale buy", not a tunable Settings knob;
//     rules.D.minWhaleBuyUsd is a SEPARATE downstream filter rule D applies
//     to whatever whaleBuys already contains).
//   - uniqueEntityCount/largestClusterSize: distinct clusterIds among smart
//     buyers, PLUS one entity per unclustered smart buyer. Clusters empty
//     (Task 22 not landed yet) => every smart buyer is its own entity =>
//     uniqueEntityCount === smartWalletCount, largestClusterSize === 0 (no
//     cluster exists yet to report a size for).
//   - avgEntryMcap: buy-USD-weighted mean of marketCapAtTrade over buyers'
//     in-window BUY rows (rows with null marketCapAtTrade skipped entirely,
//     not treated as 0 — a $0 mcap would corrupt the weighted average far
//     worse than just omitting the unknown row). All-skipped => null.
//   - currentMcap/liquidityUsd: latest market point with ts <= `to`.
//   - mcapExpansionFromAvgEntry: currentMcap/avgEntryMcap - 1, null-safe.
//   - liquidityChangePct: (latest liquidity - liquidity at/before `from`) /
//     that starting liquidity * 100. Null if there's no market point at or
//     before `from` (no baseline to compare against).
//   - tokenAgeDays: (to - earliest market point ts) in days. Null if there
//     are no market points at all (age genuinely unknown, not "brand new").
//   - inflowSpike / trailingBuyVolumeUsd / windowBuyVolumeUsd: the aggregate
//     is settings-FREE (see brief resolution) — it exposes both raw volume
//     numbers so Rule A's settings-driven threshold stays entirely inside
//     ruleA.ts, while STILL computing a boolean `inflowSpike` field (which
//     other rules already read directly) using an optional caller-supplied
//     multiplier (`inflowSpikeMult`, default 3 — callers pass
//     settings.rules.A.inflowSpikeMult). trailingBuyVolumeUsd is the tracked
//     buy volume in the equal-length window immediately BEFORE `from`
//     (i.e. [from - windowMinutes, from)). windowBuyVolumeUsd is simply an
//     alias for trackedBuyVolumeUsd exposed under the name Rule A's
//     comparison reads most naturally.
//   - exitedSmartPct: % of SMART buyers (this window's buyers who are
//     watched/profitable) who sold >= 80% of their OWN window buyUsd.
//     Simplification (documented): this is a WINDOW-buy-relative measure,
//     not a full historical position measure — a smart wallet whose only
//     window activity is a partial sell of a pre-window position is not
//     represented here at all (it isn't a "buyer" this window), and a smart
//     buyer who bought $100 this window then sold $500 (from an older
//     position) reads as "sold 500% of window buy", i.e. comfortably over
//     the 80% floor — a deliberate, documented approximation matching the
//     task brief's "keep to window buyers" instruction. 0 smart buyers => 0
//     (no divide-by-zero).
//   - topHolderExits: among the top-5 buyers BY buyUsd (ties broken by
//     insertion/trade order — see implementation), count how many sold >=
//     80% of their OWN buyUsd. NOT restricted to "smart" buyers (rule G's
//     brief context talks about "top holders" generally, not smart-money
//     specifically).
//   - newSmartBuyers: smart buyers whose in-window firstBuyTs equals their
//     FIRST TRADE EVER across the entire `trades` input (i.e. this window's
//     buy is the first time this wallet has ever traded, full stop — not
//     just "first time in this window").
//   - earlyWindowBuyerCount: buyers whose firstBuyTs falls in
//     [from, from + windowMinutes/2) — the Rule B growth baseline (early
//     half of the window vs. the full window's smartWalletCount).
//   - accumulation: ONLY computed when windowMinutes === 1440 (undefined
//     for the 30-minute aggregate) — smartWalletCount30m/1h/6h are distinct
//     buyer counts in the trailing N minutes ending at `to` (independent of
//     the 24h window's own `from`), percentWalletsSold is the share of
//     THIS WINDOW's buyers (all of them, not just "smart" ones) with
//     sellUsd > 0.

import type { TokenWindowAggregate } from '../types';

// ---------------------------------------------------------------------------
// Input row types
// ---------------------------------------------------------------------------

export interface TradeRowInput {
  walletId: string;
  action: 'BUY' | 'SELL';
  amountUsd: number;
  ts: Date;
  blockOrSlot: bigint;
  /** Token mcap at trade time; null when unknown (skipped from avgEntryMcap, never coerced to 0). */
  marketCapAtTrade: number | null;
}

export interface WalletInfoInput {
  walletId: string;
  isWatched: boolean;
  walletScore: number;
  labels: string[];
  /** Result of @flowradar/core's isProfitableWallet for this wallet's latest stats row (false if no stats row exists). */
  meetsProfitable: boolean;
}

export interface ClusterMembershipInput {
  walletId: string;
  clusterId: string;
}

export interface MarketPointInput {
  ts: Date;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
}

/**
 * Per Task 15 binding decision 1's literal signature, `tokenId` is NOT part
 * of this input shape (aggregateWindow's own math never needs it) — the
 * caller (packages/db's fetchAggregateInputs consumer) is expected to spread
 * `{ ...aggregateWindow(...), tokenId }` afterward to produce a fully-formed
 * TokenWindowAggregate. `tokenId` defaults to '' on the raw return value so
 * every other field can still be constructed/tested independently of a
 * caller supplying one.
 */
export interface AggregateWindowInput {
  trades: TradeRowInput[];
  wallets: WalletInfoInput[];
  clusters: ClusterMembershipInput[];
  market: MarketPointInput[];
  windowMinutes: 30 | 1440;
  now: Date;
  /** Multiplier for inflowSpike (windowBuyVolumeUsd >= inflowSpikeMult * trailingBuyVolumeUsd). Default 3 — pass settings.rules.A.inflowSpikeMult. */
  inflowSpikeMult?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const MS_PER_DAY = 24 * HOUR_MS;
const WHALE_BUY_THRESHOLD_USD = 10_000;
const EXIT_POSITION_SOLD_PCT = 80; // % of window buyUsd sold to count as "exited"
const DEFAULT_INFLOW_SPIKE_MULT = 3;
const TOP_HOLDER_COUNT = 5;

// ---------------------------------------------------------------------------
// aggregateWindow
// ---------------------------------------------------------------------------

export function aggregateWindow(input: AggregateWindowInput): TokenWindowAggregate {
  const { trades, wallets, clusters, market, windowMinutes, now } = input;
  const inflowSpikeMult = input.inflowSpikeMult ?? DEFAULT_INFLOW_SPIKE_MULT;

  // -- Anchoring ---------------------------------------------------------
  const latestTradeTs = trades.reduce<number | null>(
    (max, t) => (max === null || t.ts.getTime() > max ? t.ts.getTime() : max),
    null
  );
  const to = latestTradeTs !== null && latestTradeTs < now.getTime() ? new Date(latestTradeTs) : now;
  const from = new Date(to.getTime() - windowMinutes * MIN_MS);

  const walletById = new Map(wallets.map((w) => [w.walletId, w]));
  const clusterByWallet = new Map(clusters.map((c) => [c.walletId, c.clusterId]));

  const inWindow = (t: TradeRowInput) => t.ts.getTime() >= from.getTime() && t.ts.getTime() <= to.getTime();
  const windowTrades = trades.filter(inWindow);

  // -- Per-wallet in-window accumulation (buyUsd/sellUsd/firstBuy) --------
  interface Acc {
    walletId: string;
    buyUsd: number;
    sellUsd: number;
    firstBuyTs: Date | null;
    firstBuyBlockOrSlot: bigint | null;
    maxSingleBuyUsd: number;
  }
  const accByWallet = new Map<string, Acc>();
  function getAcc(walletId: string): Acc {
    let acc = accByWallet.get(walletId);
    if (!acc) {
      acc = { walletId, buyUsd: 0, sellUsd: 0, firstBuyTs: null, firstBuyBlockOrSlot: null, maxSingleBuyUsd: 0 };
      accByWallet.set(walletId, acc);
    }
    return acc;
  }

  // Process in ts order so "first buy" bookkeeping sees earliest-first
  // regardless of input array order.
  const orderedWindowTrades = [...windowTrades].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  for (const t of orderedWindowTrades) {
    const acc = getAcc(t.walletId);
    if (t.action === 'BUY') {
      acc.buyUsd += t.amountUsd;
      if (t.amountUsd > acc.maxSingleBuyUsd) acc.maxSingleBuyUsd = t.amountUsd;
      if (acc.firstBuyTs === null) {
        acc.firstBuyTs = t.ts;
        acc.firstBuyBlockOrSlot = t.blockOrSlot;
      }
    } else {
      acc.sellUsd += t.amountUsd;
    }
  }

  const buyerWalletIds = [...accByWallet.values()].filter((a) => a.firstBuyTs !== null).map((a) => a.walletId);

  const buyers: TokenWindowAggregate['buyers'] = buyerWalletIds.map((walletId) => {
    const acc = accByWallet.get(walletId)!;
    const info = walletById.get(walletId);
    const clusterId = clusterByWallet.get(walletId);
    return {
      walletId,
      walletScore: info?.walletScore ?? 0,
      labels: info?.labels ?? [],
      buyUsd: acc.buyUsd,
      sellUsd: acc.sellUsd,
      firstBuyTs: acc.firstBuyTs!,
      blockOrSlot: acc.firstBuyBlockOrSlot!,
      ...(clusterId !== undefined ? { entityClusterId: clusterId } : {}),
      isWatched: info?.isWatched ?? false
    };
  });

  // -- Volumes / net flow / ratio (ALL tracked wallets present in `wallets`
  // input, buyers and sell-only alike — per binding decision: "Volumes/net/
  // buySellRatio from window trades of tracked wallets (all buyers+sellers
  // present in wallets input)") ------------------------------------------
  let trackedBuyVolumeUsd = 0;
  let trackedSellVolumeUsd = 0;
  for (const acc of accByWallet.values()) {
    if (!walletById.has(acc.walletId)) continue; // only wallets present in the `wallets` input are "tracked"
    trackedBuyVolumeUsd += acc.buyUsd;
    trackedSellVolumeUsd += acc.sellUsd;
  }
  const netFlowUsd = trackedBuyVolumeUsd - trackedSellVolumeUsd;
  const buySellRatio =
    trackedSellVolumeUsd > 0 ? trackedBuyVolumeUsd / trackedSellVolumeUsd : trackedBuyVolumeUsd > 0 ? 999 : 0;

  // -- smartWalletCount / humanLikeCount / possibleBotCount ---------------
  const isSmart = (walletId: string): boolean => {
    const info = walletById.get(walletId);
    if (!info) return false;
    return info.isWatched || info.meetsProfitable;
  };
  const smartBuyerIds = buyerWalletIds.filter(isSmart);
  const smartWalletCount = smartBuyerIds.length;

  const humanLikeCount = buyers.filter((b) => b.labels.includes('human_like')).length;
  const possibleBotCount = buyers.filter((b) => b.labels.includes('possible_bot')).length;

  // -- whaleBuys -----------------------------------------------------------
  const whaleBuys: TokenWindowAggregate['whaleBuys'] = [...accByWallet.values()]
    .filter((acc) => acc.maxSingleBuyUsd >= WHALE_BUY_THRESHOLD_USD)
    .map((acc) => ({ walletId: acc.walletId, usd: acc.maxSingleBuyUsd }));

  // -- uniqueEntityCount / largestClusterSize (among SMART buyers only,
  // matching Rule A/D's "smart/watched wallet" framing for entity-adjusted
  // counts) ----------------------------------------------------------------
  const smartClusterIds = new Map<string, number>(); // clusterId -> member count (smart buyers only)
  let unclusteredSmartCount = 0;
  for (const walletId of smartBuyerIds) {
    const clusterId = clusterByWallet.get(walletId);
    if (clusterId === undefined) {
      unclusteredSmartCount += 1;
    } else {
      smartClusterIds.set(clusterId, (smartClusterIds.get(clusterId) ?? 0) + 1);
    }
  }
  const uniqueEntityCount = smartClusterIds.size + unclusteredSmartCount;
  const largestClusterSize = smartClusterIds.size > 0 ? Math.max(...smartClusterIds.values()) : 0;

  // -- avgEntryMcap ----------------------------------------------------------
  // Weighted over buyers' in-window BUY rows with non-null marketCapAtTrade.
  let mcapWeightedSum = 0;
  let mcapWeightTotal = 0;
  for (const t of orderedWindowTrades) {
    if (t.action !== 'BUY') continue;
    if (t.marketCapAtTrade === null) continue;
    if (!walletById.has(t.walletId)) continue;
    mcapWeightedSum += t.amountUsd * t.marketCapAtTrade;
    mcapWeightTotal += t.amountUsd;
  }
  const avgEntryMcap = mcapWeightTotal > 0 ? mcapWeightedSum / mcapWeightTotal : null;

  // -- currentMcap / liquidityUsd (latest market point <= `to`) -----------
  const sortedMarket = [...market].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const pointsAtOrBeforeTo = sortedMarket.filter((p) => p.ts.getTime() <= to.getTime());
  const latestPoint = pointsAtOrBeforeTo.length > 0 ? pointsAtOrBeforeTo[pointsAtOrBeforeTo.length - 1]! : null;
  const currentMcap = latestPoint?.marketCapUsd ?? null;
  const liquidityUsd = latestPoint?.liquidityUsd ?? null;

  // -- mcapExpansionFromAvgEntry -------------------------------------------
  const mcapExpansionFromAvgEntry =
    currentMcap !== null && avgEntryMcap !== null && avgEntryMcap > 0 ? currentMcap / avgEntryMcap - 1 : null;

  // -- liquidityChangePct ----------------------------------------------------
  const pointsAtOrBeforeFrom = sortedMarket.filter((p) => p.ts.getTime() <= from.getTime());
  const startPoint =
    pointsAtOrBeforeFrom.length > 0 ? pointsAtOrBeforeFrom[pointsAtOrBeforeFrom.length - 1]! : null;
  const liquidityChangePct =
    startPoint !== null &&
    startPoint.liquidityUsd !== null &&
    startPoint.liquidityUsd > 0 &&
    liquidityUsd !== null
      ? ((liquidityUsd - startPoint.liquidityUsd) / startPoint.liquidityUsd) * 100
      : null;

  // -- tokenAgeDays ----------------------------------------------------------
  const earliestPoint = sortedMarket.length > 0 ? sortedMarket[0]! : null;
  const tokenAgeDays = earliestPoint !== null ? (to.getTime() - earliestPoint.ts.getTime()) / MS_PER_DAY : null;

  // -- inflowSpike / trailingBuyVolumeUsd / windowBuyVolumeUsd -------------
  const windowBuyVolumeUsd = trackedBuyVolumeUsd;
  const trailingFrom = new Date(from.getTime() - windowMinutes * MIN_MS);
  let trailingBuyVolumeUsd = 0;
  for (const t of trades) {
    if (t.action !== 'BUY') continue;
    if (!walletById.has(t.walletId)) continue;
    if (t.ts.getTime() >= trailingFrom.getTime() && t.ts.getTime() < from.getTime()) {
      trailingBuyVolumeUsd += t.amountUsd;
    }
  }
  const inflowSpike = trailingBuyVolumeUsd > 0 && windowBuyVolumeUsd >= inflowSpikeMult * trailingBuyVolumeUsd;

  // -- exitedSmartPct --------------------------------------------------------
  const exitedSmartCount = smartBuyerIds.filter((walletId) => {
    const acc = accByWallet.get(walletId)!;
    return acc.buyUsd > 0 && (acc.sellUsd / acc.buyUsd) * 100 >= EXIT_POSITION_SOLD_PCT;
  }).length;
  const exitedSmartPct = smartBuyerIds.length > 0 ? (exitedSmartCount / smartBuyerIds.length) * 100 : 0;

  // -- topHolderExits ----------------------------------------------------
  const buyersByBuyUsdDesc = [...buyerWalletIds].sort((a, b) => {
    const bBuy = accByWallet.get(b)!.buyUsd;
    const aBuy = accByWallet.get(a)!.buyUsd;
    return bBuy - aBuy;
  });
  const topHolders = buyersByBuyUsdDesc.slice(0, TOP_HOLDER_COUNT);
  const topHolderExits = topHolders.filter((walletId) => {
    const acc = accByWallet.get(walletId)!;
    return acc.buyUsd > 0 && (acc.sellUsd / acc.buyUsd) * 100 >= EXIT_POSITION_SOLD_PCT;
  }).length;

  // -- newSmartBuyers ------------------------------------------------------
  // First trade EVER per wallet, across the FULL (unfiltered-by-window)
  // trades input.
  const firstEverTsByWallet = new Map<string, number>();
  for (const t of trades) {
    const existing = firstEverTsByWallet.get(t.walletId);
    if (existing === undefined || t.ts.getTime() < existing) {
      firstEverTsByWallet.set(t.walletId, t.ts.getTime());
    }
  }
  const newSmartBuyers = smartBuyerIds.filter((walletId) => {
    const acc = accByWallet.get(walletId)!;
    const firstEver = firstEverTsByWallet.get(walletId);
    return firstEver !== undefined && firstEver === acc.firstBuyTs!.getTime();
  }).length;

  // -- earlyWindowBuyerCount -------------------------------------------------
  const earlyWindowEnd = from.getTime() + (windowMinutes * MIN_MS) / 2;
  const earlyWindowBuyerCount = buyerWalletIds.filter((walletId) => {
    const acc = accByWallet.get(walletId)!;
    const t = acc.firstBuyTs!.getTime();
    return t >= from.getTime() && t < earlyWindowEnd;
  }).length;

  // -- accumulation (1440-min aggregate only) -------------------------------
  let accumulation: TokenWindowAggregate['accumulation'];
  if (windowMinutes === 1440) {
    const countBuyersWithFirstBuyTrailing = (trailingMinutes: number): number => {
      const trailingStart = to.getTime() - trailingMinutes * MIN_MS;
      const seen = new Set<string>();
      for (const t of trades) {
        if (t.action !== 'BUY') continue;
        if (!walletById.has(t.walletId)) continue;
        if (t.ts.getTime() >= trailingStart && t.ts.getTime() <= to.getTime()) {
          seen.add(t.walletId);
        }
      }
      return seen.size;
    };

    const soldCount = buyerWalletIds.filter((walletId) => accByWallet.get(walletId)!.sellUsd > 0).length;
    const percentWalletsSold = buyerWalletIds.length > 0 ? (soldCount / buyerWalletIds.length) * 100 : 0;

    accumulation = {
      smartWalletCount30m: countBuyersWithFirstBuyTrailing(30),
      smartWalletCount1h: countBuyersWithFirstBuyTrailing(60),
      smartWalletCount6h: countBuyersWithFirstBuyTrailing(6 * 60),
      percentWalletsSold
    };
  }

  return {
    tokenId: '',
    windowMinutes,
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
    whaleBuys,
    uniqueEntityCount,
    largestClusterSize,
    avgEntryMcap,
    currentMcap,
    mcapExpansionFromAvgEntry,
    liquidityUsd,
    liquidityChangePct,
    tokenAgeDays,
    inflowSpike,
    trailingBuyVolumeUsd,
    windowBuyVolumeUsd,
    exitedSmartPct,
    topHolderExits,
    newSmartBuyers,
    earlyWindowBuyerCount,
    ...(accumulation !== undefined ? { accumulation } : {})
  };
}
