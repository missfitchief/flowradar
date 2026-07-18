// FlowRadar — repeat/dormant-runner candidate rule tests (Tasks 11-12, pure).

import { describe, expect, it } from 'vitest';
import {
  classifyRepeatRunnerCandidate,
  classifyDormantRunnerPattern,
  REPEAT_CANDIDATE_ENGINE_VERSION
} from '../../src/runnermining/repeatCandidates';
import type { RepeatCandidateInput, DormantRunnerEvent } from '../../src/runnermining/repeatCandidates';

function input(over: Partial<RepeatCandidateInput> = {}): RepeatCandidateInput {
  return {
    distinctRunnersEntered: 0,
    runnersEntered: 0,
    controlsEntered: 0,
    otherTokensEntered: 0,
    oneWinnerDependence: null,
    negativeEvidence: [],
    qualityFlags: [],
    viewTruncated: false,
    exclusionScanComplete: true,
    universeComplete: true,
    ...over
  };
}

describe('classifyRepeatRunnerCandidate (Task 11 pure)', () => {
  it('zero or single runner exposure is insufficient_evidence — one runner is never a pattern', () => {
    expect(classifyRepeatRunnerCandidate(input()).status).toBe('insufficient_evidence');
    const single = classifyRepeatRunnerCandidate(input({ distinctRunnersEntered: 1, runnersEntered: 3 }));
    expect(single.status).toBe('insufficient_evidence');
    expect(single.reasonCodes).toContain('single_runner_exposure_never_a_pattern');
    expect(single.score).toBeNull();
  });

  it('repeated distinct runners = candidate with a capped observation-only score', () => {
    const d = classifyRepeatRunnerCandidate(
      input({ distinctRunnersEntered: 3, runnersEntered: 4, otherTokensEntered: 5 })
    );
    expect(d.status).toBe('candidate');
    expect(d.score).not.toBeNull();
    expect(d.score as number).toBeLessThanOrEqual(85);
    expect(d.caveats.join(' ')).toContain('grants no votes');
    expect(d.engineVersion).toBe(REPEAT_CANDIDATE_ENGINE_VERSION);
  });

  it('negative evidence EXCLUDES — never merely lowers the score', () => {
    const d = classifyRepeatRunnerCandidate(
      input({ distinctRunnersEntered: 5, runnersEntered: 8, negativeEvidence: ['bot_or_arbitrage'] })
    );
    expect(d.status).toBe('excluded_negative_evidence');
    expect(d.score).toBeNull();
    expect(d.reasonCodes).toContain('negative_evidence:bot_or_arbitrage');
  });

  it('one-winner dependence is exposed and penalized', () => {
    const balanced = classifyRepeatRunnerCandidate(
      input({ distinctRunnersEntered: 2, runnersEntered: 4, oneWinnerDependence: 0.5 })
    );
    const dependent = classifyRepeatRunnerCandidate(
      input({ distinctRunnersEntered: 2, runnersEntered: 4, oneWinnerDependence: 0.9 })
    );
    expect(dependent.score as number).toBeLessThan(balanced.score as number);
    expect(dependent.caveats.join(' ')).toContain('single winner');
    expect(dependent.scoreBasis.join(' ')).toContain('one_winner_dependence');
  });

  it('a truncated view caps the score and is caveated', () => {
    const d = classifyRepeatRunnerCandidate(
      input({ distinctRunnersEntered: 4, runnersEntered: 6, viewTruncated: true })
    );
    expect(d.score as number).toBeLessThanOrEqual(50);
    expect(d.caveats.join(' ')).toContain('undercounted');
  });

  it('an INCOMPLETE exclusion scan can never mint a candidate', () => {
    const d = classifyRepeatRunnerCandidate(
      input({ distinctRunnersEntered: 5, runnersEntered: 8, exclusionScanComplete: false })
    );
    expect(d.status).toBe('insufficient_evidence');
    expect(d.reasonCodes).toContain('exclusion_scan_incomplete');
    expect(d.score).toBeNull();
  });

  it('a truncated runner/control universe can never mint a candidate', () => {
    const d = classifyRepeatRunnerCandidate(
      input({ distinctRunnersEntered: 5, runnersEntered: 8, universeComplete: false })
    );
    expect(d.status).toBe('insufficient_evidence');
    expect(d.reasonCodes).toContain('universe_read_incomplete');
  });

  it('behavior-quality flags contribute a bounded, documented score bonus', () => {
    const plain = classifyRepeatRunnerCandidate(input({ distinctRunnersEntered: 2, runnersEntered: 2 }));
    const quality = classifyRepeatRunnerCandidate(
      input({ distinctRunnersEntered: 2, runnersEntered: 2, qualityFlags: ['independent_sharp_trader'] })
    );
    expect(quality.score as number).toBeGreaterThan(plain.score as number);
    expect((quality.score as number) - (plain.score as number)).toBeLessThanOrEqual(6);
    expect(quality.scoreBasis.join(' ')).toContain('quality_bonus');
  });
});

