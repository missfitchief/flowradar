// FlowRadar — universe/runner/control classification tests (RM Tasks 1-3 pure).

import { describe, expect, it } from 'vitest';
import {
  classifyUniverseCoverage,
  classifyRunner,
  matchControls,
  earlyEntryBand,
  RUNNER_ATH_THRESHOLD_USD,
  computeTokenOutcome,
  DEFAULT_RUNNER_MINING_CONFIG
} from '../../src/runnermining';
import type { TokenSeriesPoint, MatchFeatures } from '../../src/runnermining';

const T0 = Date.parse('2026-07-01T00:00:00Z');
function pt(hours: number, mcap: number | null): TokenSeriesPoint {
  return { ts: new Date(T0 + hours * 3600_000), marketCapUsd: mcap, priceUsd: null, liquidityUsd: null };
}
function outcomeOf(points: TokenSeriesPoint[], anchored: boolean) {
  return computeTokenOutcome(points, DEFAULT_RUNNER_MINING_CONFIG, { anchoredAtLaunch: anchored });
}

describe('classifyUniverseCoverage', () => {
  it('classifies the full honesty ladder', () => {
    const base = { validMint: true, chain: 'SOLANA' as const, quarantined: false, seriesPointCount: 5 };
    expect(classifyUniverseCoverage(base)).toBe('covered');
    expect(classifyUniverseCoverage({ ...base, seriesPointCount: 1 })).toBe('partially_covered');
    expect(classifyUniverseCoverage({ ...base, seriesPointCount: 0 })).toBe('unavailable');
    expect(classifyUniverseCoverage({ ...base, validMint: false })).toBe('invalid');
    expect(classifyUniverseCoverage({ ...base, chain: 'BSC' })).toBe('unsupported');
    expect(classifyUniverseCoverage({ ...base, quarantined: true })).toBe('quarantined');
  });
});

describe('classifyRunner ($10M bar, fixed)', () => {
  const base = { coverage: 'covered' as const, sourceCount: 2, maxSourceDisagreement: null };

  it('one honest observation >= $10M verifies a runner (no full-life coverage needed)', () => {
    const o = outcomeOf([pt(0, 50_000), pt(1, 12_000_000), pt(2, 4_000_000)], false);
    const c = classifyRunner({ ...base, outcome: o, anchoredAtLaunch: false });
    expect(c.runnerClass).toBe('verified_above_10m');
    expect(c.reasons.join(' ')).toMatch(/observed historical mcap/);
  });

  it('below $10M WITHOUT launch anchoring is insufficient_history — an earlier peak cannot be excluded', () => {
    const o = outcomeOf([pt(0, 50_000), pt(1, 80_000), pt(2, 60_000)], false);
    const c = classifyRunner({ ...base, outcome: o, anchoredAtLaunch: false });
    expect(c.runnerClass).toBe('insufficient_history'); // NEVER a non-runner from a window
  });

  it('below $10M WITH launch anchoring + full coverage verifies a non-runner', () => {
    const o = outcomeOf([pt(0, 50_000), pt(1, 80_000), pt(2, 60_000)], true);
    const c = classifyRunner({ ...base, outcome: o, anchoredAtLaunch: true });
    expect(c.runnerClass).toBe('verified_below_10m');
  });

  it('no observations -> insufficient_history (unknown is not zero, not safe, not a non-runner)', () => {
    const o = outcomeOf([pt(0, null)], true);
    const c = classifyRunner({ ...base, outcome: o, anchoredAtLaunch: true });
    expect(c.runnerClass).toBe('insufficient_history');
  });

  it('cross-source disagreement > 3x poisons the verdict as conflicting_evidence', () => {
    const o = outcomeOf([pt(0, 50_000), pt(1, 15_000_000), pt(2, 60_000)], true);
    const c = classifyRunner({ ...base, outcome: o, anchoredAtLaunch: true, maxSourceDisagreement: 4.2 });
    expect(c.runnerClass).toBe('conflicting_evidence');
    expect(c.confidence).toBe('low');
  });

  it('threshold is exactly $10,000,000 and not configurable here', () => {
    expect(RUNNER_ATH_THRESHOLD_USD).toBe(10_000_000);
    const just = outcomeOf([pt(0, 100_000), pt(1, 10_000_000), pt(2, 100_000)], false);
    expect(classifyRunner({ ...base, outcome: just, anchoredAtLaunch: false }).runnerClass).toBe('verified_above_10m');
    const under = outcomeOf([pt(0, 100_000), pt(1, 9_999_999), pt(2, 100_000)], true);
    expect(classifyRunner({ ...base, outcome: under, anchoredAtLaunch: true }).runnerClass).toBe('verified_below_10m');
  });
});

describe('matchControls (pre-outcome features only, deterministic)', () => {
  const f = (mint: string, dayOffset: number, baseline: number | null, early = 10): MatchFeatures => ({
    mint,
    launchTsMs: T0 + dayOffset * 86400_000,
    baselineMcapUsd: baseline,
    earlyPointCount: early
  });

  it('matches tier1 on close launch + comparable baseline; controls never reuse', () => {
    const runners = [f('R1', 0, 50_000), f('R2', 1, 60_000)];
    const pool = [f('C1', 2, 55_000), f('C2', 3, 45_000), f('FAR', 90, 50_000)];
    const m = matchControls(runners, pool);
    expect(m.length).toBe(2);
    expect(m.every((x) => x.status === 'matched_tier1')).toBe(true);
    const controls = m.map((x) => x.controlMint);
    expect(new Set(controls).size).toBe(2); // no reuse
    expect(controls).not.toContain('FAR');
  });

  it('is deterministic: same inputs, identical output', () => {
    const runners = [f('R1', 0, 50_000)];
    const pool = [f('C1', 2, 55_000), f('C2', 2, 55_000)];
    const a = matchControls(runners, pool);
    const b = matchControls(runners, pool);
    expect(a).toEqual(b);
    expect(a[0].controlMint).toBe('C1'); // mint tiebreak
  });

  it('records an explicit no_valid_control instead of forcing a bad match', () => {
    const m = matchControls([f('R1', 0, 50_000)], [f('ONLY', 200, 50_000)]);
    expect(m[0].status).toBe('no_valid_control');
    expect(m[0].reason).toMatch(/no candidate/);
    expect(m[0].excluded.length).toBeGreaterThan(0); // rejected alternatives preserved
  });

  it('a candidate without baseline mcap is excluded with a reason, never matched on unknowns', () => {
    const m = matchControls([f('R1', 0, 50_000)], [f('NOBASE', 1, null)]);
    expect(m[0].status).toBe('no_valid_control');
    expect(m[0].excluded.some((e) => e.reason.includes('baseline mcap unavailable'))).toBe(true);
  });
});

describe('earlyEntryBand', () => {
  it('buckets the research bands and refuses unknowns', () => {
    expect(earlyEntryBand(3_000)).toBe('under_5k');
    expect(earlyEntryBand(7_500)).toBe('5k_to_10k');
    expect(earlyEntryBand(15_000)).toBe('10k_to_20k');
    expect(earlyEntryBand(35_000)).toBe('20k_to_50k');
    expect(earlyEntryBand(60_000)).toBeNull();
    expect(earlyEntryBand(null)).toBeNull(); // unknown mcap is NOT a band
    expect(earlyEntryBand(Number.NaN)).toBeNull();
  });
});
