// FlowRadar — evaluateReplay / rulePerformance / comboPerformance /
// bucketPerformance tests (Task 41 binding decision 2; bucketPerformance
// added per Task 41 review IMPORTANT item). TDD RED-then-GREEN.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings';
import { evaluateReplay, rulePerformance, comboPerformance, bucketPerformance } from '../src/backtest/rulePerf';
import type { ReplayedSignal } from '../src/backtest/replay';
import type { MarketPoint } from '../src/backtest/evaluate';

function sig(rule: ReplayedSignal['rule'], tokenId: string, firedAt: Date, metrics: ReplayedSignal['metrics'] = {}): ReplayedSignal {
  return { tokenId, rule, severity: 'HIGH', firedAt, metrics };
}

function point(ts: Date, priceUsd: number, opts: { liquidityUsd?: number | null; mcapUsd?: number | null; source?: string } = {}): MarketPoint & { source?: string } {
  return {
    ts,
    priceUsd,
    mcapUsd: opts.mcapUsd !== undefined ? opts.mcapUsd : 1_000_000 * priceUsd,
    liquidityUsd: opts.liquidityUsd !== undefined ? opts.liquidityUsd : 100_000,
    source: opts.source ?? 'ingest'
  };
}

const T0 = new Date('2026-02-01T00:00:00Z');
function minutesAfter(min: number): Date {
  return new Date(T0.getTime() + min * 60_000);
}

describe('evaluateReplay', () => {
  it('joins each ReplayedSignal to a post-firedAt outcome via the provided market series', () => {
    const signals: ReplayedSignal[] = [sig('A', 'tok1', T0)];
    const seriesByToken = new Map([
      ['tok1', [point(T0, 1), point(minutesAfter(60), 2.2)]] // 2.2x within H1
    ]);
    const results = evaluateReplay(signals, seriesByToken, ['H1']);
    expect(results.length).toBe(1);
    expect(results[0]!.outcome.hit2x).toBe(true);
    expect(results[0]!.syntheticEvidence).toBe(false);
  });

  it('propagates the synthetic-provenance marker: any consumed point with source=seed_synthetic_continuation flags the outcome + is separated in summaries', () => {
    const signals: ReplayedSignal[] = [
      sig('A', 'tokReal', T0),
      sig('A', 'tokSynth', T0)
    ];
    const seriesByToken = new Map([
      ['tokReal', [point(T0, 1), point(minutesAfter(60), 1.6)]],
      ['tokSynth', [point(T0, 1), point(minutesAfter(60), 1.6, { source: 'seed_synthetic_continuation' })]]
    ]);
    const results = evaluateReplay(signals, seriesByToken, ['H1']);
    const real = results.find((r) => r.signal.tokenId === 'tokReal')!;
    const synth = results.find((r) => r.signal.tokenId === 'tokSynth')!;
    expect(real.syntheticEvidence).toBe(false);
    expect(synth.syntheticEvidence).toBe(true);
  });

  it('a signal with no matching token series yields a neutral_pending outcome (not a crash)', () => {
    const signals: ReplayedSignal[] = [sig('A', 'unknownTok', T0)];
    const results = evaluateReplay(signals, new Map(), ['H1']);
    expect(results.length).toBe(1);
    expect(results[0]!.outcome.label).toBe('neutral_pending');
  });
});

