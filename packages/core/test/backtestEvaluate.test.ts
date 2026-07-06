import { describe, expect, it } from 'vitest';
import { evaluateSignalOutcome } from '../src/backtest/evaluate';
import type { MarketPoint, SignalOutcome } from '../src/backtest/evaluate';
import { summarizeOutcomes } from '../src/backtest/summarize';

// evaluateSignalOutcome(input): SignalOutcome (Task 40 binding decision 1).
//
// IMPORTANT (Spec §5c hard-framing rule): these are SYNTHETIC fixture series,
// hand-built point-by-point. They prove the evaluator's CODE PATH — the label
// automaton, per-horizon slicing, hit-rate math — runs correctly against
// known inputs. They do NOT prove FlowRadar's signals have real trading edge;
// that requires historical replay (Task 41, no-lookahead) and live shadow
// testing (Task 42) against REAL market data.
//
// See ../src/backtest/evaluate.ts's file header for the full label-taxonomy
// automaton description these tests assert against.

const TRIGGER = new Date('2026-07-01T00:00:00Z');
const ENTRY_PRICE = 1; // $1 per unit — every pct move below is relative to this
const ENTRY_MCAP = 1_000_000;

function minutesAfter(min: number): Date {
  return new Date(TRIGGER.getTime() + min * 60_000);
}

function point(minAfterTrigger: number, priceUsd: number, opts: { liquidityUsd?: number | null; mcapUsd?: number | null } = {}): MarketPoint {
  return {
    ts: minutesAfter(minAfterTrigger),
    priceUsd,
    mcapUsd: opts.mcapUsd !== undefined ? opts.mcapUsd : ENTRY_MCAP * priceUsd,
    liquidityUsd: opts.liquidityUsd !== undefined ? opts.liquidityUsd : 100_000
  };
}

