// FlowRadar — evaluateSignalOutcome: pure signal-outcome evaluator (Task 40
// binding decision 1).
//
// packages/core is PURE (zero I/O, zero framework deps) — this function
// takes a triggeredAt timestamp, an entry basis (price or mcap), and an
// in-memory market-point series, and returns a deterministic SignalOutcome.
// No Date.now(), no I/O, no randomness. Replay-level lookahead prevention
// (i.e. "don't let a LATER historical-replay pass peek at data that wasn't
// available yet at simulated time T") is explicitly OUT of scope here — see
// Task 41. This function's own, narrower contract is just: "given a series,
// ignore anything before triggeredAt, and evaluate the rest." The caller
// (packages/db/src/backtest.ts) is responsible for handing it a series that
// itself doesn't extend past whatever moment is currently valid to look at.
//
// ---------------------------------------------------------------------------
// Basis: price vs mcap (binding decision 1)
// ---------------------------------------------------------------------------
// Every pct-move calculation prefers `entryPriceUsd` + each point's
// `priceUsd`. When `entryPriceUsd` is null (no reliable price captured at
// trigger time), the evaluator falls back to `entryMcapUsd` + each point's
// `mcapUsd` (a mcap ratio is an equally valid proxy for "how much did this
// token's value change" when the token count is roughly constant, which is
// generally true over the multi-day horizons this evaluator looks at). If
// BOTH bases are unusable (both null, or the chosen basis's own series field
// is unusable at every point) the function returns a fully-null
// `neutral_pending` result with `basis: null` — there's nothing to compute
// against. The chosen basis is recorded on the result (`basis: 'price' |
// 'mcap' | null`) so a caller can see which one applied without re-deriving
// it.
//
// ---------------------------------------------------------------------------
// Label taxonomy automaton (BINDING — Task 40 binding decision 1)
// ---------------------------------------------------------------------------
// The evaluator walks the FULL available series (not per-horizon — the label
// is a series-level property, computed once) in chronological order,
// tracking a running multiple-of-entry (1.0 = entry price/mcap; drawdown and
// upside are ALWAYS measured relative to entry, never a running peak — "a
// -50% drawdown" means the multiple has fallen to <=0.5x at some point,
// mirroring the roiPct/maxDrawdownPct convention used elsewhere in this
// file). At each series point, in THIS order:
//
//   a. Hard-failure liquidity check. If liquidity has collapsed (>=90% down
//      from entry-time liquidity, OR absolute liquidityUsd is below
//      HARD_FAILURE_MIN_LIQUIDITY_USD) AND price has not yet reached 2x at
//      any EARLIER point -> lock `hardFailureTriggered = true`. Once
//      triggered this is terminal for the whole series (a rug/liquidity-pull
//      does not "recover" in a way this evaluator trusts, even if a later
//      point in the recorded series shows a nominal price bounce — post-rug
//      price points are typically illiquid/manipulable). This check runs
//      BEFORE every other check at each point, so a rug that happens to
//      coincide with a nominal price uptick still gets flagged.
//   b. Threshold/gate tracking, in strict "has the gate already fired as of
//      an EARLIER point" vs "does THIS point disqualify it" order:
//        - hit2xSoFar / hit5xSoFar / hit10xSoFar flip true the first time the
//          multiple reaches 2x/5x/10x (their timeToXxMin — first crossing
//          minute — is recorded once and never overwritten).
//        - smallWinLocked flips true the first time multiple >= 1.5, UNLESS
//          a point with multiple <= 0.5 already occurred strictly earlier.
//        - goodWinLocked flips true the first time multiple >= 2.0, UNLESS a
//          point with multiple <= 0.5 already occurred strictly earlier.
//        - majorWinLocked flips true the first time multiple >= 5.0, UNLESS a
//          point with multiple <= 0.4 already occurred strictly earlier.
//        - failureLocked flips true the first time multiple <= 0.4 occurs
//          AND 2x has never yet been reached as of an earlier point.
//      Because the walk is chronological and each *Locked flag is monotonic
//      (once true, checked-but-never-explicitly-cleared — "disqualified"
//      just means it never had the chance to become true in the first
//      place), a point's own upside crossing is always evaluated before that
//      SAME point's drawdown reading in the loop body, but that ordering
//      only matters ACROSS different points: a single point cannot itself be
//      both a qualifying upside crossing and a disqualifying drawdown (one
//      multiple cannot be both >=1.5 and <=0.5). This is what makes the
//      worked example "+60% at t+2h, then -55% at t+5h, then 3.2x at t+20h"
//      resolve to small_win: smallWinLocked fires at t+2h (multiple 1.6, no
//      prior <=0.5 point) and is never revisited; goodWinLocked never fires
//      because 2x is never reached before the t+5h drawdown disqualifies it
//      (multiple never reaches 2.0 before dropping to 0.45); failureLocked
//      never fires either because 0.45 > 0.4 (a -55% drawdown, not -60%).
//
// After the full walk, the four tier flags are:
//   smallWinLocked  = true the first time multiple >= 1.5 at a point that
//                     occurs before any point with multiple <= 0.5.
//   goodWinLocked   = true the first time multiple >= 2.0 at a point that
//                     occurs before any point with multiple <= 0.5.
//   majorWinLocked  = true the first time multiple >= 5.0 at a point that
//                     occurs before any point with multiple <= 0.4.
//   failureLocked   = true the first time multiple <= 0.4 at a point that
//                     occurs before 2x has ever been reached.
// (hardFailureTriggered is tracked separately per step a, above, and always
// wins if set.)
//
// Final label precedence: hard_failure > major_win > good_win > small_win >
// failure > neutral_pending. Note failure is LOWER precedence than the win
// tiers here — by construction, failureLocked and any winLocked flag can
// both end up true only if the series later recovers, e.g. -65% at t+1h
// (locks failureLocked) then 6x at t+10h (making majorWinLocked ALSO true,
// since majorWinLocked's own gate is "5x before -60%", and if the -65% point
// came first, 5x could not have preceded it -- so majorWinLocked can only be
// true here if there's an EARLIER 5x before that specific drawdown. In other
// words majorWinLocked/goodWinLocked/smallWinLocked are each independently
// "was MY OWN gate satisfied in the right order", so it is NOT possible to
// have majorWinLocked=true while a -60%+ drawdown preceded every 5x point --
// the flag is defined not to allow that.) So in practice failureLocked and a
// winLocked flag being simultaneously true does not arise from the same
// disqualifying event; the precedence order above is a defensive tie-break
// only. neutral_pending is the default when nothing else fires (e.g. only
// mild movement, or an empty/single-point series).
//
// ---------------------------------------------------------------------------
// Horizons
// ---------------------------------------------------------------------------
// Per horizon window [triggeredAt, triggeredAt + horizonMinutes], the
// evaluator computes maxUpsidePct/maxDrawdownPct from ONLY the series points
// falling in that window (inclusive of both ends), roiPct from the LAST such
// point (null if none), and timeTo2x/5x/10xMin as the first crossing minute
// within that same window (null if never crossed within it). The overall
// (horizon-invariant) maxUpsidePct/maxDrawdownPct/timeToPeakMin fields use
// the FULL available series instead (not clipped to any horizon) -- these
// back the label automaton above, which is deliberately not horizon-scoped
// (Task 40: "label is series-level", see backtest.ts's own comment on this).

