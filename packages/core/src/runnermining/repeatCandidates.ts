// FlowRadar — repeat-runner + dormant-runner candidate rules (pure; dormancy
// plan Tasks 11-12).
//
// Honesty rules (binding):
//   - ENTITY-adjusted: probable/strong-linked wallets never count as
//     independent repeats — the caller merges them into one entity first.
//   - Small-N honesty: insufficient_evidence is the expected common case;
//     a pattern is NEVER claimed from one event.
//   - One-winner dependence is EXPOSED, never smoothed away.
//   - Negative evidence (bot/MM/service shapes, rug exposure) EXCLUDES a
//     candidate — it never merely lowers a score.
//   - OBSERVATION-ONLY: scores are ranking aids for research, capped, and
//     grant nothing (no votes, no eligibility, no promotion).

export const REPEAT_CANDIDATE_ENGINE_VERSION = 1;

export type RepeatCandidateStatus = 'candidate' | 'insufficient_evidence' | 'excluded_negative_evidence';

export interface RepeatCandidateInput {
  /** Distinct VERIFIED runner mints the entity entered (locally observed buys). */
  distinctRunnersEntered: number;
  /** Total runner-entry events (across members; can exceed distinct). */
  runnersEntered: number;
  /** Distinct matched-control mints entered. */
  controlsEntered: number;
  /** Distinct other (non-runner, non-control) mints entered. */
  otherTokensEntered: number;
  /** Share of runner-entry events on the single most-entered runner (0-1). */
  oneWinnerDependence: number | null;
  /** Negative evidence flags collected by the caller (receipts classes etc.). */
  negativeEvidence: string[];
  /** Behavior-quality flags (hold classifier / receipts). */
  qualityFlags: string[];
  /** True when the entity's local trade view was truncated anywhere. */
  viewTruncated: boolean;
  /**
   * True only when the NEGATIVE-EVIDENCE scan covered the complete bounded
   * view (no trade/transfer truncation). An incomplete exclusion scan can
   * never mint a candidate — older disqualifying evidence may be invisible.
   */
  exclusionScanComplete: boolean;
  /**
   * True only when the verified-runner/control universes were read
   * completely. A truncated universe makes every exposure count unreliable.
   */
  universeComplete: boolean;
}

export interface RepeatCandidateDecision {
  status: RepeatCandidateStatus;
  /** Observation-only ranking score (0-100, capped 85) — null unless candidate. */
  score: number | null;
  scoreBasis: string[];
  reasonCodes: string[];
  caveats: string[];
  engineVersion: number;
}

const NEGATIVE_EXCLUDERS = new Set([
  'bot_or_arbitrage',
  'market_maker_or_service',
  'launch_team_linked_destructive_exit',
  'high_rug_exposure'
]);

const BASE_CAVEATS = [
  'entity-adjusted over probabilistic links — member sets are possible/probable groupings, never identity claims',
  'exposure counts come from bounded local observation — absence is not proof of non-participation',
  'observation-only ranking: grants no votes, no eligibility, no promotion'
];

const capScore = (n: number) => Math.max(0, Math.min(85, Math.round(n)));

