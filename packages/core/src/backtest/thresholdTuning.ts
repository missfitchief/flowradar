// FlowRadar — tuneThresholds: pure OAT (one-dimension-at-a-time) threshold
// sweep (Task 41 binding decision 3).
//
// ---------------------------------------------------------------------------
// Why OAT, not full cartesian product (documented rationale, per the task
// brief's explicit requirement)
// ---------------------------------------------------------------------------
// The grid has 6 dimensions with up to 4 values each. A full cartesian sweep
// would replay+evaluate 4*3*4*3*3*3 = 1296 distinct settings variants against
// the FULL input series — for a historical replay that already walks
// hundreds of steps per variant, this is combinatorial-explosion territory
// with no proportional signal-quality benefit (most of the search space is
// "vary two knobs at once", which this task has no requirement to explore).
// Instead, tuneThresholds holds every dimension at baseSettings EXCEPT ONE,
// sweeps that one dimension across its own grid values, and repeats per
// dimension — bounded compute: sum(dimension sizes) + 1 (the base set
// itself) total replay runs, e.g. 4+3+4+3+3+3+1 = 21 runs for the brief's own
// grid, instead of 1296.
//
// ---------------------------------------------------------------------------
// Scoring (documented)
// ---------------------------------------------------------------------------
// Each candidate threshold set is scored by hitRate2x among ALL Rule A/F
// signals that set's own replay+evaluate run produced (Rule A/F specifically
// — these are the two rules directly shaped by this grid's dimensions;
// scoring against all 7 rules would let unrelated rule noise drown out the
// very thresholds being swept). A set producing FEWER than MIN_SUFFICIENT_
// SAMPLE_SIZE (5) signals is flagged `insufficientSample: true` and scored 0
// regardless of its raw hitRate2x — a 100% hit rate on 1 signal is not
// evidence of anything, and must never outrank a lower-but-real hit rate
// backed by a real sample.
//
// ---------------------------------------------------------------------------
// Settings-mapping for each grid dimension
// ---------------------------------------------------------------------------
// minWallets        -> settings.rules.A.minWallets (the HIGH-tier wallet floor)
// maxSoldPct        -> settings.rules.A.maxSoldPct
// maxMcapExpansion  -> settings.rules.B.maxMcapExpansion
// minLiquidity      -> settings.rules.A.minLiquidityUsd
// minEntities/minNetFlow have no direct Settings field (Rule A's own gates
//   are netFlowUsd > 0 and uniqueEntityCount is descriptive-only today) — for
//   these two dimensions, tuning applies the value as a POST-HOC filter over
//   each candidate run's own Rule A signals (metrics.uniqueEntityCount >=
//   value / metrics.netFlowUsd >= value) rather than a settings override,
//   since there is nothing in Settings to override.

import { replaySignals } from './replay';
import type { ReplaySignalsInput, ReplayedSignal } from './replay';
import { evaluateReplay, rulePerformance } from './rulePerf';
import type { MarketPoint } from './evaluate';
import type { Settings } from '../settings';
import type { BacktestHorizon } from '../types';

export interface ThresholdSweepGrid {
  minWallets: number[];
  minEntities: number[];
  minNetFlow: number[];
  maxSoldPct: number[];
  maxMcapExpansion: number[];
  minLiquidity: number[];
}

export type TuneThresholdsInputs = Omit<ReplaySignalsInput, 'settings'> & {
  marketSeriesByToken: Map<string, (MarketPoint & { source?: string })[]>;
  horizons?: BacktestHorizon[];
};

export interface ThresholdSet {
  dimension: string;
  value: number;
  settings: Settings;
  signalCount: number;
  hitRate2x: number;
  score: number;
  insufficientSample: boolean;
}

export interface TuneThresholdsResult {
  allSets: ThresholdSet[];
  best: ThresholdSet[];
  worst: ThresholdSet[];
  precisionByRule: Record<string, number>;
  recommendedDefaults: { settings: Settings; diff: Record<string, { from: unknown; to: unknown }> };
  overfittingWarning: string;
}

const MIN_SUFFICIENT_SAMPLE_SIZE = 5;
const BEST_WORST_COUNT = 3;

function cloneSettings(base: Settings): Settings {
  return JSON.parse(JSON.stringify(base)) as Settings;
}

/** Applies a single dimension override on top of a settings clone; returns [settings, postHocFilter | null]. */
function applyDimension(
  base: Settings,
  dimension: keyof ThresholdSweepGrid,
  value: number
): { settings: Settings; postHocMinEntities?: number; postHocMinNetFlow?: number } {
  const settings = cloneSettings(base);
  switch (dimension) {
    case 'minWallets':
      settings.rules.A.minWallets = value;
      return { settings };
    case 'maxSoldPct':
      settings.rules.A.maxSoldPct = value;
      return { settings };
    case 'maxMcapExpansion':
      settings.rules.B.maxMcapExpansion = value;
      return { settings };
    case 'minLiquidity':
      settings.rules.A.minLiquidityUsd = value;
      return { settings };
    case 'minEntities':
      return { settings, postHocMinEntities: value };
    case 'minNetFlow':
      return { settings, postHocMinNetFlow: value };
    default:
      return { settings };
  }
}

function asNumber(v: number | string | boolean | undefined): number | null {
  return typeof v === 'number' ? v : null;
}