describe('evaluateSignalOutcome — label taxonomy automaton', () => {
  it(
    '(a) walk-order: +60% at t+2h, then -55% at t+5h (before any 2x), then 3.2x at t+20h => small_win LOCKED, ' +
      'NOT good_win/major_win/failure — because the automaton walks chronologically: the -55% drawdown at t+5h ' +
      'occurs before price ever reaches 2x, which permanently disqualifies good_win (whose gate is "2x before -50%") ' +
      'and major_win (whose gate is "5x before -60%", and -55% > -60% so failure is not triggered either, but the ' +
      "chance to reach 2x/5x BEFORE a -50%/-60% drawdown is gone once that drawdown has already happened); " +
      'small_win only requires "+50% before -50%", and +60% at t+2h already happened before the -55% dip at t+5h, ' +
      'so small_win is locked in at t+2h and survives to the end',
    () => {
      const series: MarketPoint[] = [
        point(0, ENTRY_PRICE),
        point(120, 1.6), // +60% at t+2h -> small_win floor locked (before any -50% dd)
        point(300, 0.45), // -55% at t+5h -> disqualifies good_win/major_win (2x/5x never happened first)
        point(1200, 4.2) // 3.2x at t+20h (well within D7) -> still not 5x, and disqualified anyway
      ];
      const result = evaluateSignalOutcome({
        triggeredAt: TRIGGER,
        entryPriceUsd: ENTRY_PRICE,
        entryMcapUsd: ENTRY_MCAP,
        series
      });
      expect(result.label).toBe('small_win');
      expect(result.hitPlus50).toBe(true);
      // hit2x/hit5x are raw "was this multiple EVER reached at any point,
      // regardless of ordering" flags (distinct from the label automaton's
      // order-aware goodWinLocked/majorWinLocked) -- 3.2x at t+20h does
      // cross 2x, so hit2x is true even though the LABEL is small_win
      // (goodWinLocked never locked because the -55% drawdown at t+5h
      // disqualified it before any 2x crossing happened).
      expect(result.hit2x).toBe(true);
      expect(result.hit5x).toBe(false);
    }
  );

  it('(b) clean 2.5x at +4h with no drawdown => good_win, timeTo2xMin ~= 240, hit2x true, hit5x false', () => {
    const series: MarketPoint[] = [
      point(0, ENTRY_PRICE),
      point(60, 1.2),
      point(180, 2.0), // exactly 2x at t+3h
      point(240, 2.5) // 2.5x at t+4h
    ];
    const result = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series
    });
    expect(result.label).toBe('good_win');
    expect(result.hit2x).toBe(true);
    expect(result.hit5x).toBe(false);
    expect(result.timeTo2xMin).toBe(180);
    expect(result.maxUpsidePct).toBeCloseTo(150, 5);
  });

  it('(c) 6x before any -60% drawdown => major_win', () => {
    const series: MarketPoint[] = [
      point(0, ENTRY_PRICE),
      point(60, 2.0), // 2x
      point(180, 5.0), // 5x
      point(240, 6.0) // 6x
    ];
    const result = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series
    });
    expect(result.label).toBe('major_win');
    expect(result.hit2x).toBe(true);
    expect(result.hit5x).toBe(true);
    expect(result.hit10x).toBe(false);
  });

  it('(d) -65% at +3h, never reaches 2x => failure', () => {
    const series: MarketPoint[] = [point(0, ENTRY_PRICE), point(60, 1.1), point(180, 0.35)];
    const result = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series
    });
    expect(result.label).toBe('failure');
    expect(result.hit2x).toBe(false);
    expect(result.maxDrawdownPct).toBeLessThanOrEqual(-65);
  });

  it('(e) liquidity 100k -> 500 at +1h before any 2x => hard_failure', () => {
    const series: MarketPoint[] = [
      point(0, ENTRY_PRICE, { liquidityUsd: 100_000 }),
      point(60, 0.9, { liquidityUsd: 500 })
    ];
    const result = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series
    });
    expect(result.label).toBe('hard_failure');
  });

  it('(f) +30% flat, never crosses +50% or -50% => neutral_pending', () => {
    const series: MarketPoint[] = [point(0, ENTRY_PRICE), point(60, 1.2), point(120, 1.3), point(180, 1.25)];
    const result = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series
    });
    expect(result.label).toBe('neutral_pending');
    expect(result.hitPlus50).toBe(false);
  });

  it('(g) empty series => neutral_pending with null metrics', () => {
    const result = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series: []
    });
    expect(result.label).toBe('neutral_pending');
    expect(result.maxUpsidePct).toBeNull();
    expect(result.maxDrawdownPct).toBeNull();
    expect(result.timeToPeakMin).toBeNull();
  });

  it('(g2) single-point series => neutral_pending with null metrics (no post-entry movement to measure)', () => {
    const result = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series: [point(0, ENTRY_PRICE)]
    });
    expect(result.label).toBe('neutral_pending');
    expect(result.maxUpsidePct).toBe(0);
  });

  it('(h) pre-trigger points are ignored — a fake 10x BEFORE triggeredAt must not count', () => {
    const series: MarketPoint[] = [
      point(-60, 10), // 10x, but 1h BEFORE triggeredAt -> must be ignored
      point(0, ENTRY_PRICE),
      point(60, 1.2)
    ];
    const result = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series
    });
    expect(result.hit10x).toBe(false);
    expect(result.label).toBe('neutral_pending');
    expect(result.maxUpsidePct).toBeCloseTo(20, 5);
  });
});

