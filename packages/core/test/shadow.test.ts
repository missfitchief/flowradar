import { describe, expect, it } from 'vitest';
import { shadowStatus } from '../src/backtest/shadow';
import type { ShadowResultInput } from '../src/backtest/shadow';

// shadowStatus(results, signalAgeMs): ShadowView (Task 42 binding decision 1).
//
// Shadow mode is NOT a new tracked concept — every live Signal already has
// its BacktestResult rows written by the same evaluator/pass Task 40/41
// exercise (see packages/db/src/backtest.ts). shadowStatus is a pure,
// zero-I/O VIEW function: given the per-horizon BacktestResult shape
// ({ horizon, outcomeLabel, notes }) for one signal plus that signal's own
// age (now - triggeredAt, supplied by the caller since packages/core must
// stay free of Date.now()), it derives a per-horizon good/bad/pending/unknown
// status plus an overall roll-up and a syntheticEvidence flag.
//
// Per-horizon mapping (binding decision 1):
//   outcomeLabel in {small_win, good_win, major_win} -> 'good'
//   outcomeLabel in {failure, hard_failure}           -> 'bad'
//   notes includes 'window_incomplete'                -> 'pending' (window not
//     elapsed yet, regardless of label — a fresh row for an open window still
//     carries SOME label from the evaluator's running-series read, but it
//     isn't trustworthy as a final verdict yet)
//   outcomeLabel === 'neutral_pending' AND age < 7d    -> 'pending' (window IS
//     closed per notes, but the label itself is genuinely still forming —
//     neutral within 7 days of signal age is "not enough time/movement yet",
//     not yet a verdict)
//   outcomeLabel === 'neutral_pending' AND age >= 7d   -> 'unknown' (every
//     horizon's window has had its full chance and the signal never
//     produced a directional outcome — this is the final word, just not a
//     good/bad one)
//
// Overall precedence (binding decision 1, explicit): any 'bad' horizon ->
// overall 'bad'; else any 'good' horizon -> overall 'good'; else any
// 'pending' horizon -> overall 'pending'; else 'unknown'.
//
// syntheticEvidence: true iff ANY result's notes contains
// 'synthetic_continuation' (comma-joined per backtest.ts's buildNotes).

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function result(overrides: Partial<ShadowResultInput> & Pick<ShadowResultInput, 'horizon'>): ShadowResultInput {
  return {
    outcomeLabel: 'neutral_pending',
    notes: null,
    ...overrides
  };
}

describe('shadowStatus — per-horizon mapping', () => {
  it('maps small_win/good_win/major_win to good', () => {
    for (const label of ['small_win', 'good_win', 'major_win'] as const) {
      const view = shadowStatus([result({ horizon: 'H1', outcomeLabel: label, notes: null })], 10 * DAY_MS);
      expect(view.horizons.H1).toBe('good');
    }
  });

  it('maps failure/hard_failure to bad', () => {
    for (const label of ['failure', 'hard_failure'] as const) {
      const view = shadowStatus([result({ horizon: 'H1', outcomeLabel: label, notes: null })], 10 * DAY_MS);
      expect(view.horizons.H1).toBe('bad');
    }
  });

  it('window_incomplete note forces pending regardless of the label present on that row', () => {
    const view = shadowStatus(
      [result({ horizon: 'D7', outcomeLabel: 'good_win', notes: 'window_incomplete' })],
      1 * HOUR_MS
    );
    expect(view.horizons.D7).toBe('pending');
  });

  it('neutral_pending with age < 7d (window closed, no window_incomplete note) is pending', () => {
    const view = shadowStatus([result({ horizon: 'H24', outcomeLabel: 'neutral_pending', notes: null })], 3 * DAY_MS);
    expect(view.horizons.H24).toBe('pending');
  });

  it('neutral_pending with age >= 7d (every window has had its chance) is unknown', () => {
    const view = shadowStatus([result({ horizon: 'D7', outcomeLabel: 'neutral_pending', notes: null })], 8 * DAY_MS);
    expect(view.horizons.D7).toBe('unknown');
  });

  it('neutral_pending at EXACTLY 7d age counts as elapsed (>= 7d), not pending', () => {
    const view = shadowStatus([result({ horizon: 'D7', outcomeLabel: 'neutral_pending', notes: null })], 7 * DAY_MS);
    expect(view.horizons.D7).toBe('unknown');
  });

  it('a horizon with no result row at all is unknown (nothing evaluated yet, and this is not the window_incomplete case since no row exists)', () => {
    const view = shadowStatus([result({ horizon: 'M15', outcomeLabel: 'good_win', notes: null })], 10 * DAY_MS);
    // Only M15 supplied — every other horizon (H1, H6, H24, D3, D7) has no row.
    expect(view.horizons.H1).toBe('unknown');
    expect(view.horizons.D7).toBe('unknown');
  });

  it('null outcomeLabel (evaluator produced no usable series) with window_incomplete is pending', () => {
    const view = shadowStatus([result({ horizon: 'H6', outcomeLabel: null, notes: 'window_incomplete' })], 1 * HOUR_MS);
    expect(view.horizons.H6).toBe('pending');
  });

  it('null outcomeLabel with elapsed window (no window_incomplete note) and age >= 7d is unknown', () => {
    const view = shadowStatus([result({ horizon: 'H6', outcomeLabel: null, notes: null })], 8 * DAY_MS);
    expect(view.horizons.H6).toBe('unknown');
  });

  it('null outcomeLabel with elapsed window and age < 7d is pending (mirrors neutral_pending treatment)', () => {
    const view = shadowStatus([result({ horizon: 'H6', outcomeLabel: null, notes: null })], 3 * DAY_MS);
    expect(view.horizons.H6).toBe('pending');
  });
});

