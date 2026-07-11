// FlowRadar — token-risk cache freshness logic (pure, Task 1 Helius 429 fix).
//
// Derives the freshness STATE of a cached risk snapshot at read time and
// reconstructs the RiskReport the consumer should use, preserving FlowScore
// semantics EXACTLY: a fresh snapshot returns the stored {penalty, flags}
// unchanged (computeFlowScore reads only penalty). Stale readings keep the
// same penalty (so the score is identical to when that value was fresh) and
// merely ADD a label flag. Missing/unavailable is penalty 0 + a warn flag —
// "no penalty applied because data is unknown", which is NOT "safe" (the
// established holder_data_unavailable semantics).

import type { RiskReport } from '../types';

export type RiskFreshness =
  | 'fresh' // observed within the fresh window
  | 'stale_usable' // past expiry but a real last-known value exists (labeled)
  | 'refresh_pending' // due for refresh; last value still returned if any
  | 'unavailable' // provider says unavailable (mega-holder mint etc.)
  | 'provider_throttled' // last attempt was 429
  | 'error'; // last attempt errored

export type RiskSnapshotStatusValue = 'ok' | 'unavailable' | 'throttled' | 'error';

export interface RiskSnapshotView {
  status: RiskSnapshotStatusValue;
  penalty: number;
  flags: RiskReport['flags'];
  observedAt: Date | null;
  expiresAt: Date;
  nextRefreshAt: Date;
  confidence: number;
}

export interface FreshnessConfig {
  /** Seconds a successful observation stays 'fresh'. */
  freshSec: number;
}

export const DEFAULT_RISK_FRESHNESS: FreshnessConfig = { freshSec: 600 };

const UNAVAILABLE_FLAG = {
  id: 'holder_data_unavailable',
  label: 'Holder concentration data unavailable',
  severity: 'warn' as const
};
const STALE_FLAG = {
  id: 'risk_data_stale',
  label: 'Risk data is stale (cached; refresh pending) — treat as provisional',
  severity: 'info' as const
};

/** The RiskReport returned when NOTHING is known — penalty 0 (no penalty
 *  applied), with an explicit unavailable flag. NOT "safe". */
export function unavailableRiskReport(): RiskReport {
  return { flags: [UNAVAILABLE_FLAG], penalty: 0 };
}

/** Derives the freshness state of a snapshot as of `now`. */
export function riskFreshness(snap: RiskSnapshotView, now: Date, cfg: FreshnessConfig = DEFAULT_RISK_FRESHNESS): RiskFreshness {
  if (snap.status === 'unavailable') return 'unavailable';
  if (snap.status === 'throttled') return 'provider_throttled';
  if (snap.status === 'error') return 'error';
  // status === 'ok'
  if (snap.observedAt === null) return 'refresh_pending';
  const ageMs = now.getTime() - snap.observedAt.getTime();
  if (ageMs <= cfg.freshSec * 1000) return 'fresh';
  return snap.nextRefreshAt.getTime() <= now.getTime() ? 'refresh_pending' : 'stale_usable';
}

/**
 * The RiskReport a consumer should use for a snapshot, given its freshness.
 * - fresh: stored {penalty, flags} VERBATIM (identical FlowScore).
 * - any state with a usable LAST-GOOD value (a prior successful observation
 *   whose penalty/flags are preserved on the row — i.e. observedAt is set and
 *   the provider hasn't declared the token honestly `unavailable`): the stored
 *   penalty + a STALE label flag. The penalty is UNCHANGED, so the FlowScore
 *   is identical to when that value was fresh. This deliberately covers
 *   provider_throttled / error too: dropping a real risk penalty to a false 0
 *   just because the LATEST refresh was throttled would be LESS safe, not more.
 * - honest `unavailable` (mega-holder mint) or no value ever observed:
 *   unavailableRiskReport() (penalty 0, warn flag) — unknown, never "safe".
 */
export function reportForSnapshot(snap: RiskSnapshotView, freshness: RiskFreshness): RiskReport {
  if (freshness === 'fresh') return { flags: snap.flags, penalty: snap.penalty };
  const hasUsableLastGood = snap.observedAt !== null && snap.status !== 'unavailable';
  if (hasUsableLastGood) {
    return { flags: [...snap.flags, STALE_FLAG], penalty: snap.penalty };
  }
  return unavailableRiskReport();
}

/**
 * Exponential backoff schedule for the NEXT refresh after a failure, bounded.
 * failCount 1 -> base, 2 -> base*factor, … capped at maxSec. A successful
 * refresh resets to the normal fresh cadence (handled by the caller).
 */
export function nextRefreshDelaySec(failCount: number, opts: { baseSec: number; factor: number; maxSec: number }): number {
  if (failCount <= 0) return opts.baseSec;
  const delay = opts.baseSec * Math.pow(opts.factor, failCount - 1);
  return Math.min(delay, opts.maxSec);
}
