// FlowRadar — runner-mining pure engine tests (overnight Task 2).
//
// Two pure functions with a hard wall between them:
//   computeTokenOutcome(series)  — EVALUATION-ONLY labels over the FULL series
//   computeEntryContext(ts, series) — entry-time reconstruction that may only
//     ever see ts<=buyTs (structural no-lookahead) and keeps unknown UNKNOWN.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNNER_MINING_CONFIG,
  computeEntryContext,
  computeTokenOutcome,
  entryMcapBucket,
  type TokenSeriesPoint
} from '../src/runnermining';

const T0 = new Date('2026-01-01T00:00:00Z').getTime();
const MIN = 60_000;

function pt(minute: number, mcap: number | null, liq: number | null = 50_000): TokenSeriesPoint {
  return {
    ts: new Date(T0 + minute * MIN),
    priceUsd: mcap === null ? null : mcap / 1_000_000_000, // 1B supply proxy
    marketCapUsd: mcap,
    liquidityUsd: liq
  };
}

// Baseline 10k -> ATH 2.5M (250x… well, 2.5e6/1e4) -> settles 400k.
const RUNNER_SERIES: TokenSeriesPoint[] = [
  pt(0, 10_000), pt(10, 12_000), pt(30, 55_000), pt(60, 140_000),
  pt(120, 900_000), pt(240, 2_500_000), pt(600, 1_200_000), pt(1440, 400_000)
];

// Peak 80k then -96% with liquidity collapse.
const RUG_SERIES: TokenSeriesPoint[] = [
  pt(0, 15_000), pt(10, 80_000, 60_000), pt(20, 3_000, 800), pt(60, 2_500, 400)
];

// Never 2x, liquidity dies.
const FAILED_SERIES: TokenSeriesPoint[] = [
  pt(0, 8_000, 5_000), pt(30, 9_000, 3_000), pt(90, 4_000, 300), pt(240, 3_500, 100)
];

describe('computeTokenOutcome (evaluation-only, full series)', () => {
  it('labels a 250x runner with multiples + mcap milestones + figure class', () => {
    const o = computeTokenOutcome(RUNNER_SERIES, DEFAULT_RUNNER_MINING_CONFIG);
    expect(o.labels).toContain('runner_2x');
    expect(o.labels).toContain('runner_5x');
    expect(o.labels).toContain('runner_10x');
    expect(o.labels).toContain('runner_50x');
    expect(o.labels).toContain('reached_1m_mcap');
    expect(o.labels).not.toContain('reached_10m_mcap');
    expect(o.labels).toContain('seven_figure_runner'); // ATH in [1e6, 1e7)
    expect(o.labels).not.toContain('eight_figure_runner');
    expect(o.athMcapUsd).toBe(2_500_000);
    expect(o.baselineMcapUsd).toBe(10_000);
    expect(o.maxMultipleFromBaseline).toBeCloseTo(250, 5);
    // time to 2x: first point >= 20k is minute 30.
    expect(o.timeToMilestonesMin.x2).toBe(30);
    expect(o.timeToMilestonesMin.mcap1m).toBe(240);
  });

  it('labels a rug (>=90% collapse from peak + liquidity death)', () => {
    const o = computeTokenOutcome(RUG_SERIES, DEFAULT_RUNNER_MINING_CONFIG);
    expect(o.labels).toContain('rug_or_collapse');
    expect(o.maxDrawdownPct).toBeGreaterThanOrEqual(90);
  });

  it('labels a failed launch (never 2x, liquidity below floor at end)', () => {
    const o = computeTokenOutcome(FAILED_SERIES, DEFAULT_RUNNER_MINING_CONFIG);
    expect(o.labels).toContain('failed_launch');
    expect(o.labels).not.toContain('runner_2x');
  });

  it('labels illiquid_untradeable when liquidity never clears the floor', () => {
    const series = [pt(0, 10_000, 200), pt(30, 40_000, 300), pt(60, 90_000, 250)];
    const o = computeTokenOutcome(series, DEFAULT_RUNNER_MINING_CONFIG);
    expect(o.labels).toContain('illiquid_untradeable');
    // A 9x on dead liquidity is a fake markup — multiples still recorded, but
    // the label warns and confidence is not high.
    expect(o.confidence).not.toBe('high');
  });

  it('returns insufficient_data for tiny/empty/valueless series (never fabricates)', () => {
    expect(computeTokenOutcome([], DEFAULT_RUNNER_MINING_CONFIG).labels).toEqual(['insufficient_data']);
    expect(computeTokenOutcome([pt(0, 10_000)], DEFAULT_RUNNER_MINING_CONFIG).labels).toEqual(['insufficient_data']);
    const noMcap = [pt(0, null), pt(10, null), pt(20, null)];
    expect(computeTokenOutcome(noMcap, DEFAULT_RUNNER_MINING_CONFIG).labels).toEqual(['insufficient_data']);
  });

  it('skips null-mcap gaps without zeroing them', () => {
    const gappy = [pt(0, 10_000), pt(10, null), pt(30, 55_000), pt(60, null), pt(120, 900_000)];
    const o = computeTokenOutcome(gappy, DEFAULT_RUNNER_MINING_CONFIG);
    expect(o.athMcapUsd).toBe(900_000);
    expect(o.maxDrawdownPct).toBe(0); // never declined among VALID points
  });

  it('an unremarkable token gets EMPTY labels — never a false insufficient_data', () => {
    // Drifts down 40% on healthy liquidity: fully evaluable, nothing notable.
    const drift = [pt(0, 100_000), pt(60, 80_000), pt(120, 70_000), pt(240, 60_000)];
    const o = computeTokenOutcome(drift, DEFAULT_RUNNER_MINING_CONFIG);
    expect(o.labels).toEqual([]); // evaluable, no outcome — distinct from insufficient_data
    expect(o.baselineMcapUsd).toBe(100_000);
  });

  it('is deterministic', () => {
    const a = computeTokenOutcome(RUNNER_SERIES, DEFAULT_RUNNER_MINING_CONFIG);
    const b = computeTokenOutcome(RUNNER_SERIES, DEFAULT_RUNNER_MINING_CONFIG);
    expect(a).toEqual(b);
  });
});