import type { BacktestHorizon } from '../types';

export interface MarketPoint {
  ts: Date;
  priceUsd: number;
  mcapUsd: number | null;
  liquidityUsd: number | null;
}

export type OutcomeLabel = 'small_win' | 'good_win' | 'major_win' | 'failure' | 'hard_failure' | 'neutral_pending';

export type EvaluationBasis = 'price' | 'mcap';

export interface EvaluateSignalOutcomeInput {
  triggeredAt: Date;
  entryPriceUsd: number | null;
  entryMcapUsd: number | null;
  series: MarketPoint[];
  horizons?: BacktestHorizon[];
}

export interface HorizonOutcome {
  horizon: BacktestHorizon;
  maxUpsidePct: number | null;
  maxDrawdownPct: number | null;
  roiPct: number | null;
  timeTo2xMin: number | null;
  timeTo5xMin: number | null;
  timeTo10xMin: number | null;
}

export interface SignalOutcome {
  basis: EvaluationBasis | null;
  label: OutcomeLabel;
  maxUpsidePct: number | null;
  maxDrawdownPct: number | null;
  timeToPeakMin: number | null;
  hitPlus50: boolean;
  hit2x: boolean;
  hit5x: boolean;
  hit10x: boolean;
  timeTo2xMin: number | null;
  timeTo5xMin: number | null;
  timeTo10xMin: number | null;
  /** External input, passed through verbatim — NOT computed by this function (caller derives it from exit metrics). Always null here since this function never receives one; kept on the shape for backtest.ts's persistence convenience. */
  smartExitedBeforeDump: boolean | null;
  horizons: Partial<Record<BacktestHorizon, HorizonOutcome>>;
}