describe('shadowStatus — overall precedence (any-bad > any-good > any-pending > unknown)', () => {
  it('any bad horizon wins overall, even alongside good/pending horizons', () => {
    const view = shadowStatus(
      [
        result({ horizon: 'M15', outcomeLabel: 'small_win', notes: null }),
        result({ horizon: 'H1', outcomeLabel: 'failure', notes: null }),
        result({ horizon: 'H6', outcomeLabel: 'neutral_pending', notes: 'window_incomplete' })
      ],
      10 * DAY_MS
    );
    expect(view.overall).toBe('bad');
  });

  it('no bad, but some good -> overall good, even with pending horizons present', () => {
    const view = shadowStatus(
      [
        result({ horizon: 'M15', outcomeLabel: 'good_win', notes: null }),
        result({ horizon: 'H1', outcomeLabel: 'neutral_pending', notes: 'window_incomplete' })
      ],
      10 * DAY_MS
    );
    expect(view.overall).toBe('good');
  });

  it('no bad, no good, some pending -> overall pending', () => {
    const view = shadowStatus(
      [
        result({ horizon: 'M15', outcomeLabel: 'neutral_pending', notes: 'window_incomplete' }),
        result({ horizon: 'H1', outcomeLabel: 'neutral_pending', notes: null })
      ],
      2 * HOUR_MS
    );
    expect(view.overall).toBe('pending');
  });

  it('no bad, no good, no pending (all elapsed neutral) -> overall unknown', () => {
    const view = shadowStatus(
      [result({ horizon: 'D7', outcomeLabel: 'neutral_pending', notes: null })],
      10 * DAY_MS
    );
    expect(view.overall).toBe('unknown');
  });

  it('empty results array -> every horizon unknown, overall unknown', () => {
    const view = shadowStatus([], 10 * DAY_MS);
    expect(view.overall).toBe('unknown');
    expect(view.horizons.M15).toBe('unknown');
    expect(view.horizons.D7).toBe('unknown');
  });
});

describe('shadowStatus — syntheticEvidence flag', () => {
  it('false when no result carries the synthetic_continuation note', () => {
    const view = shadowStatus([result({ horizon: 'H1', outcomeLabel: 'good_win', notes: null })], 10 * DAY_MS);
    expect(view.syntheticEvidence).toBe(false);
  });

  it('true when any result carries synthetic_continuation (comma-joined with window_incomplete)', () => {
    const view = shadowStatus(
      [result({ horizon: 'D7', outcomeLabel: 'neutral_pending', notes: 'window_incomplete,synthetic_continuation' })],
      1 * HOUR_MS
    );
    expect(view.syntheticEvidence).toBe(true);
  });

  it('true when ONLY one of several results carries the marker', () => {
    const view = shadowStatus(
      [
        result({ horizon: 'M15', outcomeLabel: 'good_win', notes: null }),
        result({ horizon: 'H1', outcomeLabel: 'good_win', notes: 'synthetic_continuation' })
      ],
      10 * DAY_MS
    );
    expect(view.syntheticEvidence).toBe(true);
  });
});

describe('shadowStatus — full matrix always returns all 6 horizon keys', () => {
  it('returns M15/H1/H6/H24/D3/D7 regardless of which results were supplied', () => {
    const view = shadowStatus([result({ horizon: 'M15', outcomeLabel: 'good_win', notes: null })], 1 * DAY_MS);
    expect(Object.keys(view.horizons).sort()).toEqual(['D3', 'D7', 'H1', 'H24', 'H6', 'M15']);
  });
});