describe('rulePerformance', () => {
  it('computes per-rule A-G summaries independently', () => {
    const seriesByToken = new Map([
      ['tokA', [point(T0, 1), point(minutesAfter(60), 2.5)]], // 2.5x -> good_win
      ['tokF', [point(T0, 1), point(minutesAfter(60), 0.3)]] // -70% -> failure/hard depending on liquidity
    ]);
    const signals: ReplayedSignal[] = [sig('A', 'tokA', T0), sig('F', 'tokF', T0)];
    const evaluated = evaluateReplay(signals, seriesByToken, ['H1']);
    const perf = rulePerformance(evaluated);
    expect(perf.A.real.signalCount).toBe(1);
    expect(perf.A.real.hitRate2x).toBe(1);
    expect(perf.F.real.signalCount).toBe(1);
    // Rules with zero observed signals still appear with a zero-count summary.
    for (const rule of ['B', 'C', 'D', 'E', 'G'] as const) {
      expect(perf[rule].real.signalCount).toBe(0);
    }
  });

  it('separates real vs synthetic-evidence outcomes per rule — never silently pooled', () => {
    const seriesByToken = new Map([
      ['tokReal', [point(T0, 1), point(minutesAfter(60), 2.5)]],
      ['tokSynth', [point(T0, 1), point(minutesAfter(60), 2.5, { source: 'seed_synthetic_continuation' })]]
    ]);
    const signals: ReplayedSignal[] = [sig('A', 'tokReal', T0), sig('A', 'tokSynth', T0)];
    const evaluated = evaluateReplay(signals, seriesByToken, ['H1']);
    const perf = rulePerformance(evaluated);
    expect(perf.A.real.signalCount).toBe(1);
    expect(perf.A.synthetic.signalCount).toBe(1);
  });
});

describe('comboPerformance', () => {
  it('produces all required combo specs (A; A+B; A+C; A+entityAdjusted; A+lowSellPressure; F; F+clusterConf; A/B/F any)', () => {
    const signals: ReplayedSignal[] = [sig('A', 'tok1', T0)];
    const seriesByToken = new Map([['tok1', [point(T0, 1), point(minutesAfter(60), 1.6)]]]);
    const evaluated = evaluateReplay(signals, seriesByToken, ['H1']);
    const combos = comboPerformance(evaluated, DEFAULT_SETTINGS);
    const names = combos.map((c) => c.name);
    expect(names).toContain('A');
    expect(names).toContain('A+B');
    expect(names).toContain('A+C');
    expect(names).toContain('A+entityAdjusted');
    expect(names).toContain('A+lowSellPressure');
    expect(names).toContain('F');
    expect(names).toContain('F+clusterConf');
    expect(names).toContain('A/B/F');
    expect(combos.length).toBe(8);
  });

  it('A+B pairing window: only counts A as A+B when B ALSO fired on the same token within 24h', () => {
    const seriesByToken = new Map([
      ['tokPaired', [point(T0, 1), point(minutesAfter(60), 2.2)]],
      ['tokAloneA', [point(T0, 1), point(minutesAfter(60), 2.2)]]
    ]);
    const signals: ReplayedSignal[] = [
      sig('A', 'tokPaired', T0),
      sig('B', 'tokPaired', new Date(T0.getTime() + 60 * 60_000)), // 1h later, within 24h
      sig('A', 'tokAloneA', T0) // no B ever fires for this token
    ];
    const evaluated = evaluateReplay(signals, seriesByToken, ['H1']);
    const combos = comboPerformance(evaluated, DEFAULT_SETTINGS);
    const aPlusB = combos.find((c) => c.name === 'A+B')!;
    expect(aPlusB.summary.real.signalCount).toBe(1); // only tokPaired qualifies
  });

  it('A+entityAdjusted filter: only counts A signals where metrics.uniqueEntityCount >= settings-derived minimum', () => {
    const seriesByToken = new Map([
      ['tokHighEntity', [point(T0, 1), point(minutesAfter(60), 1.6)]],
      ['tokLowEntity', [point(T0, 1), point(minutesAfter(60), 1.6)]]
    ]);
    const signals: ReplayedSignal[] = [
      sig('A', 'tokHighEntity', T0, { uniqueEntityCount: 15 }),
      sig('A', 'tokLowEntity', T0, { uniqueEntityCount: 1 })
    ];
    const evaluated = evaluateReplay(signals, seriesByToken, ['H1']);
    const combos = comboPerformance(evaluated, DEFAULT_SETTINGS);
    const combo = combos.find((c) => c.name === 'A+entityAdjusted')!;
    expect(combo.summary.real.signalCount).toBe(1);
  });
});