const ALL_HORIZONS: BacktestHorizon[] = ['M15', 'H1', 'H6', 'H24', 'D3', 'D7'];

const HORIZON_MINUTES: Record<BacktestHorizon, number> = {
  M15: 15,
  H1: 60,
  H6: 6 * 60,
  H24: 24 * 60,
  D3: 3 * 24 * 60,
  D7: 7 * 24 * 60
};

// Win-tier / failure thresholds, expressed as "multiple of entry" (1.0 =
// entry price/mcap). Kept as named constants rather than inline magic
// numbers so the automaton's prose above and its implementation stay in sync
// at a glance.
const SMALL_WIN_UPSIDE_MULT = 1.5; // +50%
const GOOD_WIN_UPSIDE_MULT = 2.0; // 2x
const MAJOR_WIN_UPSIDE_MULT = 5.0; // 5x
const TEN_X_MULT = 10.0;
const SMALL_GOOD_DRAWDOWN_MULT = 0.5; // -50%
const MAJOR_FAILURE_DRAWDOWN_MULT = 0.4; // -60%

const HARD_FAILURE_LIQUIDITY_DROP_PCT = 0.9; // >=90% drop from entry-time liquidity
const HARD_FAILURE_MIN_LIQUIDITY_USD = 1000; // or absolute liquidity below $1k

interface NormalizedPoint {
  ts: Date;
  minutesAfterTrigger: number;
  multiple: number | null; // value / entryValue, using whichever basis was chosen; null if this point's own value is unusable
  liquidityUsd: number | null;
}

/** Picks price-or-mcap basis and returns normalized (multiple-of-entry) points, chronologically sorted, restricted to ts >= triggeredAt. */
function normalize(input: EvaluateSignalOutcomeInput): { basis: EvaluationBasis | null; points: NormalizedPoint[] } {
  const { triggeredAt, entryPriceUsd, entryMcapUsd, series } = input;

  let basis: EvaluationBasis | null = null;
  let entryValue: number | null = null;
  if (entryPriceUsd !== null && entryPriceUsd > 0) {
    basis = 'price';
    entryValue = entryPriceUsd;
  } else if (entryMcapUsd !== null && entryMcapUsd > 0) {
    basis = 'mcap';
    entryValue = entryMcapUsd;
  }

  if (basis === null || entryValue === null) {
    return { basis: null, points: [] };
  }

  const postTrigger = series
    .filter((p) => p.ts.getTime() >= triggeredAt.getTime())
    .slice()
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const points: NormalizedPoint[] = postTrigger.map((p) => {
    const value = basis === 'price' ? p.priceUsd : p.mcapUsd;
    const multiple = value !== null && value !== undefined && entryValue !== null && entryValue > 0 ? value / entryValue : null;
    return {
      ts: p.ts,
      minutesAfterTrigger: (p.ts.getTime() - triggeredAt.getTime()) / 60_000,
      multiple,
      liquidityUsd: p.liquidityUsd
    };
  });

  return { basis, points };
}

/** Computes maxUpsidePct/maxDrawdownPct/timeToPeakMin/roiPct/timeToXx over a (possibly horizon-clipped) point slice. Returns all-null when the slice is empty. */
function summarizeSlice(points: NormalizedPoint[]): {
  maxUpsidePct: number | null;
  maxDrawdownPct: number | null;
  roiPct: number | null;
  timeToPeakMin: number | null;
  timeTo2xMin: number | null;
  timeTo5xMin: number | null;
  timeTo10xMin: number | null;
} {
  const usable = points.filter((p) => p.multiple !== null);
  if (usable.length === 0) {
    return {
      maxUpsidePct: null,
      maxDrawdownPct: null,
      roiPct: null,
      timeToPeakMin: null,
      timeTo2xMin: null,
      timeTo5xMin: null,
      timeTo10xMin: null
    };
  }

  let maxMultiple = usable[0]!.multiple!;
  let minMultiple = usable[0]!.multiple!;
  let timeToPeakMin = usable[0]!.minutesAfterTrigger;
  let timeTo2xMin: number | null = null;
  let timeTo5xMin: number | null = null;
  let timeTo10xMin: number | null = null;

  for (const p of usable) {
    const m = p.multiple!;
    if (m > maxMultiple) {
      maxMultiple = m;
      timeToPeakMin = p.minutesAfterTrigger;
    }
    if (m < minMultiple) {
      minMultiple = m;
    }
    if (timeTo2xMin === null && m >= GOOD_WIN_UPSIDE_MULT) {
      timeTo2xMin = p.minutesAfterTrigger;
    }
    if (timeTo5xMin === null && m >= MAJOR_WIN_UPSIDE_MULT) {
      timeTo5xMin = p.minutesAfterTrigger;
    }
    if (timeTo10xMin === null && m >= TEN_X_MULT) {
      timeTo10xMin = p.minutesAfterTrigger;
    }
  }

  const last = usable[usable.length - 1]!;

  return {
    maxUpsidePct: (maxMultiple - 1) * 100,
    maxDrawdownPct: (minMultiple - 1) * 100,
    roiPct: (last.multiple! - 1) * 100,
    timeToPeakMin,
    timeTo2xMin,
    timeTo5xMin,
    timeTo10xMin
  };
}