const ev = (entityClass: string, runnerMint: string, addressClass = 'covered_dormant'): DormantRunnerEvent => ({
  addressClass,
  entityClass,
  runnerMint
});

describe('classifyDormantRunnerPattern (Task 12 pure)', () => {
  it('no qualifying events = insufficient_evidence', () => {
    const d = classifyDormantRunnerPattern([ev('active_entity', 'M1', 'active')]);
    expect(d.pattern).toBe('insufficient_evidence');
  });

  it('ONE qualifying event = one_off — never a pattern', () => {
    const d = classifyDormantRunnerPattern([ev('independent_dormant_entity', 'M1')]);
    expect(d.pattern).toBe('one_off');
    expect(d.reasonCodes).toContain('single_qualifying_event_never_a_pattern');
  });

  it('two dormant events on the SAME token are NOT a repeat (distinct tokens required)', () => {
    const d = classifyDormantRunnerPattern([
      ev('independent_dormant_entity', 'M1'),
      ev('independent_dormant_entity', 'M1')
    ]);
    expect(d.pattern).not.toBe('repeated_independent_dormant');
  });

  it('repeated independent dormancy across >=2 distinct runners = repeated_independent_dormant', () => {
    const d = classifyDormantRunnerPattern([
      ev('independent_dormant_entity', 'M1'),
      ev('independent_dormant_entity', 'M2')
    ]);
    expect(d.pattern).toBe('repeated_independent_dormant');
    expect(d.confidence).toBeLessThanOrEqual(85);
    expect(d.distinctRunnerTokens).toBe(2);
  });

  it('address-only dormancy repeats at LOWER confidence with the caveat', () => {
    const strong = classifyDormantRunnerPattern([
      ev('independent_dormant_entity', 'M1'),
      ev('independent_dormant_entity', 'M2')
    ]);
    const weak = classifyDormantRunnerPattern([
      ev('insufficient_evidence', 'M1', 'covered_dormant'),
      ev('insufficient_evidence', 'M2', 'covered_dormant')
    ]);
    expect(weak.pattern).toBe('repeated_independent_dormant');
    expect(weak.confidence).toBeLessThan(strong.confidence);
    expect(weak.caveats.join(' ')).toContain('entity independence not established');
  });

  it('repeated side-wallet activations / fresh fundings classify their own patterns', () => {
    const side = classifyDormantRunnerPattern([
      ev('probable_side_wallet_reactivation', 'M1', 'active'),
      ev('probable_side_wallet_reactivation', 'M2', 'active')
    ]);
    expect(side.pattern).toBe('side_wallet_activation_pattern');
    const fresh = classifyDormantRunnerPattern([
      ev('fresh_funded_by_active_entity', 'M1', 'fresh'),
      ev('fresh_funded_by_active_entity', 'M2', 'fresh')
    ]);
    expect(fresh.pattern).toBe('fresh_funding_pattern');
  });

  it('buckets are MUTUALLY EXCLUSIVE — the T8 entity class outranks address-only dormancy', () => {
    // covered_dormant addresses whose entity was REACTIVATED by a side wallet
    // are side-wallet events, never independent-dormancy events.
    const d = classifyDormantRunnerPattern([
      ev('probable_side_wallet_reactivation', 'M1', 'covered_dormant'),
      ev('probable_side_wallet_reactivation', 'M2', 'covered_dormant')
    ]);
    expect(d.pattern).toBe('side_wallet_activation_pattern');
    expect(d.dormantEntryEvents).toBe(0); // not double-counted
    expect(d.sideWalletActivationEvents).toBe(2);

    // A single covered_dormant + side-wallet-reactivation event is ONE event.
    const single = classifyDormantRunnerPattern([
      ev('probable_side_wallet_reactivation', 'M1', 'covered_dormant')
    ]);
    expect(single.pattern).toBe('one_off');

    // An entity-ACTIVE event never enters the dormant bucket.
    const active = classifyDormantRunnerPattern([
      ev('address_dormant_entity_active', 'M1', 'covered_dormant'),
      ev('address_dormant_entity_active', 'M2', 'covered_dormant')
    ]);
    expect(active.pattern).toBe('insufficient_evidence');
    expect(active.dormantEntryEvents).toBe(0);
  });

  it('every decision carries the observation-only caveat', () => {
    const d = classifyDormantRunnerPattern([]);
    expect(d.caveats.join(' ')).toContain('grants no votes');
    expect(d.pattern).toBe('insufficient_evidence');
  });
});