describe('bucketPerformance', () => {
  it('buckets mcapAtTrigger by the documented boundaries: <100k | 100k-1M | 1M-5M | >5M | unknown', () => {
    const seriesByToken = new Map([
      ['tokUnder100k', [point(T0, 1), point(minutesAfter(60), 1.6)]],
      ['tok100kTo1M', [point(T0, 1), point(minutesAfter(60), 1.6)]],
      ['tok1MTo5M', [point(T0, 1), point(minutesAfter(60), 1.6)]],
      ['tokOver5M', [point(T0, 1), point(minutesAfter(60), 1.6)]],
      ['tokNoMcap', [point(T0, 1), point(minutesAfter(60), 1.6)]]
    ]);
    const signals: ReplayedSignal[] = [
      sig('A', 'tokUnder100k', T0, { mcapUsd: 50_000 }),
      sig('A', 'tok100kTo1M', T0, { mcapUsd: 100_000 }), // lower boundary inclusive
      sig('A', 'tok1MTo5M', T0, { mcapUsd: 4_999_999 }), // just under upper boundary
      sig('A', 'tokOver5M', T0, { mcapUsd: 5_000_000 }), // exactly the >=5M boundary
      sig('A', 'tokNoMcap', T0, {}) // no mcapUsd metric at all -> unknown
    ];
    const evaluated = evaluateReplay(signals, seriesByToken, ['H1']);
    const buckets = bucketPerformance(evaluated);

    expect(buckets.mcapAtTrigger['<100k'].real.signalCount).toBe(1);
    expect(buckets.mcapAtTrigger['100k-1M'].real.signalCount).toBe(1);
    expect(buckets.mcapAtTrigger['1M-5M'].real.signalCount).toBe(1);
    expect(buckets.mcapAtTrigger['>5M'].real.signalCount).toBe(1);
    expect(buckets.mcapAtTrigger['unknown'].real.signalCount).toBe(1);
  });

  it('buckets liquidity by the documented boundaries: <20k | 20k-100k | >100k | unknown', () => {
    const seriesByToken = new Map([
      ['tokLowLiq', [point(T0, 1)]],
      ['tokMidLiq', [point(T0, 1)]],
      ['tokHighLiq', [point(T0, 1)]],
      ['tokNoLiq', [point(T0, 1)]]
    ]);
    const signals: ReplayedSignal[] = [
      sig('A', 'tokLowLiq', T0, { liquidityUsd: 19_999 }),
      sig('A', 'tokMidLiq', T0, { liquidityUsd: 20_000 }), // lower boundary inclusive
      sig('A', 'tokHighLiq', T0, { liquidityUsd: 100_000 }), // exactly the >100k boundary
      sig('A', 'tokNoLiq', T0, {})
    ];
    const evaluated = evaluateReplay(signals, seriesByToken, ['H1']);
    const buckets = bucketPerformance(evaluated);

    expect(buckets.liquidity['<20k'].real.signalCount).toBe(1);
    expect(buckets.liquidity['20k-100k'].real.signalCount).toBe(1);
    expect(buckets.liquidity['>100k'].real.signalCount).toBe(1);
    expect(buckets.liquidity['unknown'].real.signalCount).toBe(1);
  });

  it('buckets uniqueEntityCount by the documented boundaries: 1-4 | 5-14 | 15+, excluding signals that cannot be evaluated (no unknown bucket for this dimension)', () => {
    const seriesByToken = new Map([
      ['tokFew', [point(T0, 1)]],
      ['tokMid', [point(T0, 1)]],
      ['tokMany', [point(T0, 1)]],
      ['tokNone', [point(T0, 1)]]
    ]);
    const signals: ReplayedSignal[] = [
      sig('A', 'tokFew', T0, { uniqueEntityCount: 4 }), // upper boundary of 1-4
      sig('A', 'tokMid', T0, { uniqueEntityCount: 5 }), // lower boundary of 5-14
      sig('A', 'tokMany', T0, { uniqueEntityCount: 15 }), // lower boundary of 15+
      sig('A', 'tokNone', T0, {}) // cannot evaluate -> excluded entirely, not 'unknown'
    ];
    const evaluated = evaluateReplay(signals, seriesByToken, ['H1']);
    const buckets = bucketPerformance(evaluated);

    expect(buckets.uniqueEntityCount['1-4'].real.signalCount).toBe(1);
    expect(buckets.uniqueEntityCount['5-14'].real.signalCount).toBe(1);
    expect(buckets.uniqueEntityCount['15+'].real.signalCount).toBe(1);
    // Total bucketed signals across all 3 buckets is 3, not 4 — the
    // no-metric signal contributes to none of them.
    const total =
      buckets.uniqueEntityCount['1-4'].real.signalCount +
      buckets.uniqueEntityCount['5-14'].real.signalCount +
      buckets.uniqueEntityCount['15+'].real.signalCount;
    expect(total).toBe(3);
  });

  it('buckets clusterConcentration by metrics.entityConcentrationRisk, defaulting to unknown when absent or unrecognized', () => {
    const seriesByToken = new Map([
      ['tokLow', [point(T0, 1)]],
      ['tokMed', [point(T0, 1)]],
      ['tokHigh', [point(T0, 1)]],
      ['tokAbsent', [point(T0, 1)]],
      ['tokGarbage', [point(T0, 1)]]
    ]);
    const signals: ReplayedSignal[] = [
      sig('F', 'tokLow', T0, { entityConcentrationRisk: 'low' }),
      sig('F', 'tokMed', T0, { entityConcentrationRisk: 'medium' }),
      sig('F', 'tokHigh', T0, { entityConcentrationRisk: 'high' }),
      sig('F', 'tokAbsent', T0, {}),
      sig('F', 'tokGarbage', T0, { entityConcentrationRisk: 'not-a-real-value' })
    ];
    const evaluated = evaluateReplay(signals, seriesByToken, ['H1']);
    const buckets = bucketPerformance(evaluated);

    expect(buckets.clusterConcentration['low'].real.signalCount).toBe(1);
    expect(buckets.clusterConcentration['medium'].real.signalCount).toBe(1);
    expect(buckets.clusterConcentration['high'].real.signalCount).toBe(1);
    // Both the absent-metric and unrecognized-value signals fall into 'unknown'.
    expect(buckets.clusterConcentration['unknown'].real.signalCount).toBe(2);
  });

  it('split integrity: every bucket always appears (zero-count summary when empty), and real/synthetic-evidence signals never pool together within a bucket', () => {
    const seriesByToken = new Map([
      ['tokReal', [point(T0, 1), point(minutesAfter(60), 2.5)]],
      ['tokSynth', [point(T0, 1), point(minutesAfter(60), 2.5, { source: 'seed_synthetic_continuation' })]]
    ]);
    const signals: ReplayedSignal[] = [
      sig('A', 'tokReal', T0, { mcapUsd: 50_000, liquidityUsd: 10_000, uniqueEntityCount: 2 }),
      sig('A', 'tokSynth', T0, { mcapUsd: 50_000, liquidityUsd: 10_000, uniqueEntityCount: 2 })
    ];
    const evaluated = evaluateReplay(signals, seriesByToken, ['H1']);
    const buckets = bucketPerformance(evaluated);

    // Every documented bucket key exists across all 4 dimensions, even ones
    // with zero signals routed to them.
    expect(Object.keys(buckets.mcapAtTrigger).sort()).toEqual(
      ['1M-5M', '100k-1M', '<100k', '>5M', 'unknown'].sort()
    );
    expect(Object.keys(buckets.liquidity).sort()).toEqual(['20k-100k', '<20k', '>100k', 'unknown'].sort());
    expect(Object.keys(buckets.uniqueEntityCount).sort()).toEqual(['1-4', '5-14', '15+'].sort());
    expect(Object.keys(buckets.clusterConcentration).sort()).toEqual(
      ['low', 'medium', 'high', 'unknown'].sort()
    );
    // An empty bucket still returns a well-formed zero-count summary, not undefined.
    expect(buckets.mcapAtTrigger['>5M'].real.signalCount).toBe(0);
    expect(buckets.mcapAtTrigger['>5M'].synthetic.signalCount).toBe(0);

    // Real vs synthetic-evidence split within the SAME bucket ('<100k' mcap,
    // both signals land there) — never silently pooled.
    expect(buckets.mcapAtTrigger['<100k'].real.signalCount).toBe(1);
    expect(buckets.mcapAtTrigger['<100k'].synthetic.signalCount).toBe(1);
  });
});