describe('evaluateSignalOutcome — per-horizon slicing', () => {
  it('(i) M15 sees nothing when the only post-trigger point is +20min out (past the 15min boundary) => null metrics for M15; H24 sees it', () => {
    // No point at t0 here on purpose: the series' FIRST available observation
    // is already +20min after triggeredAt, so the M15 (15min) window has
    // zero series points inside [triggeredAt, triggeredAt+15min] -- roiPct
    // (last point <= horizon end) must be null, not fall back to some other
    // point outside the window.
    const series: MarketPoint[] = [point(20, 3.0)]; // 3x at +20min, past the M15 boundary
    const result = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series,
      horizons: ['M15', 'H24']
    });
    const m15 = result.horizons.M15!;
    const h24 = result.horizons.H24!;
    expect(m15.roiPct).toBeNull();
    expect(m15.maxUpsidePct).toBeNull();
    expect(m15.maxDrawdownPct).toBeNull();
    expect(h24.roiPct).toBeCloseTo(200, 5);
    expect(h24.maxUpsidePct).toBeCloseTo(200, 5);
  });

  it('per-horizon roiPct uses the last point at/before the horizon end; timeTo2xMin only set once threshold crossed within that horizon', () => {
    // No t0 point on purpose (same reasoning as test (i) above): the first
    // available observation is already +30min out, past the M15 boundary,
    // so M15 has zero in-window points -> null, not a spurious roiPct=0.
    const series: MarketPoint[] = [
      point(30, 1.3), // within M15? no (30 > 15) -> M15 sees nothing
      point(50, 2.2), // within H1 (60 min) -> 2x crossed at t+50
      point(70, 0.8) // after H1 end
    ];
    const result = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series,
      horizons: ['M15', 'H1']
    });
    expect(result.horizons.M15!.roiPct).toBeNull();
    // last point <= H1 (60min) end is t+50 (2.2) -- t+70's 0.8 point is past the H1 boundary
    expect(result.horizons.H1!.roiPct).toBeCloseTo(120, 5);
    expect(result.horizons.H1!.timeTo2xMin).toBe(50);
  });
});

describe('evaluateSignalOutcome — mcap-basis fallback', () => {
  it('(j) uses mcap ratio when entryPriceUsd is null, documented basis="mcap"', () => {
    const series: MarketPoint[] = [
      { ts: minutesAfter(0), priceUsd: 0, mcapUsd: ENTRY_MCAP, liquidityUsd: 100_000 },
      { ts: minutesAfter(60), priceUsd: 0, mcapUsd: ENTRY_MCAP * 2.5, liquidityUsd: 100_000 }
    ];
    const result = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: null,
      entryMcapUsd: ENTRY_MCAP,
      series
    });
    expect(result.basis).toBe('mcap');
    expect(result.maxUpsidePct).toBeCloseTo(150, 5);
    expect(result.hit2x).toBe(true);
  });

  it('basis is "price" when entryPriceUsd is provided, even if mcap data is also present', () => {
    const result = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series: [point(0, ENTRY_PRICE), point(60, 1.5)]
    });
    expect(result.basis).toBe('price');
  });

  it('falls back to neutral_pending with null metrics when both entryPriceUsd and entryMcapUsd are null (no basis possible)', () => {
    const result = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: null,
      entryMcapUsd: null,
      series: [point(0, ENTRY_PRICE), point(60, 1.5)]
    });
    expect(result.label).toBe('neutral_pending');
    expect(result.maxUpsidePct).toBeNull();
    expect(result.basis).toBeNull();
  });
});

describe('evaluateSignalOutcome — smartExitedBeforeDump passthrough', () => {
  it('passes through the nullable external input verbatim (not computed by this function)', () => {
    const series: MarketPoint[] = [point(0, ENTRY_PRICE), point(60, 1.5)];
    const withTrue = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series
    });
    expect(withTrue.smartExitedBeforeDump).toBeNull();
  });
});

describe('evaluateSignalOutcome — determinism', () => {
  it('is a pure function of its input — same input, same output, called twice', () => {
    const series: MarketPoint[] = [point(0, ENTRY_PRICE), point(120, 1.6), point(300, 0.45), point(1200, 4.2)];
    const input = { triggeredAt: TRIGGER, entryPriceUsd: ENTRY_PRICE, entryMcapUsd: ENTRY_MCAP, series };
    const r1 = evaluateSignalOutcome(input);
    const r2 = evaluateSignalOutcome(input);
    expect(r1).toEqual(r2);
  });
});

