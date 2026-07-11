// FlowRadar — Historical Runner-Origin Wallet Mining: pure engine (Task 2).
// Design: docs/RUNNER_MINING_DESIGN.md.
//
// Two pure functions with a HARD WALL between them:
//
//   computeTokenOutcome(series, cfg)  — EVALUATION-ONLY. Reads the FULL series
//     and produces outcome labels (runner multiples, mcap milestones,
//     failure classes). Outcomes are stored/joined separately and may never
//     feed an entry-time feature.
//
//   computeEntryContext(buyTs, series, cfg) — entry-time reconstruction. The
//     FIRST thing it does is truncate the series to ts <= buyTs, so a future
//     point is structurally unreadable (no-lookahead by construction, covered
//     by a truncation-equivalence property test). Unknown stays UNKNOWN:
//     no prior point within the max age ⇒ status 'unavailable', mcap null,
//     bucket 'unknown' — never $0, never current-price-as-historical
//     (current_price_estimate is a LIVE-monitoring status; historical mining
//     never emits it).
//
// Shadow-only: nothing here touches FlowScore, thresholds, or eligibility.
// No Date.now / randomness — fully deterministic over inputs.

export interface TokenSeriesPoint {
  ts: Date;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
}

export type RunnerOutcomeLabel =
  | 'runner_2x'
  | 'runner_5x'
  | 'runner_10x'
  | 'runner_50x'
  | 'reached_1m_mcap'
  | 'reached_10m_mcap'
  | 'reached_100m_mcap'
  | 'seven_figure_runner'
  | 'eight_figure_runner'
  | 'failed_launch'
  | 'rug_or_collapse'
  | 'illiquid_untradeable'
  | 'insufficient_data';

export interface RunnerMiningConfig {
  /** Runner multiples measured from the BASELINE (first valid mcap observation). */
  runnerMultiples: { x2: number; x5: number; x10: number; x50: number };
  /** Absolute mcap milestones (USD). */
  mcapMilestones: { m1: number; m10: number; m100: number };
  /** ATH-mcap bands for the figure-class labels [min, max). */
  sevenFigureBand: { min: number; max: number };
  eightFigureBand: { min: number; max: number };
  /** Peak-to-trough decline (percent) at/above which the token is a rug/collapse. */
  rugCollapsePct: number;
  /** Liquidity floor (USD): below it a market is not really tradeable. */
  liquidityFloorUsd: number;
  /** Minimum valid-mcap points a series needs before any judgment. */
  minSeriesPoints: number;
  /** Max age of the nearest-prior snapshot still usable at entry (seconds). */
  maxEntrySnapshotAgeSec: number;
  /** The research focus ceiling (spec: $20k, configurable). */
  lowMcapFocusCeilingUsd: number;
}

export const DEFAULT_RUNNER_MINING_CONFIG: RunnerMiningConfig = {
  runnerMultiples: { x2: 2, x5: 5, x10: 10, x50: 50 },
  mcapMilestones: { m1: 1_000_000, m10: 10_000_000, m100: 100_000_000 },
  sevenFigureBand: { min: 1_000_000, max: 10_000_000 },
  eightFigureBand: { min: 10_000_000, max: 100_000_000 },
  rugCollapsePct: 90,
  liquidityFloorUsd: 1_000,
  minSeriesPoints: 3,
  maxEntrySnapshotAgeSec: 3_600,
  lowMcapFocusCeilingUsd: 20_000
};
Object.freeze(DEFAULT_RUNNER_MINING_CONFIG.runnerMultiples);
Object.freeze(DEFAULT_RUNNER_MINING_CONFIG.mcapMilestones);
Object.freeze(DEFAULT_RUNNER_MINING_CONFIG.sevenFigureBand);
Object.freeze(DEFAULT_RUNNER_MINING_CONFIG.eightFigureBand);
Object.freeze(DEFAULT_RUNNER_MINING_CONFIG);

// ---------------------------------------------------------------------------
// Outcome (evaluation-only)
// ---------------------------------------------------------------------------

export interface TokenOutcome {
  labels: RunnerOutcomeLabel[];
  baselineMcapUsd: number | null;
  baselineTs: Date | null;
  athMcapUsd: number | null;
  athTs: Date | null;
  maxMultipleFromBaseline: number | null;
  /** Largest peak-to-later-trough decline among VALID points, percent (0 when never declined). */
  maxDrawdownPct: number | null;
  /** Minutes from baseline to FIRST crossing; null = never crossed. */
  timeToMilestonesMin: {
    x2: number | null;
    x5: number | null;
    x10: number | null;
    mcap1m: number | null;
    mcap10m: number | null;
  };
  finalLiquidityUsd: number | null;
  confidence: 'high' | 'medium' | 'low';
  dataQuality: string[];
}

function validMcapPoints(series: TokenSeriesPoint[]): { ts: number; mcap: number; liq: number | null }[] {
  return series
    .filter((p) => p.marketCapUsd !== null && Number.isFinite(p.marketCapUsd) && p.marketCapUsd! > 0)
    .map((p) => ({ ts: p.ts.getTime(), mcap: p.marketCapUsd!, liq: p.liquidityUsd }))
    .sort((a, b) => a.ts - b.ts);
}

