// FlowRadar — address dormancy engine (pure; dormancy plan Task 7).
//
// Assesses, for ONE anchor event (e.g. a token entry), whether the wallet was
// dormant in the strictly-pre-event windows 7/14/30/90d — counting MEANINGFUL
// events ONLY (Task 6 classes meaningful_trade/meaningful_transfer; dust,
// spam, service, self-transfer, artifact and unknown-value events never
// establish or reset dormancy).
//
// Honesty rules (binding):
//   - No lookahead: events at or after the anchor eventTs are INVISIBLE to
//     the assessment (they are counted and reported as ignored, as a receipt
//     that the guard ran).
//   - Coverage-start honesty: a window is only "covered" when our local
//     observation of the wallet begins AT OR BEFORE the window start. History
//     that begins INSIDE a window makes an empty window
//     'apparently_dormant_incomplete_history' — NEVER 'covered_dormant'.
//     Missing history is not dormancy.
//   - 'fresh' requires POSITIVE evidence (the earliest local observation is
//     an inbound funding within freshMaxAgeHours of the event) — a wallet we
//     merely started watching recently is incomplete history, not fresh.
//   - Unknown stays unknown: no coverage knowledge, or coverage starting at/
//     after the event, yields 'unknown', never 'dormant' and never 'fresh'.

// v2: meaningfulEventsComplete is REQUIRED input and fails CLOSED (anything
// but an explicit true is treated as incomplete) — completeness must never
// fail open: a caller that forgot the flag could otherwise mint covered-
// dormant claims from a possibly-truncated event list.
export const DORMANCY_ENGINE_VERSION = 2;

export type DormancyClass =
  | 'fresh'
  | 'covered_dormant'
  | 'active'
  | 'apparently_dormant_incomplete_history'
  | 'unknown';

export interface DormancyConfig {
  /** Strictly-pre-event windows, in days. Sorted ascending internally. */
  windowsDays: number[];
  /** Max age of the earliest observation for the 'fresh' claim. */
  freshMaxAgeHours: number;
  /**
   * The first inbound funding must be within this many seconds of the
   * earliest observation for 'fresh' (the funding IS the start of history).
   */
  freshFundingCoverageSlackSec: number;
}

export const DEFAULT_DORMANCY_CONFIG: DormancyConfig = {
  windowsDays: [7, 14, 30, 90],
  freshMaxAgeHours: 72,
  freshFundingCoverageSlackSec: 3600
};

export interface DormancyAssessmentInput {
  /** The anchor being assessed (e.g. first local buy of a token). */
  eventTs: Date;
  /**
   * MEANINGFUL events only (caller filters via the Task 6 classifier).
   * Any-order, any-time: the engine drops ts >= eventTs itself (no lookahead).
   */
  meaningfulEvents: { ts: Date }[];
  /**
   * Earliest LOCAL observation of ANY event for this wallet (meaningful or
   * not — coverage is about observation, not economics). null == we have no
   * coverage knowledge at all.
   */
  coverageStart: Date | null;
  /**
   * Earliest observed INBOUND funding transfer ts, when known. Positive
   * freshness evidence ONLY when it coincides with the start of coverage.
   */
  firstInboundFundingTs?: Date | null;
  /**
   * Whether the meaningfulEvents list is known-COMPLETE over the assessed
   * range given coverage. REQUIRED — completeness never fails open: anything
   * but an explicit true is treated as incomplete. Callers whose
   * classification pass was bounded/truncated MUST pass false — empty windows
   * then degrade to 'apparently_dormant_incomplete_history' instead of
   * 'covered_dormant'.
   */
  meaningfulEventsComplete: boolean;
  config?: Partial<DormancyConfig>;
}

export interface DormancyWindowObservation {
  windowDays: number;
  windowStart: string;
  windowEnd: string; // == eventTs (exclusive)
  meaningfulEventCount: number;
  /** coverage began at/before windowStart AND the event list is complete. */
  coverageComplete: boolean;
  class: DormancyClass;
  reasonCodes: string[];
}

export interface DormancyResult {
  engineVersion: number;
  eventTs: string;
  overallClass: DormancyClass;
  /**
   * Largest window (days) that is covered_dormant with every shorter window
   * also covered_dormant. null when no covered-dormant claim can be made.
   */
  maxCoveredDormantDays: number | null;
  windows: DormancyWindowObservation[];
  receipts: {
    coverageStart: string | null;
    effectiveCoverageStart: string | null;
    firstInboundFundingTs: string | null;
    preEventMeaningfulCount: number;
    /** Events dropped by the no-lookahead guard (ts >= eventTs). */
    futureEventsIgnored: number;
    oldestPreEventTs: string | null;
    newestPreEventTs: string | null;
    meaningfulEventsComplete: boolean;
    freshMaxAgeHours: number;
    windowsDays: number[];
  };
  caveats: string[];
}

const BASE_CAVEATS = [
  'meaningful events only (Task 6 classes) — dust/spam/service/self-transfer/unknown-value events never establish or reset dormancy',
  'coverage is bounded LOCAL observation — absence of local rows is not proof of on-chain inactivity; incomplete windows are labeled, never called dormant'
];