// (k) summarizeOutcomes math on a small set (median odd/even counts).
describe('summarizeOutcomes', () => {
  /** Builds a real SignalOutcome via evaluateSignalOutcome from a simple flat-then-move series ending at the given final multiple (single D7-horizon roiPct == (finalMultiple-1)*100). */
  function outcomeEndingAt(finalMultiple: number): SignalOutcome {
    const series: MarketPoint[] = [point(0, ENTRY_PRICE), point(60, finalMultiple)];
    return evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series
    });
  }

  it('empty input => zeroed rates, null medians/averages, signalCount 0', () => {
    const summary = summarizeOutcomes([]);
    expect(summary.signalCount).toBe(0);
    expect(summary.hitRatePlus50).toBe(0);
    expect(summary.medianReturnPct).toBeNull();
    expect(summary.avgReturnPct).toBeNull();
    expect(summary.maxUpsidePct).toBeNull();
    expect(summary.maxDrawdownPct).toBeNull();
  });

  it('odd count (5 outcomes): median is the exact middle value after sorting', () => {
    // roiPct values (final multiple - 1) * 100: -80, -20, 10, 50, 300
    const outcomes = [0.2, 0.8, 1.1, 1.5, 4.0].map(outcomeEndingAt);
    const summary = summarizeOutcomes(outcomes);
    expect(summary.signalCount).toBe(5);
    // sorted returns: [-80, -20, 10, 50, 300] -> middle (index 2) = 10
    expect(summary.medianReturnPct).toBeCloseTo(10, 5);
    expect(summary.avgReturnPct).toBeCloseTo((-80 - 20 + 10 + 50 + 300) / 5, 5);
  });

  it('even count (4 outcomes): median is the average of the two middle values', () => {
    // roiPct values: -50, 0, 100, 400
    const outcomes = [0.5, 1.0, 2.0, 5.0].map(outcomeEndingAt);
    const summary = summarizeOutcomes(outcomes);
    expect(summary.signalCount).toBe(4);
    // sorted: [-50, 0, 100, 400] -> avg(0, 100) = 50
    expect(summary.medianReturnPct).toBeCloseTo(50, 5);
  });

  it('hit-rate and label-rate math over a mixed batch', () => {
    const winner5x = outcomeEndingAt(6.0); // major_win, hit2x+hit5x true
    const winner2x = outcomeEndingAt(2.5); // good_win, hit2x true, hit5x false
    const failer = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series: [point(0, ENTRY_PRICE), point(60, 0.3)]
    }); // failure
    const rugger = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series: [point(0, ENTRY_PRICE, { liquidityUsd: 100_000 }), point(60, 0.9, { liquidityUsd: 200 })]
    }); // hard_failure

    const summary = summarizeOutcomes([winner5x, winner2x, failer, rugger]);
    expect(summary.signalCount).toBe(4);
    expect(summary.hitRate2x).toBeCloseTo(2 / 4, 5);
    expect(summary.hitRate5x).toBeCloseTo(1 / 4, 5);
    expect(summary.failureRate).toBeCloseTo(1 / 4, 5);
    expect(summary.hardFailureRate).toBeCloseTo(1 / 4, 5);
  });

  it('maxUpsidePct/maxDrawdownPct are the most-extreme values across the batch', () => {
    const a = outcomeEndingAt(6.0); // +500% upside
    const b = evaluateSignalOutcome({
      triggeredAt: TRIGGER,
      entryPriceUsd: ENTRY_PRICE,
      entryMcapUsd: ENTRY_MCAP,
      series: [point(0, ENTRY_PRICE), point(60, 0.1)] // -90% drawdown
    });
    const summary = summarizeOutcomes([a, b]);
    expect(summary.maxUpsidePct).toBeCloseTo(500, 5);
    expect(summary.maxDrawdownPct).toBeCloseTo(-90, 5);
  });
});