export function computeTokenOutcome(series: TokenSeriesPoint[], cfg: RunnerMiningConfig): TokenOutcome {
  const pts = validMcapPoints(series);
  const dataQuality: string[] = [];

  const empty: TokenOutcome = {
    labels: ['insufficient_data'],
    baselineMcapUsd: null,
    baselineTs: null,
    athMcapUsd: null,
    athTs: null,
    maxMultipleFromBaseline: null,
    maxDrawdownPct: null,
    timeToMilestonesMin: { x2: null, x5: null, x10: null, mcap1m: null, mcap10m: null },
    finalLiquidityUsd: null,
    confidence: 'low',
    dataQuality: [`only ${pts.length} valid-mcap points (< ${cfg.minSeriesPoints}) — no judgment`]
  };
  if (pts.length < cfg.minSeriesPoints) return empty;

  const baseline = pts[0]!;
  let ath = baseline;
  let peakSoFar = baseline.mcap;
  let maxDrawdownPct = 0;
  const firstCross = { x2: null as number | null, x5: null as number | null, x10: null as number | null, mcap1m: null as number | null, mcap10m: null as number | null };

  for (const p of pts) {
    if (p.mcap > ath.mcap) ath = p;
    if (p.mcap > peakSoFar) peakSoFar = p.mcap;
    const drawdown = peakSoFar > 0 ? ((peakSoFar - p.mcap) / peakSoFar) * 100 : 0;
    if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
    const minutes = Math.round((p.ts - baseline.ts) / 60_000);
    if (firstCross.x2 === null && p.mcap >= baseline.mcap * cfg.runnerMultiples.x2) firstCross.x2 = minutes;
    if (firstCross.x5 === null && p.mcap >= baseline.mcap * cfg.runnerMultiples.x5) firstCross.x5 = minutes;
    if (firstCross.x10 === null && p.mcap >= baseline.mcap * cfg.runnerMultiples.x10) firstCross.x10 = minutes;
    if (firstCross.mcap1m === null && p.mcap >= cfg.mcapMilestones.m1) firstCross.mcap1m = minutes;
    if (firstCross.mcap10m === null && p.mcap >= cfg.mcapMilestones.m10) firstCross.mcap10m = minutes;
  }

  const maxMultiple = baseline.mcap > 0 ? ath.mcap / baseline.mcap : null;
  const labels: RunnerOutcomeLabel[] = [];

  if (maxMultiple !== null) {
    if (maxMultiple >= cfg.runnerMultiples.x2) labels.push('runner_2x');
    if (maxMultiple >= cfg.runnerMultiples.x5) labels.push('runner_5x');
    if (maxMultiple >= cfg.runnerMultiples.x10) labels.push('runner_10x');
    if (maxMultiple >= cfg.runnerMultiples.x50) labels.push('runner_50x');
  }
  if (ath.mcap >= cfg.mcapMilestones.m1) labels.push('reached_1m_mcap');
  if (ath.mcap >= cfg.mcapMilestones.m10) labels.push('reached_10m_mcap');
  if (ath.mcap >= cfg.mcapMilestones.m100) labels.push('reached_100m_mcap');
  if (ath.mcap >= cfg.sevenFigureBand.min && ath.mcap < cfg.sevenFigureBand.max) labels.push('seven_figure_runner');
  if (ath.mcap >= cfg.eightFigureBand.min && ath.mcap < cfg.eightFigureBand.max) labels.push('eight_figure_runner');

  // Liquidity assessment over points that CARRY liquidity (null = unknown,
  // not zero — unknown liquidity is a data-quality note, never a failure claim).
  const liqPts = pts.filter((p) => p.liq !== null && Number.isFinite(p.liq!));
  const everLiquid = liqPts.some((p) => p.liq! >= cfg.liquidityFloorUsd);
  const finalLiq = liqPts.length > 0 ? liqPts[liqPts.length - 1]!.liq! : null;
  if (liqPts.length === 0) dataQuality.push('no liquidity data — tradeability unknown');

  if (liqPts.length > 0 && !everLiquid) {
    labels.push('illiquid_untradeable');
    dataQuality.push(`liquidity never reached the $${cfg.liquidityFloorUsd} floor — price moves may be fake markups`);
  }
  if (maxDrawdownPct >= cfg.rugCollapsePct && finalLiq !== null && finalLiq < cfg.liquidityFloorUsd) {
    labels.push('rug_or_collapse');
  } else if (maxDrawdownPct >= cfg.rugCollapsePct) {
    labels.push('rug_or_collapse'); // collapse by drawdown alone still qualifies
    dataQuality.push('collapse by drawdown; final liquidity above floor or unknown');
  }
  if (
    (maxMultiple === null || maxMultiple < cfg.runnerMultiples.x2) &&
    finalLiq !== null &&
    finalLiq < cfg.liquidityFloorUsd &&
    !labels.includes('rug_or_collapse')
  ) {
    labels.push('failed_launch');
  }
  // NOTE: labels may legitimately be EMPTY — an evaluable token with no
  // notable outcome (e.g. drifts sideways/down on healthy liquidity). That is
  // DISTINCT from insufficient_data (which means we could not judge at all).
  // Confidence: penalise unknown liquidity, fake-markup suspicion, sparse series.
  let confidence: TokenOutcome['confidence'] = 'high';
  if (labels.includes('illiquid_untradeable') || liqPts.length === 0) confidence = 'medium';
  if (pts.length < cfg.minSeriesPoints * 2) confidence = confidence === 'high' ? 'medium' : 'low';

  return {
    labels,
    baselineMcapUsd: baseline.mcap,
    baselineTs: new Date(baseline.ts),
    athMcapUsd: ath.mcap,
    athTs: new Date(ath.ts),
    maxMultipleFromBaseline: maxMultiple,
    maxDrawdownPct,
    timeToMilestonesMin: firstCross,
    finalLiquidityUsd: finalLiq,
    confidence,
    dataQuality
  };
}