/** THE Task 11 rule (pure, versioned). */
export function classifyRepeatRunnerCandidate(input: RepeatCandidateInput): RepeatCandidateDecision {
  const reasons: string[] = [];
  const caveats = [...BASE_CAVEATS];
  const excluders = input.negativeEvidence.filter((e) => NEGATIVE_EXCLUDERS.has(e));

  if (excluders.length > 0) {
    return {
      status: 'excluded_negative_evidence',
      score: null,
      scoreBasis: [],
      reasonCodes: excluders.map((e) => `negative_evidence:${e}`),
      caveats,
      engineVersion: REPEAT_CANDIDATE_ENGINE_VERSION
    };
  }

  // A truncated runner/control universe makes exposure counts unreliable —
  // no conclusive candidate classification can be made.
  if (!input.universeComplete) {
    caveats.push('runner/control universe read was truncated — exposure counts are unreliable');
    return {
      status: 'insufficient_evidence',
      score: null,
      scoreBasis: [],
      reasonCodes: ['universe_read_incomplete'],
      caveats,
      engineVersion: REPEAT_CANDIDATE_ENGINE_VERSION
    };
  }

  // An INCOMPLETE exclusion scan can never mint a candidate: disqualifying
  // evidence may sit outside the scanned window.
  if (!input.exclusionScanComplete) {
    caveats.push('negative-evidence scan was truncated — a candidate cannot be minted from an incomplete exclusion view');
    return {
      status: 'insufficient_evidence',
      score: null,
      scoreBasis: [],
      reasonCodes: ['exclusion_scan_incomplete'],
      caveats,
      engineVersion: REPEAT_CANDIDATE_ENGINE_VERSION
    };
  }

  // Repetition requires >= 2 DISTINCT runners — one runner is never a pattern.
  if (input.distinctRunnersEntered < 2) {
    reasons.push(
      input.distinctRunnersEntered === 0 ? 'no_runner_exposure_observed' : 'single_runner_exposure_never_a_pattern'
    );
    if (input.viewTruncated) caveats.push('local view truncated — exposure may be undercounted');
    return {
      status: 'insufficient_evidence',
      score: null,
      scoreBasis: [],
      reasonCodes: reasons,
      caveats,
      engineVersion: REPEAT_CANDIDATE_ENGINE_VERSION
    };
  }

  reasons.push('repeated_distinct_runner_exposure');
  const basis: string[] = [`distinct_runners:${input.distinctRunnersEntered}`];

  // Base: distinct-runner repetition (log-ish, saturating).
  let score = 30 + Math.min(30, (input.distinctRunnersEntered - 1) * 10);

  // Selectivity: runners vs everything else entered (exposed, not hidden).
  const totalDistinct = input.distinctRunnersEntered + input.controlsEntered + input.otherTokensEntered;
  const selectivity = totalDistinct > 0 ? input.distinctRunnersEntered / totalDistinct : 0;
  score += Math.round(selectivity * 20);
  basis.push(`selectivity:${selectivity.toFixed(2)}`);

  // One-winner dependence penalizes (and is always exposed).
  if (input.oneWinnerDependence !== null && input.oneWinnerDependence > 0.5) {
    score -= Math.round((input.oneWinnerDependence - 0.5) * 40);
    basis.push(`one_winner_dependence:${input.oneWinnerDependence.toFixed(2)}`);
    caveats.push('runner exposure depends heavily on a single winner — repetition strength is limited');
  }

  // Behavior quality contributes a small, documented, bounded bonus
  // (+3 per positive receipts-engine flag, max +6) — quality participates in
  // ranking but can never dominate repetition/selectivity.
  if (input.qualityFlags.length > 0) {
    const qualityBonus = Math.min(6, input.qualityFlags.length * 3);
    score += qualityBonus;
    basis.push(...input.qualityFlags.map((q) => `quality:${q}`));
    basis.push(`quality_bonus:${qualityBonus}`);
  }

  if (input.viewTruncated) {
    score = Math.min(score, 50);
    caveats.push('local view truncated — exposure may be undercounted; score capped');
  }

  return {
    status: 'candidate',
    score: capScore(score),
    scoreBasis: basis,
    reasonCodes: reasons,
    caveats,
    engineVersion: REPEAT_CANDIDATE_ENGINE_VERSION
  };
}

// ---------------------------------------------------------------------------
// Task 12 — dormant-runner pattern
// ---------------------------------------------------------------------------

export type DormantRunnerPattern =
  | 'repeated_independent_dormant'
  | 'side_wallet_activation_pattern'
  | 'fresh_funding_pattern'
  | 'one_off'
  | 'insufficient_evidence';

