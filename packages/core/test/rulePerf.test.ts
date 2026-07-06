// FlowRadar — evaluateReplay / rulePerformance / comboPerformance tests
// (Task 41 binding decision 2). TDD RED-then-GREEN.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings';
import { evaluateReplay, rulePerformance, comboPerformance } from '../src/backtest/rulePerf';
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