export function assessAddressDormancy(input: DormancyAssessmentInput): DormancyResult {
  const config: DormancyConfig = { ...DEFAULT_DORMANCY_CONFIG, ...(input.config ?? {}) };
  const windowsDays = [...config.windowsDays].sort((a, b) => a - b);
  const eventMs = input.eventTs.getTime();
  // Fail CLOSED: only an explicit true counts as complete (a caller passing
  // undefined through a loose cast still degrades to incomplete-history).
  const complete = input.meaningfulEventsComplete === true;

  // No lookahead: strictly-pre-event events only; the drop is receipted.
  const pre = input.meaningfulEvents.filter((e) => e.ts.getTime() < eventMs);
  const futureEventsIgnored = input.meaningfulEvents.length - pre.length;
  const preSorted = [...pre].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const oldestPre = preSorted[0] ?? null;
  const newestPre = preSorted[preSorted.length - 1] ?? null;

  // Defensive coverage: an observed event BEFORE the claimed coverage start
  // proves coverage actually began earlier — take the min, never fabricate.
  let effCovMs: number | null = input.coverageStart ? input.coverageStart.getTime() : null;
  if (oldestPre) effCovMs = effCovMs === null ? oldestPre.ts.getTime() : Math.min(effCovMs, oldestPre.ts.getTime());
  const fundingMs = input.firstInboundFundingTs ? input.firstInboundFundingTs.getTime() : null;
  if (fundingMs !== null) effCovMs = effCovMs === null ? fundingMs : Math.min(effCovMs, fundingMs);

  // Freshness: POSITIVE evidence only — earliest observation is an inbound
  // funding within freshMaxAgeHours before the event, and that funding is
  // (within slack) the very start of local history.
  const freshMaxAgeMs = config.freshMaxAgeHours * 3600_000;
  const fresh =
    fundingMs !== null &&
    effCovMs !== null &&
    fundingMs < eventMs &&
    eventMs - fundingMs <= freshMaxAgeMs &&
    fundingMs - effCovMs <= config.freshFundingCoverageSlackSec * 1000 &&
    // no meaningful history older than the fresh horizon
    (oldestPre === null || eventMs - oldestPre.ts.getTime() <= freshMaxAgeMs);

  const windows: DormancyWindowObservation[] = windowsDays.map((d) => {
    const windowStartMs = eventMs - d * 86_400_000;
    const inWindow = preSorted.filter((e) => e.ts.getTime() >= windowStartMs).length;
    const coverageComplete = complete && effCovMs !== null && effCovMs <= windowStartMs;
    let cls: DormancyClass;
    const reasons: string[] = [];
    if (inWindow > 0) {
      cls = 'active';
      reasons.push('meaningful_events_in_window');
    } else if (effCovMs === null) {
      cls = 'unknown';
      reasons.push('no_coverage_knowledge');
    } else if (effCovMs >= eventMs) {
      cls = 'unknown';
      reasons.push('no_pre_event_coverage');
    } else if (coverageComplete) {
      cls = 'covered_dormant';
      reasons.push('window_fully_covered_zero_meaningful_events');
    } else {
      cls = 'apparently_dormant_incomplete_history';
      reasons.push(
        !complete && effCovMs <= windowStartMs
          ? 'meaningful_event_list_incomplete'
          : 'coverage_begins_inside_window'
      );
    }
    return {
      windowDays: d,
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(eventMs).toISOString(),
      meaningfulEventCount: inWindow,
      coverageComplete,
      class: cls,
      reasonCodes: reasons
    };
  });

  // Overall: fresh (positive evidence) > shortest-window class; covered
  // dormancy is reported as the largest CONTIGUOUS covered-dormant window.
  let maxCoveredDormantDays: number | null = null;
  for (const w of windows) {
    if (w.class === 'covered_dormant') maxCoveredDormantDays = w.windowDays;
    else break;
  }
  let overallClass: DormancyClass;
  if (fresh) overallClass = 'fresh';
  else if (windows.length === 0) overallClass = 'unknown';
  else overallClass = windows[0].class;

  const caveats = [...BASE_CAVEATS];
  if (fresh) {
    caveats.push(
      `fresh = earliest LOCAL observation is an inbound funding within ${config.freshMaxAgeHours}h of the event — earlier unobserved history cannot be excluded by local data`
    );
  }
  if (!complete) {
    caveats.push('meaningful-event list flagged incomplete by the caller — no covered-dormant claim is made');
  }

  return {
    engineVersion: DORMANCY_ENGINE_VERSION,
    eventTs: new Date(eventMs).toISOString(),
    overallClass,
    maxCoveredDormantDays: overallClass === 'fresh' ? null : maxCoveredDormantDays,
    windows,
    receipts: {
      coverageStart: input.coverageStart ? input.coverageStart.toISOString() : null,
      effectiveCoverageStart: effCovMs === null ? null : new Date(effCovMs).toISOString(),
      firstInboundFundingTs: fundingMs === null ? null : new Date(fundingMs).toISOString(),
      preEventMeaningfulCount: preSorted.length,
      futureEventsIgnored,
      oldestPreEventTs: oldestPre ? oldestPre.ts.toISOString() : null,
      newestPreEventTs: newestPre ? newestPre.ts.toISOString() : null,
      meaningfulEventsComplete: complete,
      freshMaxAgeHours: config.freshMaxAgeHours,
      windowsDays
    },
    caveats
  };
}
