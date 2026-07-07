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
//   - humanOrSmartLabelCount (Task 15 Fix A): buyers whose labels include
//     'human_like' OR 'smart_money' (union) — feeds Rule C's ratio per the
//     product brief's literal "70%+ buying wallets are human_like OR
//     smart_money" contract. Distinct from humanLikeCount (human_like-only,
//     unchanged, still feeds flowScore.ts's humanRatio component).
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
//   - exitedSmartPct / topHolderExits (Task 15 Fix B — HOLDER-based, not
//     window-buyer-based; full derivation + rationale in the implementation
//     block below, this is a summary): preWindowNetUsd[wallet] = net
//     BUY-SELL USD across ALL trades strictly BEFORE `from`; a wallet with
//     preWindowNetUsd > 0 is a "holder at window start". exitedSmartPct = %
//     of SMART holders-at-window-start (isWatched OR meetsProfitable) whose
//     IN-WINDOW sellUsd >= 80% of their preWindowNetUsd, UNIONED with smart
//     buyers who have NO pre-window position but bought-and-dumped >= 80%
//     of that same window's buy within the window itself (a legitimate
//     exit the pure holder-based measure would otherwise miss for a
//     brand-new in-window position). topHolderExits = among the top-5
//     holders-at-window-start BY preWindowNetUsd (not smart-restricted),
//     count who sold >= 80% of that position in-window — this one stays
//     purely holder-based (a zero-pre-window-position wallet has nothing to
//     rank by). Both are 0 when their respective population is empty (no
//     divide-by-zero).
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
// Window bounds
// ---------------------------------------------------------------------------

/**
 * Resolves the [from, to] window bounds an aggregate uses, from a token's
 * latest-trade timestamp, the current time, and the window length in minutes.
 *
 * Anchors `to` to the latest trade (so a token stops "advancing" its window
 * once its last trade is in the past) unless that trade is at/after `now`, in
 * which case `to = now`; `from = to − windowMinutes`.
 *
 * Extracted so the DB layer (fetchAggregateInputs) can compute the SAME bounds
 * and fetch only the market snapshots aggregateWindow will actually read
 * (latest ≤ to, latest ≤ from) instead of a token's full snapshot history —
 * making that bounded query score-exact by construction.
 */