function runOneVariant(
  inputs: TuneThresholdsInputs,
  dimension: string,
  value: number,
  settings: Settings,
  postHocMinEntities: number | undefined,
  postHocMinNetFlow: number | undefined
): ThresholdSet {
  const { marketSeriesByToken, horizons, ...replayInput } = inputs;

  let replayed: ReplayedSignal[] = replaySignals({ ...replayInput, settings });

  if (postHocMinEntities !== undefined) {
    replayed = replayed.filter((s) => {
      if (s.rule !== 'A') return true;
      const count = asNumber(s.metrics.uniqueEntityCount);
      return count !== null && count >= postHocMinEntities;
    });
  }
  if (postHocMinNetFlow !== undefined) {
    replayed = replayed.filter((s) => {
      if (s.rule !== 'A') return true;
      const netFlow = asNumber(s.metrics.netFlowUsd);
      return netFlow !== null && netFlow >= postHocMinNetFlow;
    });
  }

  const evaluated = evaluateReplay(replayed, marketSeriesByToken, horizons);
  const relevant = evaluated.filter((e) => e.signal.rule === 'A' || e.signal.rule === 'F');
  const signalCount = relevant.length;
  const hit2xCount = relevant.filter((e) => e.outcome.hit2x).length;
  const hitRate2x = signalCount > 0 ? hit2xCount / signalCount : 0;

  const insufficientSample = signalCount < MIN_SUFFICIENT_SAMPLE_SIZE;
  const score = insufficientSample ? 0 : hitRate2x;

  return { dimension, value, settings, signalCount, hitRate2x, score, insufficientSample };
}

/**
 * Runs the OAT threshold sweep. For each dimension in `grid`, varies ONLY
 * that dimension across its own values (holding all others at baseSettings)
 * and replays+evaluates the resulting settings variant against `inputs`. The
 * base settings themselves are also run once (dimension: 'base').
 */
export function tuneThresholds(args: {
  inputs: TuneThresholdsInputs;
  grid: ThresholdSweepGrid;
  baseSettings: Settings;
}): TuneThresholdsResult {
  const { inputs, grid, baseSettings } = args;

  const allSets: ThresholdSet[] = [];

  // Base set itself.
  const baseResult = runOneVariant(inputs, 'base', 0, cloneSettings(baseSettings), undefined, undefined);
  allSets.push(baseResult);

  for (const dimension of Object.keys(grid) as (keyof ThresholdSweepGrid)[]) {
    for (const value of grid[dimension]) {
      const { settings, postHocMinEntities, postHocMinNetFlow } = applyDimension(baseSettings, dimension, value);
      allSets.push(runOneVariant(inputs, dimension, value, settings, postHocMinEntities, postHocMinNetFlow));
    }
  }

  const sorted = [...allSets].sort((a, b) => b.score - a.score);
  const best = sorted.slice(0, BEST_WORST_COUNT);
  const worst = [...sorted].reverse().slice(0, BEST_WORST_COUNT);

  // precisionByRule: hitRate2x per rule, computed from the BASE set's own
  // replayed+evaluated signals (a representative single run — sweeping
  // precision per rule per threshold-set would multiply output size for
  // little added value beyond what best/worst already surfaces).
  const { marketSeriesByToken, horizons, ...replayInput } = inputs;
  const baseReplayed = replaySignals({ ...replayInput, settings: baseSettings });
  const baseEvaluated = evaluateReplay(baseReplayed, marketSeriesByToken, horizons);
  const perf = rulePerformance(baseEvaluated);
  const precisionByRule: Record<string, number> = {};
  for (const rule of Object.keys(perf) as (keyof typeof perf)[]) {
    precisionByRule[rule] = perf[rule].real.hitRate2x;
  }

  // recommendedDefaults: the best-scoring set's settings, diffed field-by-field
  // (per swept dimension only) against DEFAULT_SETTINGS-shaped baseSettings.
  const recommendedSettings = best[0]?.settings ?? cloneSettings(baseSettings);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const dimensionToPath: Record<string, string> = {
    minWallets: 'rules.A.minWallets',
    maxSoldPct: 'rules.A.maxSoldPct',
    maxMcapExpansion: 'rules.B.maxMcapExpansion',
    minLiquidity: 'rules.A.minLiquidityUsd'
  };
  const bestDimension = best[0]?.dimension;
  if (bestDimension && dimensionToPath[bestDimension]) {
    const path = dimensionToPath[bestDimension]!.split('.');
    let fromVal: unknown = baseSettings;
    let toVal: unknown = recommendedSettings;
    for (const key of path) {
      fromVal = (fromVal as Record<string, unknown>)[key];
      toVal = (toVal as Record<string, unknown>)[key];
    }
    if (fromVal !== toVal) {
      diff[dimensionToPath[bestDimension]!] = { from: fromVal, to: toVal };
    }
  }

  const smallestBestSampleSize = best.length > 0 ? Math.min(...best.map((s) => s.signalCount)) : 0;
  const overfittingWarning =
    `OVERFITTING WARNING: threshold tuning was performed on a single historical replay sample. ` +
    `The best-ranked set${best.length > 0 ? ` (dimension='${best[0]!.dimension}', value=${best[0]!.value})` : ''} ` +
    `was selected from ${allSets.length} candidate sets evaluated on the SAME data used to score them ` +
    `(smallest best-set sample size: ${smallestBestSampleSize} signals). ` +
    `A threshold set that wins on one historical window may not generalize — ALWAYS confirm with walkForward() ` +
    `validation on a held-out period before promoting any recommendation to production defaults. ` +
    `Small sample sizes (< ${MIN_SUFFICIENT_SAMPLE_SIZE} signals) are especially prone to overstating hit rate.`;

  return {
    allSets,
    best,
    worst,
    precisionByRule,
    recommendedDefaults: { settings: recommendedSettings, diff },
    overfittingWarning
  };
}
