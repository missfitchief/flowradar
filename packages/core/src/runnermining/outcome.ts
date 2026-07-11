// FlowRadar — runner-mining OUTCOME side (Task 2). EVALUATION-ONLY.
//
// Reads the FULL series and produces outcome labels. Outcomes are stored and
// joined separately; the entry side (./entry.ts) can never import this module
// (static leak-guard test). Duplicate timestamps sort deterministically
// (ts, then mcap ascending) so input order can never flip a label.
//
// BASELINE HONESTY (Codex): the baseline is the FIRST OBSERVED valid point —
// our snapshot history is forward-only from DB entry, so a late-discovered
// token has a window-relative baseline and its multiples may be UNDERSTATED.
// Unless the caller declares the series launch-anchored, every outcome says
// so in dataQuality and confidence is capped at 'medium'.

import type { RunnerMiningConfig, TokenSeriesPoint } from './types';
import { validateRunnerMiningConfig } from './types';

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

export interface TokenOutcomeOptions {
  /**
   * True ONLY when the series provably starts at token launch/pool creation
   * (e.g. a launch-anchored backfill). Default false: baseline is
   * window-relative, noted in dataQuality, confidence capped at 'medium'.
   */
  anchoredAtLaunch?: boolean;
}

export interface TokenOutcome {
  labels: RunnerOutcomeLabel[];
  baselineMcapUsd: number | null;
  baselineTs: Date | null;
  /** First-observation timestamp — outcomes are relative to this window start. */
  observationStartTs: Date | null;
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
    // Deterministic total order: ts, then mcap — duplicate-timestamp input
    // order can never flip drawdown/ATH results (Codex).
    .sort((a, b) => a.ts - b.ts || a.mcap - b.mcap);
}

export function computeTokenOutcome(
  series: TokenSeriesPoint[],
  cfg: RunnerMiningConfig,
  opts: TokenOutcomeOptions = {}
): TokenOutcome {
  validateRunnerMiningConfig(cfg);
  const pts = validMcapPoints(series);
  const anchored = opts.anchoredAtLaunch === true;
  const dataQuality: string[] = [];

  const empty: TokenOutcome = {
    labels: ['insufficient_data'],
    baselineMcapUsd: null,
    baselineTs: null,
    observationStartTs: pts.length > 0 ? new Date(pts[0]!.ts) : null,
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
  const seenTs = new Set<number>();
  let duplicateTs = false;

  for (const p of pts) {
    if (seenTs.has(p.ts)) duplicateTs = true;
    seenTs.add(p.ts);
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
  if (duplicateTs) dataQuality.push('duplicate timestamps in series — tie order resolved deterministically (ts, mcap)');

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

  // Liquidity assessment over ALL series points that CARRY liquidity — a
  // terminal { mcap: null, liquidity: 0 } point is liquidity-death evidence
  // and must not be discarded just because its mcap is missing (Codex).
  const liqSeries = series
    .filter((p) => p.liquidityUsd !== null && Number.isFinite(p.liquidityUsd))
    .map((p) => ({ ts: p.ts.getTime(), liq: p.liquidityUsd! }))
    .sort((a, b) => a.ts - b.ts);
  const everLiquid = liqSeries.some((p) => p.liq >= cfg.liquidityFloorUsd);
  const finalLiq = liqSeries.length > 0 ? liqSeries[liqSeries.length - 1]!.liq : null;
  if (liqSeries.length === 0) dataQuality.push('no liquidity data — tradeability unknown');

  if (liqSeries.length > 0 && !everLiquid) {
    labels.push('illiquid_untradeable');
    dataQuality.push(`liquidity never reached the $${cfg.liquidityFloorUsd} floor — price moves may be fake markups`);
  }
  if (maxDrawdownPct >= cfg.rugCollapsePct) {
    labels.push('rug_or_collapse');
    if (finalLiq === null || finalLiq >= cfg.liquidityFloorUsd) {
      dataQuality.push('collapse by drawdown; final liquidity above floor or unknown');
    }
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
  // notable outcome. That is DISTINCT from insufficient_data.

  let confidence: TokenOutcome['confidence'] = 'high';
  if (labels.includes('illiquid_untradeable') || liqSeries.length === 0) confidence = 'medium';
  if (pts.length < cfg.minSeriesPoints * 2) confidence = confidence === 'high' ? 'medium' : 'low';
  if (!anchored) {
    // Window-relative baseline: multiples may be understated for tokens that
    // entered our observation window late. Say so, and never claim 'high'.
    dataQuality.push('baseline = first OBSERVED point (window-relative, not launch-anchored) — runner multiples may be understated');
    if (confidence === 'high') confidence = 'medium';
  }

  return {
    labels,
    baselineMcapUsd: baseline.mcap,
    baselineTs: new Date(baseline.ts),
    observationStartTs: new Date(baseline.ts),
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