export function resolveWindowBounds(
  latestTradeTs: number | null,
  now: Date,
  windowMinutes: number
): { from: Date; to: Date } {
  const to = latestTradeTs !== null && latestTradeTs < now.getTime() ? new Date(latestTradeTs) : now;
  const from = new Date(to.getTime() - windowMinutes * MIN_MS);
  return { from, to };
}

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
  const { from, to } = resolveWindowBounds(latestTradeTs, now, windowMinutes);

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
  // Union (OR), not the human_like-only count — Task 15 Fix A: Rule C's
  // contract is "70%+ buying wallets are human_like OR smart_money", which
  // humanLikeCount alone cannot represent for scenarios whose smart cohort
  // is split across both labels. humanLikeCount itself stays untouched
  // (flowScore.ts's humanRatio component depends on it as-is).
  const humanOrSmartLabelCount = buyers.filter(
    (b) => b.labels.includes('human_like') || b.labels.includes('smart_money')
  ).length;
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

  // -- exitedSmartPct / topHolderExits (Task 15 Fix B: HOLDER-based, not
  // window-buyer-based) -----------------------------------------------------
  //
  // Bug this replaces: the prior implementation measured "% of window BUYERS
  // who sold >= 80% of their OWN window buyUsd" — a wallet whose accumulation
  // buys sit entirely BEFORE `from` (any window position opened earlier than
  // the lookback) was never a "buyer" this window at all, so a scripted
  // accumulate-then-dump-much-later scenario (buys ~60h before the sell
  // burst, e.g. $DUMP) could never contribute to either metric: its sellers
  // have zero in-window BUY, so they were invisible to the old buyer-keyed
  // population. Rule G's exit disjuncts could then never fire for exactly
  // the pattern they exist to detect.
  //
  // Fix: define the exit population from PRE-WINDOW POSITION instead of
  // in-window buying activity.
  //   preWindowNetUsd[wallet] = sum(BUY.amountUsd) - sum(SELL.amountUsd)
  //     over ALL trades (in the full, unfiltered `trades` input) strictly
  //     BEFORE `from` (not clipped to `wallets`/`buyers` — any wallet that
  //     traded this token pre-window can be a "holder").
  //   holdersAtWindowStart = wallets with preWindowNetUsd > 0 (a real net
  //     position going into the window, on a USD basis per the brief).
  //   exitedSmartPct = % of SMART holders-at-window-start (isWatched OR
  //     meetsProfitable, same union `isSmart` uses elsewhere in this file)
  //     whose IN-WINDOW sellUsd >= 80% of their preWindowNetUsd.
  //   topHolderExits = among the top-5 holders-at-window-start BY
  //     preWindowNetUsd (descending, NOT restricted to smart — mirrors the
  //     prior implementation's "not smart-specific" framing for this
  //     metric), count how many sold >= 80% of that pre-window position
  //     in-window.
  //
  // Union addition (documented per the brief): a SMART wallet whose FIRST
  // activity on this token is inside the window itself (preWindowNetUsd <= 0
  // -- it holds no pre-window position, so it can never appear in
  // holdersAtWindowStart) but who buys AND then dumps >= 80% of that SAME
  // window's buy within the window is a legitimate "exited" pattern the
  // pure holder-based definition would otherwise structurally miss (a
  // brand-new position opened and fully exited within one window). This is
  // the ORIGINAL window-relative definition, kept as a second population
  // unioned into exitedSmartPct's numerator/denominator alongside the new
  // holder-based population (topHolderExits stays holder-only — a
  // zero-pre-window-position wallet has no "pre-window net position" to
  // rank by, so it cannot naturally join a "top-5 by pre-window position"
  // ordering; see this metric's own definition above).
  const preWindowNetUsdByWallet = new Map<string, number>();
  for (const t of trades) {
    if (t.ts.getTime() >= from.getTime()) continue; // strictly BEFORE `from`
    const current = preWindowNetUsdByWallet.get(t.walletId) ?? 0;
    preWindowNetUsdByWallet.set(t.walletId, current + (t.action === 'BUY' ? t.amountUsd : -t.amountUsd));
  }

  const holdersAtWindowStart = [...preWindowNetUsdByWallet.entries()]
    .filter(([, netUsd]) => netUsd > 0)
    .map(([walletId, netUsd]) => ({ walletId, netUsd }));

  const inWindowSellUsd = (walletId: string): number => accByWallet.get(walletId)?.sellUsd ?? 0;

  const smartHolderExitedIds = new Set(
    holdersAtWindowStart
      .filter(({ walletId }) => isSmart(walletId))
      .filter(({ walletId, netUsd }) => (inWindowSellUsd(walletId) / netUsd) * 100 >= EXIT_POSITION_SOLD_PCT)
      .map(({ walletId }) => walletId)
  );
  const smartHolderIds = new Set(holdersAtWindowStart.filter(({ walletId }) => isSmart(walletId)).map((h) => h.walletId));

  // Union addition: smart buyers with NO pre-window position (not already in
  // smartHolderIds) whose window buyUsd was itself >= 80% sold within the
  // SAME window (the original window-relative "exited" definition).
  const smartWindowOnlyExitedIds = new Set(
    smartBuyerIds.filter((walletId) => {
      if (smartHolderIds.has(walletId)) return false; // already counted via the holder-based population
      const acc = accByWallet.get(walletId)!;
      return acc.buyUsd > 0 && (acc.sellUsd / acc.buyUsd) * 100 >= EXIT_POSITION_SOLD_PCT;
    })
  );
  const smartWindowOnlyIds = new Set(smartBuyerIds.filter((walletId) => !smartHolderIds.has(walletId)));

  const exitedSmartDenominator = smartHolderIds.size + smartWindowOnlyIds.size;
  const exitedSmartNumerator = smartHolderExitedIds.size + smartWindowOnlyExitedIds.size;
  const exitedSmartPct = exitedSmartDenominator > 0 ? (exitedSmartNumerator / exitedSmartDenominator) * 100 : 0;

  // -- topHolderExits (pure holder-based; see comment block above) ---------
  const topHoldersByPreWindowNet = [...holdersAtWindowStart].sort((a, b) => b.netUsd - a.netUsd).slice(0, TOP_HOLDER_COUNT);
  const topHolderExits = topHoldersByPreWindowNet.filter(
    ({ walletId, netUsd }) => (inWindowSellUsd(walletId) / netUsd) * 100 >= EXIT_POSITION_SOLD_PCT
  ).length;

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
    humanOrSmartLabelCount,
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