// ---------------------------------------------------------------------------
// Entry context (no-lookahead)
// ---------------------------------------------------------------------------

export type EntryMcapBucket =
  | 'under_5k'
  | '5k_to_10k'
  | '10k_to_20k'
  | '20k_to_50k'
  | '50k_to_100k'
  | '100k_to_250k'
  | '250k_to_1m'
  | 'above_1m'
  | 'unknown';

export function entryMcapBucket(mcapUsd: number | null): EntryMcapBucket {
  if (mcapUsd === null || !Number.isFinite(mcapUsd) || mcapUsd < 0) return 'unknown';
  if (mcapUsd < 5_000) return 'under_5k';
  if (mcapUsd < 10_000) return '5k_to_10k';
  if (mcapUsd < 20_000) return '10k_to_20k';
  if (mcapUsd < 50_000) return '20k_to_50k';
  if (mcapUsd < 100_000) return '50k_to_100k';
  if (mcapUsd < 250_000) return '100k_to_250k';
  if (mcapUsd < 1_000_000) return '250k_to_1m';
  return 'above_1m';
}

/** Historical mining statuses ONLY — current_price_estimate is deliberately absent. */
export type EntryValuationStatus = 'nearest_prior_snapshot' | 'unavailable';

export interface EntryContext {
  entryPriceUsd: number | null;
  entryMarketCapUsd: number | null;
  entryLiquidityUsd: number | null;
  priceTimestamp: Date | null;
  valuationStatus: EntryValuationStatus;
  valuationAgeSeconds: number | null;
  /** 1 at age 0, linearly decaying to 0.25 at maxEntrySnapshotAgeSec; 0 when unavailable. */
  valuationConfidence: number;
  bucket: EntryMcapBucket;
  /** True/false only when the mcap is KNOWN; null = unknown (never defaulted). */
  belowFocusCeiling: boolean | null;
}

export function computeEntryContext(
  buyTs: Date,
  series: TokenSeriesPoint[],
  cfg: RunnerMiningConfig
): EntryContext {
  const buyMs = buyTs.getTime();
  // STRUCTURAL no-lookahead: everything after the buy is discarded FIRST.
  const prior = series.filter((p) => p.ts.getTime() <= buyMs);

  const unavailable: EntryContext = {
    entryPriceUsd: null,
    entryMarketCapUsd: null,
    entryLiquidityUsd: null,
    priceTimestamp: null,
    valuationStatus: 'unavailable',
    valuationAgeSeconds: null,
    valuationConfidence: 0,
    bucket: 'unknown',
    belowFocusCeiling: null
  };

  // Nearest prior point that actually carries a market cap.
  let best: TokenSeriesPoint | null = null;
  for (const p of prior) {
    if (p.marketCapUsd === null || !Number.isFinite(p.marketCapUsd) || p.marketCapUsd <= 0) continue;
    if (best === null || p.ts.getTime() > best.ts.getTime()) best = p;
  }
  if (best === null) return unavailable;

  const ageSec = Math.round((buyMs - best.ts.getTime()) / 1000);
  if (ageSec > cfg.maxEntrySnapshotAgeSec) return unavailable; // stale ⇒ unknown, never "close enough"

  const mcap = best.marketCapUsd!;
  const ageFraction = cfg.maxEntrySnapshotAgeSec > 0 ? ageSec / cfg.maxEntrySnapshotAgeSec : 0;
  const valuationConfidence = 1 - 0.75 * Math.min(1, Math.max(0, ageFraction));

  return {
    entryPriceUsd: best.priceUsd,
    entryMarketCapUsd: mcap,
    entryLiquidityUsd: best.liquidityUsd,
    priceTimestamp: new Date(best.ts.getTime()),
    valuationStatus: 'nearest_prior_snapshot',
    valuationAgeSeconds: ageSec,
    valuationConfidence,
    bucket: entryMcapBucket(mcap),
    belowFocusCeiling: mcap < cfg.lowMcapFocusCeilingUsd
  };
}