describe('computeEntryContext (no-lookahead, unknown stays unknown)', () => {
  it('reconstructs entry mcap from the nearest PRIOR point', () => {
    const buyTs = new Date(T0 + 45 * MIN); // between minute 30 (55k) and 60 (140k)
    const e = computeEntryContext(buyTs, RUNNER_SERIES, DEFAULT_RUNNER_MINING_CONFIG);
    expect(e.entryMarketCapUsd).toBe(55_000); // minute 30, NEVER the later 140k
    expect(e.valuationStatus).toBe('nearest_prior_snapshot');
    expect(e.valuationAgeSeconds).toBe(15 * 60);
    expect(e.bucket).toBe('50k_to_100k');
    expect(e.belowFocusCeiling).toBe(false);
  });

  it('an exact-timestamp point is used with age 0', () => {
    const e = computeEntryContext(new Date(T0 + 30 * MIN), RUNNER_SERIES, DEFAULT_RUNNER_MINING_CONFIG);
    expect(e.entryMarketCapUsd).toBe(55_000);
    expect(e.valuationAgeSeconds).toBe(0);
  });

  it('NO-LOOKAHEAD property: truncated-at-buy series gives the IDENTICAL context', () => {
    for (const minute of [0, 5, 30, 45, 61, 120, 300, 1440, 2000]) {
      const buyTs = new Date(T0 + minute * MIN);
      const truncated = RUNNER_SERIES.filter((p) => p.ts.getTime() <= buyTs.getTime());
      const full = computeEntryContext(buyTs, RUNNER_SERIES, DEFAULT_RUNNER_MINING_CONFIG);
      const trunc = computeEntryContext(buyTs, truncated, DEFAULT_RUNNER_MINING_CONFIG);
      expect(full).toEqual(trunc);
    }
  });

  it('OUTCOME cannot leak into entry: identical prefixes with different futures give identical contexts', () => {
    const prefix = [pt(0, 15_000), pt(10, 18_000)];
    const buyTs = new Date(T0 + 12 * MIN);
    const becomesRunner = [...prefix, pt(30, 500_000), pt(60, 5_000_000)];
    const becomesRug = [...prefix, pt(30, 900, 100), pt(60, 500, 50)];
    expect(computeEntryContext(buyTs, becomesRunner, DEFAULT_RUNNER_MINING_CONFIG))
      .toEqual(computeEntryContext(buyTs, becomesRug, DEFAULT_RUNNER_MINING_CONFIG));
  });

  it('a FUTURE-only series yields unavailable (future snapshots rejected), never a value', () => {
    const buyTs = new Date(T0 - 10 * MIN); // before every point
    const e = computeEntryContext(buyTs, RUNNER_SERIES, DEFAULT_RUNNER_MINING_CONFIG);
    expect(e.valuationStatus).toBe('unavailable');
    expect(e.entryMarketCapUsd).toBeNull();
    expect(e.bucket).toBe('unknown');
    expect(e.belowFocusCeiling).toBeNull(); // unknown, NOT false/zero/safe
  });

  it('a stale prior point (older than max age) yields unavailable', () => {
    const cfg = { ...DEFAULT_RUNNER_MINING_CONFIG, maxEntrySnapshotAgeSec: 600 };
    const buyTs = new Date(T0 + 45 * MIN); // nearest prior is minute 30 = 900s old
    const e = computeEntryContext(buyTs, RUNNER_SERIES, cfg);
    expect(e.valuationStatus).toBe('unavailable');
    expect(e.entryMarketCapUsd).toBeNull();
  });

  it('confidence decays with snapshot age but never reaches 0 within the window', () => {
    const fresh = computeEntryContext(new Date(T0 + 30 * MIN), RUNNER_SERIES, DEFAULT_RUNNER_MINING_CONFIG);
    const older = computeEntryContext(new Date(T0 + 55 * MIN), RUNNER_SERIES, DEFAULT_RUNNER_MINING_CONFIG);
    expect(fresh.valuationConfidence).toBeGreaterThan(older.valuationConfidence);
    expect(older.valuationConfidence).toBeGreaterThan(0);
  });

  it('never emits current_price_estimate for historical mining', () => {
    for (const minute of [0, 45, 5000]) {
      const e = computeEntryContext(new Date(T0 + minute * MIN), RUNNER_SERIES, DEFAULT_RUNNER_MINING_CONFIG);
      expect(e.valuationStatus).not.toBe('current_price_estimate');
    }
  });
});

describe('entryMcapBucket', () => {
  it('buckets are [min, max) with the spec boundaries', () => {
    expect(entryMcapBucket(4_999)).toBe('under_5k');
    expect(entryMcapBucket(5_000)).toBe('5k_to_10k');
    expect(entryMcapBucket(10_000)).toBe('10k_to_20k');
    expect(entryMcapBucket(19_999)).toBe('10k_to_20k');
    expect(entryMcapBucket(20_000)).toBe('20k_to_50k');
    expect(entryMcapBucket(99_999)).toBe('50k_to_100k');
    expect(entryMcapBucket(250_000)).toBe('250k_to_1m');
    expect(entryMcapBucket(1_000_000)).toBe('above_1m');
    expect(entryMcapBucket(null)).toBe('unknown');
    expect(entryMcapBucket(Number.NaN)).toBe('unknown');
  });
});
