// FlowRadar — summarizeOutcomes: pure aggregate helper over a batch of
// SignalOutcome results (Task 40 binding decision 4).
//
// Consumed by Task 41 (rule/combined perf, threshold tuning) and Task 42
// (shadow-mode summary pages) — kept here, alongside evaluateSignalOutcome,
// since both are pure/zero-I/O and operate on the same SignalOutcome shape.
//
// Median: standard "average of the two middle values" for an even-length
// array, single middle value for odd-length, computed over ONLY the entries
// whose roiPct is non-null (a neutral_pending/empty-series outcome has no
// roiPct to contribute) — sorted ascending first. avgReturnPct is the mean
// over the same non-null subset. maxUpsidePct/maxDrawdownPct are the
// most-extreme (max upside, most-negative drawdown) values across every
// outcome that has a non-null reading for that field. hitRate*/failureRate/
// hardFailureRate are simple proportions over ALL outcomes passed in
// (signalCount is the denominator for every rate — an outcome with
// hit2x=false still counts toward the denominator, same as one with
// hit2x=true; this mirrors "what fraction of ALL signals reached 2x",
// not "what fraction of signals that had SOME data reached 2x").

import type { SignalOutcome } from './evaluate';

export interface OutcomesSummary {
  signalCount: number;
  hitRatePlus50: number;
  hitRate2x: number;
  hitRate5x: number;
  hitRate10x: number;
  medianReturnPct: number | null;
  avgReturnPct: number | null;
  maxUpsidePct: number | null;
  maxDrawdownPct: number | null;
  failureRate: number;
  hardFailureRate: number;
}

function median(sortedAscending: number[]): number | null {
  const n = sortedAscending.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) {
    return sortedAscending[mid]!;
  }
  return (sortedAscending[mid - 1]! + sortedAscending[mid]!) / 2;
}

export function summarizeOutcomes(outcomes: SignalOutcome[]): OutcomesSummary {
  const signalCount = outcomes.length;

  if (signalCount === 0) {
    return {
      signalCount: 0,
      hitRatePlus50: 0,
      hitRate2x: 0,
      hitRate5x: 0,
      hitRate10x: 0,
      medianReturnPct: null,
      avgReturnPct: null,
      maxUpsidePct: null,
      maxDrawdownPct: null,
      failureRate: 0,
      hardFailureRate: 0
    };
  }

  const hitPlus50Count = outcomes.filter((o) => o.hitPlus50).length;
  const hit2xCount = outcomes.filter((o) => o.hit2x).length;
  const hit5xCount = outcomes.filter((o) => o.hit5x).length;
  const hit10xCount = outcomes.filter((o) => o.hit10x).length;
  const failureCount = outcomes.filter((o) => o.label === 'failure').length;
  const hardFailureCount = outcomes.filter((o) => o.label === 'hard_failure').length;

  // "Return" here = each outcome's overall (full-series) roiPct-equivalent —
  // SignalOutcome doesn't carry a single scalar roiPct itself (that's a
  // per-horizon field), so the closest series-level analog is maxUpsidePct
  // when the outcome trended up, but the honest aggregate-return proxy
  // across mixed outcomes (some up, some down) is the LAST known multiple's
  // pct move, which for the overall (non-horizon-clipped) view is exactly
  // what roiPct would be at the end of the available series. Since
  // evaluateSignalOutcome's overall fields intentionally expose
  // maxUpsidePct/maxDrawdownPct/timeToPeakMin (not a standalone overall
  // roiPct), the horizon outcome with the LONGEST available window
  // (preferring D7, falling back through D3/H24/H6/H1/M15 to whichever is
  // present) supplies the "final known return" per signal.
  const HORIZON_PREFERENCE: (keyof SignalOutcome['horizons'])[] = ['D7', 'D3', 'H24', 'H6', 'H1', 'M15'];
  const returns: number[] = [];
  for (const outcome of outcomes) {
    for (const h of HORIZON_PREFERENCE) {
      const roi = outcome.horizons[h]?.roiPct;
      if (roi !== null && roi !== undefined) {
        returns.push(roi);
        break;
      }
    }
  }
  const sortedReturns = [...returns].sort((a, b) => a - b);
  const medianReturnPct = median(sortedReturns);
  const avgReturnPct = returns.length > 0 ? returns.reduce((sum, r) => sum + r, 0) / returns.length : null;

  const upsideValues = outcomes.map((o) => o.maxUpsidePct).filter((v): v is number => v !== null);
  const drawdownValues = outcomes.map((o) => o.maxDrawdownPct).filter((v): v is number => v !== null);
  const maxUpsidePct = upsideValues.length > 0 ? Math.max(...upsideValues) : null;
  const maxDrawdownPct = drawdownValues.length > 0 ? Math.min(...drawdownValues) : null;

  return {
    signalCount,
    hitRatePlus50: hitPlus50Count / signalCount,
    hitRate2x: hit2xCount / signalCount,
    hitRate5x: hit5xCount / signalCount,
    hitRate10x: hit10xCount / signalCount,
    medianReturnPct,
    avgReturnPct,
    maxUpsidePct,
    maxDrawdownPct,
    failureRate: failureCount / signalCount,
    hardFailureRate: hardFailureCount / signalCount
  };
}