/**
 * Walks the full chronological series once, applying the label automaton
 * described in this file's header. Returns the final label plus the
 * hit/timeTo flags the automaton derives as a side effect (so callers don't
 * need a second pass to get hitPlus50/hit2x/hit5x/hit10x).
 */
function runLabelAutomaton(points: NormalizedPoint[]): {
  label: OutcomeLabel;
  hitPlus50: boolean;
  hit2x: boolean;
  hit5x: boolean;
  hit10x: boolean;
} {
  const usable = points.filter((p) => p.multiple !== null);

  let hit2xSoFar = false;
  let hit5xSoFar = false;

  let smallWinLocked = false;
  let goodWinLocked = false;
  let majorWinLocked = false;
  let failureLocked = false;
  let hardFailureTriggered = false;

  // Disqualification flags: once a drawdown at/below the relevant threshold
  // has occurred, the corresponding win tier(s) can never lock afterwards,
  // even if price recovers and later crosses the upside gate again.
  let smallGoodDisqualified = false; // set once multiple <= 0.5 (a -50% drawdown)
  let majorDisqualified = false; // set once multiple <= 0.4 (a -60% drawdown)

  let anyHitPlus50 = false;
  let anyHit2x = false;
  let anyHit5x = false;
  let anyHit10x = false;

  // Entry-time liquidity = the first usable point's liquidity reading (the
  // point closest to triggeredAt); null if unknown (hard-failure liquidity
  // check is then based on the absolute-floor test only).
  const entryLiquidity = points.length > 0 ? points[0]!.liquidityUsd : null;

  for (const p of points) {
    // Step (a): hard-failure liquidity check runs BEFORE any win-tier check
    // at this point, and only while 2x hasn't been reached yet as of an
    // EARLIER point (hit2xSoFar reflects state strictly before this point's
    // own multiple is folded in below).
    if (!hardFailureTriggered && !hit2xSoFar && p.liquidityUsd !== null) {
      const droppedRelative =
        entryLiquidity !== null && entryLiquidity > 0 ? p.liquidityUsd <= entryLiquidity * (1 - HARD_FAILURE_LIQUIDITY_DROP_PCT) : false;
      const droppedAbsolute = p.liquidityUsd < HARD_FAILURE_MIN_LIQUIDITY_USD;
      if (droppedRelative || droppedAbsolute) {
        hardFailureTriggered = true;
      }
    }

    if (p.multiple === null) continue;
    const m = p.multiple;

    // Step (b)/(c) — win-tier gates, evaluated in "does THIS point satisfy
    // MY gate, and has a disqualifying drawdown for that gate already
    // happened at an EARLIER point" order. Locking only happens if the
    // corresponding disqualification flag is not already set — once a
    // disqualification flag is set (by an earlier point's drawdown), that
    // tier can never lock later, no matter how high price goes afterwards.
    // smallWinLocked/goodWinLocked share the same disqualifying drawdown
    // level (<=0.5x); majorWinLocked has its own, deeper level (<=0.4x).
    if (m >= SMALL_WIN_UPSIDE_MULT && !smallGoodDisqualified && !smallWinLocked) {
      smallWinLocked = true;
    }
    if (m >= GOOD_WIN_UPSIDE_MULT && !smallGoodDisqualified && !goodWinLocked) {
      goodWinLocked = true;
    }
    if (m >= MAJOR_WIN_UPSIDE_MULT && !majorDisqualified && !majorWinLocked) {
      majorWinLocked = true;
    }
    if (m >= GOOD_WIN_UPSIDE_MULT && !hit2xSoFar) hit2xSoFar = true;
    if (m >= MAJOR_WIN_UPSIDE_MULT && !hit5xSoFar) hit5xSoFar = true;

    if (m >= SMALL_WIN_UPSIDE_MULT) anyHitPlus50 = true;
    if (m >= GOOD_WIN_UPSIDE_MULT) anyHit2x = true;
    if (m >= MAJOR_WIN_UPSIDE_MULT) anyHit5x = true;
    if (m >= TEN_X_MULT) anyHit10x = true;

    // Drawdown disqualification, applied AFTER this point's own upside gates
    // above have had their chance to lock (so a point that is itself the
    // qualifying upside crossing is never simultaneously treated as its own
    // disqualifying drawdown — impossible anyway, since a single multiple
    // can't be both >=1.5/2.0 and <=0.5). A >=50% drawdown permanently
    // disqualifies small_win/good_win for every SUBSEQUENT point (already-
    // locked flags are unaffected — locking is monotonic once achieved). A
    // >=60% drawdown permanently disqualifies major_win, and independently
    // arms `failureLocked` if 2x has never yet been reached as of this point.
    if (m <= SMALL_GOOD_DRAWDOWN_MULT) {
      smallGoodDisqualified = true;
    }
    if (m <= MAJOR_FAILURE_DRAWDOWN_MULT) {
      majorDisqualified = true;
      if (!hit2xSoFar && !failureLocked) failureLocked = true;
    }
  }

  let label: OutcomeLabel;
  if (hardFailureTriggered) {
    label = 'hard_failure';
  } else if (majorWinLocked) {
    label = 'major_win';
  } else if (goodWinLocked) {
    label = 'good_win';
  } else if (smallWinLocked) {
    label = 'small_win';
  } else if (failureLocked) {
    label = 'failure';
  } else {
    label = 'neutral_pending';
  }

  return {
    label,
    hitPlus50: usable.length > 0 && anyHitPlus50,
    hit2x: usable.length > 0 && anyHit2x,
    hit5x: usable.length > 0 && anyHit5x,
    hit10x: usable.length > 0 && anyHit10x
  };
}

