// FlowRadar — address dormancy engine tests (dormancy Task 7, pure).
//
// Pins the honesty contracts: strictly-pre-event windows (no lookahead),
// coverage-start honesty (history starting inside a window is incomplete,
// NEVER dormant), fresh only on positive funding evidence, unknown stays
// unknown, and completeness FAILS CLOSED — only an explicit
// meaningfulEventsComplete: true can mint covered-dormant claims.

import { describe, expect, it } from 'vitest';
import { assessAddressDormancy, DORMANCY_ENGINE_VERSION } from '../../src/dormancy/dormancy';
import type { DormancyAssessmentInput } from '../../src/dormancy/dormancy';

const EVENT = new Date('2026-06-30T00:00:00Z');
const daysBefore = (d: number) => new Date(EVENT.getTime() - d * 86_400_000);
const hoursBefore = (h: number) => new Date(EVENT.getTime() - h * 3600_000);

describe('assessAddressDormancy', () => {
  it('meaningful activity inside the shortest window classifies active', () => {
    const r = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [{ ts: daysBefore(1) }],
      coverageStart: daysBefore(200),
      meaningfulEventsComplete: true
    });
    expect(r.overallClass).toBe('active');
    expect(r.windows.every((w) => w.class === 'active')).toBe(true);
    expect(r.maxCoveredDormantDays).toBeNull();
    expect(r.engineVersion).toBe(DORMANCY_ENGINE_VERSION);
  });

  it('no lookahead: events at or after the anchor are invisible (and receipted)', () => {
    const r = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [{ ts: EVENT }, { ts: new Date(EVENT.getTime() + 1000) }],
      coverageStart: daysBefore(200),
      meaningfulEventsComplete: true
    });
    expect(r.receipts.preEventMeaningfulCount).toBe(0);
    expect(r.receipts.futureEventsIgnored).toBe(2);
    expect(r.overallClass).toBe('covered_dormant');
    expect(r.maxCoveredDormantDays).toBe(90);
  });

  it('full coverage + zero meaningful events = covered_dormant across all windows', () => {
    const r = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [],
      coverageStart: daysBefore(365),
      meaningfulEventsComplete: true
    });
    expect(r.overallClass).toBe('covered_dormant');
    expect(r.windows.map((w) => w.class)).toEqual([
      'covered_dormant',
      'covered_dormant',
      'covered_dormant',
      'covered_dormant'
    ]);
    expect(r.maxCoveredDormantDays).toBe(90);
  });

  it('coverage-start honesty: history starting inside a window is incomplete, NEVER dormant', () => {
    // Coverage begins 10d before the event: the 7d window is fully covered,
    // the 14/30/90d windows are NOT — they must be incomplete, not dormant.
    const r = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [],
      coverageStart: daysBefore(10),
      meaningfulEventsComplete: true
    });
    expect(r.windows.map((w) => w.class)).toEqual([
      'covered_dormant',
      'apparently_dormant_incomplete_history',
      'apparently_dormant_incomplete_history',
      'apparently_dormant_incomplete_history'
    ]);
    expect(r.maxCoveredDormantDays).toBe(7);
    expect(r.overallClass).toBe('covered_dormant');
  });

  it('coverage starting inside EVERY window (no funding evidence) is incomplete history — never dormant, never fresh', () => {
    const r = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [],
      coverageStart: daysBefore(2),
      meaningfulEventsComplete: true
    });
    expect(r.windows.every((w) => w.class === 'apparently_dormant_incomplete_history')).toBe(true);
    expect(r.overallClass).toBe('apparently_dormant_incomplete_history');
    expect(r.maxCoveredDormantDays).toBeNull();
  });

  it('no coverage knowledge stays unknown — zero events mean NOTHING without coverage', () => {
    const r = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [],
      coverageStart: null,
      meaningfulEventsComplete: true
    });
    expect(r.overallClass).toBe('unknown');
    expect(r.windows.every((w) => w.class === 'unknown')).toBe(true);
  });

  it('coverage starting at/after the event is unknown (no pre-event observation)', () => {
    const r = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [],
      coverageStart: EVENT,
      meaningfulEventsComplete: true
    });
    expect(r.overallClass).toBe('unknown');
    expect(r.windows[0].reasonCodes).toContain('no_pre_event_coverage');
  });

  it('fresh requires POSITIVE funding evidence at the start of coverage, within the fresh horizon', () => {
    // Funded 24h before the event, funding == start of history -> fresh.
    const funded = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [{ ts: hoursBefore(24) }],
      coverageStart: hoursBefore(24),
      firstInboundFundingTs: hoursBefore(24),
      meaningfulEventsComplete: true
    });
    expect(funded.overallClass).toBe('fresh');
    expect(funded.maxCoveredDormantDays).toBeNull();
    expect(funded.caveats.join(' ')).toContain('earlier unobserved history cannot be excluded');

    // Funding older than the 72h horizon -> NOT fresh.
    const old = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [],
      coverageStart: daysBefore(10),
      firstInboundFundingTs: daysBefore(10),
      meaningfulEventsComplete: true
    });
    expect(old.overallClass).not.toBe('fresh');

    // Funding recent but coverage long predates it -> NOT fresh (wallet has history).
    const preexisting = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [],
      coverageStart: daysBefore(200),
      firstInboundFundingTs: hoursBefore(24),
      meaningfulEventsComplete: true
    });
    expect(preexisting.overallClass).toBe('covered_dormant');

    // Meaningful history older than the fresh horizon -> NOT fresh.
    const withHistory = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [{ ts: daysBefore(30) }],
      coverageStart: hoursBefore(24),
      firstInboundFundingTs: hoursBefore(24),
      meaningfulEventsComplete: true
    });
    expect(withHistory.overallClass).not.toBe('fresh');
  });

  it('a mere recent watch-start is NOT fresh without funding evidence', () => {
    const r = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [],
      coverageStart: hoursBefore(24),
      firstInboundFundingTs: null,
      meaningfulEventsComplete: true
    });
    expect(r.overallClass).toBe('apparently_dormant_incomplete_history');
  });

  it('caller-flagged incomplete event lists never mint covered-dormant claims', () => {
    const r = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [],
      coverageStart: daysBefore(365),
      meaningfulEventsComplete: false
    });
    expect(r.windows.every((w) => w.class === 'apparently_dormant_incomplete_history')).toBe(true);
    expect(r.windows[0].reasonCodes).toContain('meaningful_event_list_incomplete');
    expect(r.maxCoveredDormantDays).toBeNull();
    expect(r.caveats.join(' ')).toContain('no covered-dormant claim');
  });

  it('completeness FAILS CLOSED: a missing/undefined flag (loose cast) never mints covered-dormant', () => {
    // A caller that forgot the required flag (e.g. via an `as` cast) must be
    // treated as INCOMPLETE — anything but an explicit true fails closed.
    const r = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [],
      coverageStart: daysBefore(365),
      meaningfulEventsComplete: undefined
    } as unknown as DormancyAssessmentInput);
    expect(r.windows.every((w) => w.class === 'apparently_dormant_incomplete_history')).toBe(true);
    expect(r.overallClass).toBe('apparently_dormant_incomplete_history');
    expect(r.maxCoveredDormantDays).toBeNull();
    expect(r.receipts.meaningfulEventsComplete).toBe(false);
  });

  it('activity beyond the short windows: dormant short windows, active long windows, contiguous max', () => {
    const r = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [{ ts: daysBefore(20) }],
      coverageStart: daysBefore(365),
      meaningfulEventsComplete: true
    });
    expect(r.windows.map((w) => w.class)).toEqual(['covered_dormant', 'covered_dormant', 'active', 'active']);
    expect(r.maxCoveredDormantDays).toBe(14);
    expect(r.overallClass).toBe('covered_dormant');
  });

  it('defensive coverage: an observed event before the claimed coverage start extends coverage', () => {
    const r = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [{ ts: daysBefore(100) }],
      coverageStart: daysBefore(10), // claimed later than the observed event
      meaningfulEventsComplete: true
    });
    // effective coverage = 100d ago -> every window fully covered, no events inside
    expect(r.windows.map((w) => w.class)).toEqual([
      'covered_dormant',
      'covered_dormant',
      'covered_dormant',
      'covered_dormant'
    ]);
    expect(r.receipts.effectiveCoverageStart).toBe(daysBefore(100).toISOString());
  });

  it('windows are configurable and receipts carry the full audit trail', () => {
    const r = assessAddressDormancy({
      eventTs: EVENT,
      meaningfulEvents: [{ ts: daysBefore(3) }],
      coverageStart: daysBefore(50),
      meaningfulEventsComplete: true,
      config: { windowsDays: [1, 5] }
    });
    expect(r.windows.map((w) => w.windowDays)).toEqual([1, 5]);
    expect(r.windows.map((w) => w.class)).toEqual(['covered_dormant', 'active']);
    expect(r.receipts.windowsDays).toEqual([1, 5]);
    expect(r.receipts.coverageStart).toBe(daysBefore(50).toISOString());
    expect(r.receipts.oldestPreEventTs).toBe(daysBefore(3).toISOString());
  });
});
