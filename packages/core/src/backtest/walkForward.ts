// FlowRadar — walkForward: pure walk-forward validation (Task 41 binding
// decision 4).
//
// Splits [from, to] into a TUNE half ([from, splitAt]) and a TEST half
// ([splitAt (exclusive), to]) — never overlapping, so a threshold set is
// NEVER tuned and tested on the same sample. tuneThresholds() picks the
// best-scoring set using ONLY the tune half's replay inputs (trades/market
// points/etc are filtered to ts <= splitAt before ever reaching
// tuneThresholds), then that SAME settings object is replayed+evaluated
// AGAIN from scratch against ONLY the test half's inputs (ts > splitAt) to
// produce testSummary. degradationPct compares the test half's hitRate2x
// against the tune half's own best-set hitRate2x (positive = degradation,
// i.e. test performed worse than tune).
//
// Verdict thresholds (documented, per task brief "thresholds documented"):
//   degradationPct > DEGRADATION_THRESHOLD_PCT (30) => 'degrades — likely overfit'
//   otherwise                                        => 'holds up'
// A test half producing ZERO Rule A/F signals (tuneHitRate > 0 but nothing to
// measure against) is treated as maximal degradation (100%) — "the tuned
// set stopped firing entirely on unseen data" is itself evidence of
// overfitting, not a neutral result.

import { replaySignals } from './replay';
import type { ReplaySignalsInput } from './replay';
import { evaluateReplay } from './rulePerf';
import { tuneThresholds } from './thresholdTuning';
import type { ThresholdSweepGrid, TuneThresholdsInputs } from './thresholdTuning';
import type { MarketPoint } from './evaluate';
import type { Settings } from '../settings';
import type { BacktestHorizon } from '../types';

const DEGRADATION_THRESHOLD_PCT = 30;

export type WalkForwardInputs = Omit<ReplaySignalsInput, 'settings'> & {
  marketSeriesByToken: Map<string, (MarketPoint & { source?: string })[]>;
  horizons?: BacktestHorizon[];
};

export interface WalkForwardHalfSummary {
  signalCount: number;
  hitRate2x: number;
}

export interface WalkForwardResult {
  tunedOn: Settings;
  tuneSummary: WalkForwardHalfSummary;
  testSummary: WalkForwardHalfSummary;
  degradationPct: number;
  verdict: 'holds up' | 'degrades — likely overfit';
}

function filterInputsToWindow(inputs: WalkForwardInputs, windowFrom: Date, windowTo: Date): TuneThresholdsInputs {
  const { marketSeriesByToken, horizons, ...rest } = inputs;
  const inWindow = (ts: Date) => ts.getTime() >= windowFrom.getTime() && ts.getTime() <= windowTo.getTime();

  const filteredSeriesByToken = new Map(
    [...marketSeriesByToken.entries()].map(([tokenId, series]) => [tokenId, series.filter((p) => inWindow(p.ts))])
  );

  return {
    ...rest,
    trades: rest.trades.filter((t) => inWindow(t.ts)),
    marketPoints: rest.marketPoints.filter((m) => inWindow(m.ts)),
    fundingEvents: rest.fundingEvents.filter((f) => inWindow(f.ts)),
    rotationCandidates: rest.rotationCandidates.filter((r) => inWindow(r.destBuyTs)),
    from: windowFrom,
    to: windowTo,
    marketSeriesByToken: filteredSeriesByToken,
    ...(horizons ? { horizons } : {})
  };
}

function summarizeHalf(inputs: TuneThresholdsInputs, settings: Settings): WalkForwardHalfSummary {
  const { marketSeriesByToken, horizons, ...replayInput } = inputs;
  const replayed = replaySignals({ ...replayInput, settings });
  const evaluated = evaluateReplay(replayed, marketSeriesByToken, horizons);
  const relevant = evaluated.filter((e) => e.signal.rule === 'A' || e.signal.rule === 'F');
  const signalCount = relevant.length;
  const hit2xCount = relevant.filter((e) => e.outcome.hit2x).length;
  const hitRate2x = signalCount > 0 ? hit2xCount / signalCount : 0;
  return { signalCount, hitRate2x };
}

/**
 * Splits [from, to] into a tune half ([from, splitAt]) and a strictly-later
 * test half ((splitAt, to]), tunes on the tune half ONLY, then evaluates the
 * SAME chosen settings on the test half ONLY. Never tunes and tests on the
 * same sample.
 */
export function walkForward(args: {
  inputs: WalkForwardInputs;
  from: Date;
  to: Date;
  splitAt: Date;
  grid: ThresholdSweepGrid;
  baseSettings: Settings;
}): WalkForwardResult {
  const { inputs, from, to, splitAt, grid, baseSettings } = args;

  const tuneWindowInputs = filterInputsToWindow(inputs, from, splitAt);
  const testWindowFrom = new Date(splitAt.getTime() + 1); // strictly after splitAt — no overlap with tune half
  const testWindowInputs = filterInputsToWindow(inputs, testWindowFrom, to);

  const tuned = tuneThresholds({ inputs: tuneWindowInputs, grid, baseSettings });
  const tunedOn = tuned.best[0]?.settings ?? baseSettings;

  const tuneSummary = summarizeHalf(tuneWindowInputs, tunedOn);
  const testSummary = summarizeHalf(testWindowInputs, tunedOn);

  const degradationPct =
    testSummary.signalCount === 0
      ? 100
      : tuneSummary.hitRate2x > 0
        ? ((tuneSummary.hitRate2x - testSummary.hitRate2x) / tuneSummary.hitRate2x) * 100
        : 0;

  const verdict: WalkForwardResult['verdict'] =
    degradationPct > DEGRADATION_THRESHOLD_PCT ? 'degrades — likely overfit' : 'holds up';

  return { tunedOn, tuneSummary, testSummary, degradationPct, verdict };
}