function nullHorizonOutcome(horizon: BacktestHorizon): HorizonOutcome {
  return {
    horizon,
    maxUpsidePct: null,
    maxDrawdownPct: null,
    roiPct: null,
    timeTo2xMin: null,
    timeTo5xMin: null,
    timeTo10xMin: null
  };
}

export function evaluateSignalOutcome(input: EvaluateSignalOutcomeInput): SignalOutcome {
  const horizonsRequested = input.horizons ?? ALL_HORIZONS;
  const { basis, points } = normalize(input);

  if (basis === null || points.length === 0) {
    const horizons: Partial<Record<BacktestHorizon, HorizonOutcome>> = {};
    for (const h of horizonsRequested) horizons[h] = nullHorizonOutcome(h);
    return {
      basis,
      label: 'neutral_pending',
      maxUpsidePct: null,
      maxDrawdownPct: null,
      timeToPeakMin: null,
      hitPlus50: false,
      hit2x: false,
      hit5x: false,
      hit10x: false,
      timeTo2xMin: null,
      timeTo5xMin: null,
      timeTo10xMin: null,
      smartExitedBeforeDump: null,
      horizons
    };
  }

  const overall = summarizeSlice(points);
  const automaton = runLabelAutomaton(points);

  const horizons: Partial<Record<BacktestHorizon, HorizonOutcome>> = {};
  for (const h of horizonsRequested) {
    const horizonMs = HORIZON_MINUTES[h] * 60_000;
    const clipped = points.filter((p) => p.minutesAfterTrigger * 60_000 <= horizonMs);
    const slice = summarizeSlice(clipped);
    horizons[h] = {
      horizon: h,
      maxUpsidePct: slice.maxUpsidePct,
      maxDrawdownPct: slice.maxDrawdownPct,
      roiPct: slice.roiPct,
      timeTo2xMin: slice.timeTo2xMin,
      timeTo5xMin: slice.timeTo5xMin,
      timeTo10xMin: slice.timeTo10xMin
    };
  }

  return {
    basis,
    label: automaton.label,
    maxUpsidePct: overall.maxUpsidePct,
    maxDrawdownPct: overall.maxDrawdownPct,
    timeToPeakMin: overall.timeToPeakMin,
    hitPlus50: automaton.hitPlus50,
    hit2x: automaton.hit2x,
    hit5x: automaton.hit5x,
    hit10x: automaton.hit10x,
    timeTo2xMin: overall.timeTo2xMin,
    timeTo5xMin: overall.timeTo5xMin,
    timeTo10xMin: overall.timeTo10xMin,
    smartExitedBeforeDump: null,
    horizons
  };
}