export interface DormantRunnerEvent {
  /** Entity/address dormancy classes at a RUNNER-token entry (T7/T8). */
  addressClass: string;
  entityClass: string;
  /** Distinct runner mint of the entry. */
  runnerMint: string;
}

export interface DormantRunnerDecision {
  pattern: DormantRunnerPattern;
  dormantEntryEvents: number;
  sideWalletActivationEvents: number;
  freshFundingEvents: number;
  distinctRunnerTokens: number;
  confidence: number; // capped 85
  reasonCodes: string[];
  caveats: string[];
  engineVersion: number;
}

const T12_CAVEATS = [
  'dormancy classes are bounded local observations (unknown/incomplete are honest states)',
  'a pattern is never claimed from one event; distinct-token repetition is required',
  'observation-only: grants no votes, no eligibility, no promotion'
];

const capConf = (n: number) => Math.max(0, Math.min(85, Math.round(n)));

/**
 * THE Task 12 rule (pure, versioned). Events are runner-entry anchors joined
 * with their T7/T8 dormancy classes; a "repeat" needs >= 2 events on >= 2
 * DISTINCT runner tokens of the same shape.
 */
export function classifyDormantRunnerPattern(events: DormantRunnerEvent[]): DormantRunnerDecision {
  // MUTUALLY EXCLUSIVE buckets — the specific T8 entity class takes
  // precedence over address-only dormancy (a covered-dormant address whose
  // entity was reactivated by a side wallet is a SIDE-WALLET event, never an
  // independent-dormancy event; an entity-active event is neither).
  const sideActivation = events.filter((e) => e.entityClass === 'probable_side_wallet_reactivation');
  const freshFunding = events.filter((e) => e.entityClass === 'fresh_funded_by_active_entity');
  const dormant = events.filter(
    (e) =>
      e.entityClass === 'independent_dormant_entity' ||
      (e.addressClass === 'covered_dormant' && e.entityClass === 'insufficient_evidence')
  );
  const distinctTokens = (list: DormantRunnerEvent[]) => new Set(list.map((e) => e.runnerMint)).size;

  const result = (
    pattern: DormantRunnerPattern,
    confidence: number,
    reasons: string[],
    extraCaveats: string[] = []
  ): DormantRunnerDecision => ({
    pattern,
    dormantEntryEvents: dormant.length,
    sideWalletActivationEvents: sideActivation.length,
    freshFundingEvents: freshFunding.length,
    distinctRunnerTokens: distinctTokens(events),
    confidence: capConf(confidence),
    reasonCodes: reasons,
    caveats: [...T12_CAVEATS, ...extraCaveats],
    engineVersion: REPEAT_CANDIDATE_ENGINE_VERSION
  });

  // Strongest first; each requires >=2 events across >=2 distinct tokens.
  if (dormant.length >= 2 && distinctTokens(dormant) >= 2) {
    // Independent-entity evidence outranks address-only dormancy.
    const independent = dormant.filter((e) => e.entityClass === 'independent_dormant_entity');
    const conf = independent.length >= 2 ? 70 : 50;
    return result(
      'repeated_independent_dormant',
      conf,
      ['repeated_dormant_before_runner_entry'],
      independent.length < 2
        ? ['dormancy is address-level for some events — entity independence not established everywhere']
        : []
    );
  }
  if (sideActivation.length >= 2 && distinctTokens(sideActivation) >= 2) {
    return result('side_wallet_activation_pattern', 60, ['repeated_probable_side_wallet_reactivation']);
  }
  if (freshFunding.length >= 2 && distinctTokens(freshFunding) >= 2) {
    return result('fresh_funding_pattern', 55, ['repeated_fresh_funded_runner_entry']);
  }
  if (dormant.length + sideActivation.length + freshFunding.length === 1) {
    return result('one_off', 30, ['single_qualifying_event_never_a_pattern']);
  }
  return result('insufficient_evidence', 20, ['no_repeated_qualifying_shape']);
}
