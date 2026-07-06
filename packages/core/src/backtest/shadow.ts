// FlowRadar — shadowStatus: pure shadow-mode VIEW helper (Task 42 binding
// decision 1).
//
// ---------------------------------------------------------------------------
// Shadow mode is an EVALUATION VIEW, not a new tracking concept
// ---------------------------------------------------------------------------
// FlowRadar has no execution/trading path anywhere in the codebase, so
// "shadow mode" (Task 42 brief: "run live for days, record EVERY signal
// WITHOUT trading/acting") is already satisfied by the existing Signal +
// BacktestResult tables: every live detection persists a Signal row (Task
// 15), and the backtest worker (Task 40, 6h cadence) evaluates every signal
// older than 15 minutes against real TokenMarketSnapshot data, upserting one
// BacktestResult row per horizon — read-only observation by construction,
// since there is nothing for it to act on. This file adds NO new table and
// NO new worker job; it is purely a display-layer transform from "the
// BacktestResult rows for one signal" to "a good/bad/pending/unknown verdict
// per horizon plus an overall roll-up", consumed by apps/web/app/shadow.
//
// ---------------------------------------------------------------------------
// Per-horizon mapping (binding decision 1)
// ---------------------------------------------------------------------------
// Inputs are the {horizon, outcomeLabel, notes} slice of a BacktestResult row
// (see packages/db/src/backtest.ts's buildNotes for the exact `notes`
// vocabulary this reads: 'window_incomplete' and/or 'synthetic_continuation',
// comma-joined, or null when neither applies).
//
//   1. No result row supplied for a horizon at all -> 'unknown' (nothing has
//      been evaluated for that horizon yet — distinct from the
//      window_incomplete case, where a row exists but its window hasn't
//      closed; a caller reaching this function before any backtest pass has
//      touched a fresh signal will see this for every horizon).
//   2. notes includes 'window_incomplete' -> 'pending', REGARDLESS of
//      whatever label the row happens to carry (an evaluator can compute a
//      provisional label off the partial series it's seen so far, but that
//      label is not a trustworthy verdict until the window itself has
//      elapsed).
//   3. outcomeLabel in {small_win, good_win, major_win} -> 'good'.
//   4. outcomeLabel in {failure, hard_failure} -> 'bad'.
//   5. outcomeLabel is 'neutral_pending' OR null (evaluator had no usable
//      series/basis to compute a label from at all) -> 'pending' when
//      signalAgeMs < SEVEN_DAYS_MS, else 'unknown'. Rationale: the window
//      itself has already closed (no window_incomplete note, per step 2
//      above already short-circuiting that case), but "no directional
//      outcome yet" from a signal still within its own 7-day evaluation
//      horizon is genuinely still-forming, not a final verdict — only once
//      every horizon (up to D7) has had its full 7-day chance to produce
//      something does a persistent neutral read become the honest final
//      word ('unknown': never resolved good or bad).
//
// ---------------------------------------------------------------------------
// Overall precedence (binding decision 1 — explicit, documented order)
// ---------------------------------------------------------------------------
//   any horizon 'bad'     -> overall 'bad'
//   else any horizon 'good' -> overall 'good'
//   else any horizon 'pending' -> overall 'pending'
//   else                     -> overall 'unknown'
// "Worst-of-elapsed": a single bad horizon (e.g. the token rugged within 24h
// even though M15 briefly looked like a small win) must dominate the overall
// read — a trader scanning the Shadow page needs the worst outcome to be
// impossible to miss, not averaged away by earlier good horizons.
//
// ---------------------------------------------------------------------------
// syntheticEvidence
// ---------------------------------------------------------------------------
// True iff ANY supplied result's notes contains 'synthetic_continuation'
// (comma-joined with 'window_incomplete' when both apply — see
// packages/db/src/backtest.ts's buildNotes). This mirrors evaluateReplay's
// own per-signal syntheticEvidence flag (Task 41) but is computed
// independently here since shadow.ts reads BacktestResult.notes directly
// rather than TokenMarketSnapshot.source.

import type { BacktestHorizon } from '../types';

const ALL_HORIZONS: BacktestHorizon[] = ['M15', 'H1', 'H6', 'H24', 'D3', 'D7'];

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const GOOD_LABELS = new Set(['small_win', 'good_win', 'major_win']);
const BAD_LABELS = new Set(['failure', 'hard_failure']);

export type ShadowHorizonStatus = 'good' | 'bad' | 'pending' | 'unknown';

export interface ShadowResultInput {
  horizon: BacktestHorizon;
  outcomeLabel: string | null;
  notes: string | null;
}

export interface ShadowView {
  horizons: Record<BacktestHorizon, ShadowHorizonStatus>;
  overall: ShadowHorizonStatus;
  syntheticEvidence: boolean;
}

function hasNote(notes: string | null, marker: string): boolean {
  if (notes === null) return false;
  return notes
    .split(',')
    .map((n) => n.trim())
    .includes(marker);
}

function statusForResult(result: ShadowResultInput, signalAgeMs: number): ShadowHorizonStatus {
  if (hasNote(result.notes, 'window_incomplete')) return 'pending';

  const label = result.outcomeLabel;
  if (label !== null && GOOD_LABELS.has(label)) return 'good';
  if (label !== null && BAD_LABELS.has(label)) return 'bad';

  // label is 'neutral_pending' or null — window has closed (no
  // window_incomplete note) but no directional outcome exists yet.
  return signalAgeMs < SEVEN_DAYS_MS ? 'pending' : 'unknown';
}

/**
 * Maps a signal's BacktestResult rows (one per horizon, possibly incomplete)
 * plus the signal's own age into a per-horizon good/bad/pending/unknown
 * ShadowView, with an overall worst-of-elapsed roll-up and a
 * syntheticEvidence flag. Pure, zero-I/O — see this file's header for the
 * full mapping/precedence rules.
 */
export function shadowStatus(results: ShadowResultInput[], signalAgeMs: number): ShadowView {
  const byHorizon = new Map<BacktestHorizon, ShadowResultInput>();
  for (const r of results) {
    byHorizon.set(r.horizon, r);
  }

  const horizons = {} as Record<BacktestHorizon, ShadowHorizonStatus>;
  for (const h of ALL_HORIZONS) {
    const result = byHorizon.get(h);
    horizons[h] = result ? statusForResult(result, signalAgeMs) : 'unknown';
  }

  const values = Object.values(horizons);
  let overall: ShadowHorizonStatus;
  if (values.includes('bad')) {
    overall = 'bad';
  } else if (values.includes('good')) {
    overall = 'good';
  } else if (values.includes('pending')) {
    overall = 'pending';
  } else {
    overall = 'unknown';
  }

  const syntheticEvidence = results.some((r) => hasNote(r.notes, 'synthetic_continuation'));

  return { horizons, overall, syntheticEvidence };
}
