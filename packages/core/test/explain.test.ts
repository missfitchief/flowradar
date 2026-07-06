// FlowRadar — buildSignalExplanation tests (Task 43 binding decision 1, TDD).
//
// Normative source: .superpowers/sdd/ui-backtest-wave35.md Phase D (PART 1) —
// the two example paragraphs there are the tone/content bar this test file
// locks in verbatim (NOVA accumulation example, ALPHA->BETA rotation
// example), plus the task-43-brief.md snapshot-test requirement.

import { describe, expect, it } from 'vitest';
import { buildSignalExplanation } from '../src/feed/explain';
import type { ExplainInput } from '../src/feed/explain';
import { DEFAULT_SETTINGS } from '../src/settings';

// ---------------------------------------------------------------------------
// NOVA-shaped fixture — accumulation (rule A), matches the capture doc's
// example numbers verbatim: "36 tracked smart wallets bought $NOVA, but
// entity clustering estimates 19 unique entities. Net smart flow is +$75k,
// sell pressure is low, and market cap expanded only 1.4x from average smart
// entry. This looks like accumulation, not late chase."
// ---------------------------------------------------------------------------

function novaInput(overrides: Partial<ExplainInput> = {}): ExplainInput {
  const base: ExplainInput = {
    rule: 'A',
    severity: 'HIGH',
    symbol: 'NOVA',
    metrics: {
      rawWalletCount: 36,
      uniqueEntityCount: 19,
      largestClusterSize: 12,
      netFlowUsd: 75_000,
      soldPct: 12,
      mcapMultiplier: 1.4,
      liquidityUsd: 40_000
    },
    settings: DEFAULT_SETTINGS
  };
  return { ...base, ...overrides };
}

describe('buildSignalExplanation — NOVA accumulation (rule A)', () => {
  it('whyFired states the tracked-wallets-vs-unique-entities sentence with real numbers', () => {
    const result = buildSignalExplanation(novaInput());
    const joined = result.whyFired.join(' ');
    expect(joined).toContain('36 tracked smart wallets bought $NOVA');
    expect(joined).toContain('entity clustering estimates 19 unique entities');
  });

  it('whyFired states net flow, sell pressure, and mcap multiplier with real numbers', () => {
    const result = buildSignalExplanation(novaInput());
    const joined = result.whyFired.join(' ');
    expect(joined).toContain('+$75k');
    expect(joined.toLowerCase()).toContain('sell pressure');
    expect(joined).toContain('1.4');
  });

  it('conclusion reads as accumulation, not late chase (mcapMultiplier < 1.5x)', () => {
    const result = buildSignalExplanation(novaInput());
    expect(result.conclusion.toLowerCase()).toContain('looks like accumulation, not late chase');
  });

  it('produces a headline mentioning the symbol', () => {
    const result = buildSignalExplanation(novaInput());
    expect(result.headline).toContain('NOVA');
  });

  it('wouldInvalidate lines are derived from rule A settings thresholds', () => {
    const result = buildSignalExplanation(novaInput());
    const joined = result.wouldInvalidate.join(' ');
    expect(joined).toContain(`${DEFAULT_SETTINGS.rules.A.maxSoldPct}%`);
    expect(joined.toLowerCase()).toContain('sell pressure');
    expect(joined.toLowerCase()).toContain('market cap');
    expect(joined.toLowerCase()).toContain('net smart flow');
    expect(joined.toLowerCase()).toContain('negative');
  });

  it('wouldInvalidate lines change when a setting changes (sell-pressure threshold)', () => {
    const baseline = buildSignalExplanation(novaInput());
    const customSettings = {
      ...DEFAULT_SETTINGS,
      rules: { ...DEFAULT_SETTINGS.rules, A: { ...DEFAULT_SETTINGS.rules.A, maxSoldPct: 45 } }
    };
    const changed = buildSignalExplanation(novaInput({ settings: customSettings }));
    expect(baseline.wouldInvalidate.join(' ')).not.toBe(changed.wouldInvalidate.join(' '));
    expect(changed.wouldInvalidate.join(' ')).toContain('45%');
  });

  it('whatChanged is null when no previous snapshot is given', () => {
    const result = buildSignalExplanation(novaInput());
    expect(result.whatChanged).toBeNull();
  });

  it('whatChanged reports deltas when a previous snapshot is given', () => {
    const result = buildSignalExplanation(
      novaInput({
        previous: { smartWalletCount: 30, netFlowUsd: 57_000, mcapMultiplier: 1.3 }
      })
    );
    expect(result.whatChanged).not.toBeNull();
    expect(result.whatChanged as string).toContain('+6');
    expect(result.whatChanged as string).toContain('$18');
  });

  it('uses only probabilistic wording, never imperatives or hype (no-hype lint)', () => {
    const result = buildSignalExplanation(novaInput());
    const all = [result.headline, ...result.whyFired, ...result.wouldInvalidate, result.conclusion, result.whatChanged ?? '']
      .join(' ')
      .toLowerCase();
    for (const banned of ['moon', 'pump it', 'guaranteed', 'buy now', 'sell now', 'buy $', 'sell $']) {
      expect(all).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Accumulation-vs-chase conclusion boundary (mcapMultiplier bands)
// ---------------------------------------------------------------------------

describe('buildSignalExplanation — conclusion bands by mcapMultiplier (rules A/B/C/D)', () => {
  it('reads expansion-already-underway / late-entry risk when mcapMultiplier > 2x', () => {
    const result = buildSignalExplanation(
      novaInput({ metrics: { ...novaInput().metrics, mcapMultiplier: 2.6 } })
    );
    expect(result.conclusion.toLowerCase()).toContain('expansion already underway');
    expect(result.conclusion.toLowerCase()).toContain('late-entry risk');
  });

  it('is a mid-band, non-alarmist read between 1.5x and 2x', () => {
    const result = buildSignalExplanation(
      novaInput({ metrics: { ...novaInput().metrics, mcapMultiplier: 1.8 } })
    );
    expect(result.conclusion.toLowerCase()).not.toContain('looks like accumulation, not late chase');
    expect(result.conclusion.toLowerCase()).not.toContain('expansion already underway');
  });

  it('applies the same band logic to rule B (accumulation family)', () => {
    const result = buildSignalExplanation(
      novaInput({ rule: 'B', metrics: { ...novaInput().metrics, mcapMultiplier: 1.1 } })
    );
    expect(result.conclusion.toLowerCase()).toContain('looks like accumulation, not late chase');
  });
});

// ---------------------------------------------------------------------------
// Exit-warning (rule G) conclusion + invalidation
// ---------------------------------------------------------------------------

function dumpInput(overrides: Partial<ExplainInput> = {}): ExplainInput {
  const base: ExplainInput = {
    rule: 'G',
    severity: 'CRITICAL',
    symbol: 'DUMP',
    metrics: {
      rawWalletCount: 22,
      uniqueEntityCount: 15,
      largestClusterSize: 8,
      netFlowUsd: -40_000,
      soldPct: 68,
      mcapMultiplier: 0.3,
      liquidityUsd: 5_000
    },
    settings: DEFAULT_SETTINGS
  };
  return { ...base, ...overrides };
}

describe('buildSignalExplanation — DUMP exit warning (rule G)', () => {
  it('conclusion reads as an exit-warning, not an unqualified accumulation read', () => {
    const result = buildSignalExplanation(dumpInput());
    const lower = result.conclusion.toLowerCase();
    expect(lower).toMatch(/exit|distribution|selling/);
    // "accumulation" may appear only as part of an explicit negation ("not
    // fresh accumulation") — never as an unqualified positive claim.
    expect(lower).not.toMatch(/(?<!not fresh )accumulation/);
  });

  it('wouldInvalidate is the inverse of the exit-warning triggers', () => {
    const result = buildSignalExplanation(dumpInput());
    const joined = result.wouldInvalidate.join(' ').toLowerCase();
    expect(joined).toMatch(/exit|selling|liquidity|net flow/);
  });

  it('is probabilistic, no imperatives', () => {
    const result = buildSignalExplanation(dumpInput());
    const all = [result.headline, ...result.whyFired, result.conclusion].join(' ').toLowerCase();
    expect(all).not.toContain('sell now');
    expect(all).not.toContain('get out');
  });
});

// ---------------------------------------------------------------------------
// Rotation (rule F) — ALPHA -> BETA example, matches the capture doc's
// example numbers: "Wallet group realized profit on $ALPHA, bridged funds
// through Wormhole, and a linked wallet bought $BETA 65 minutes later. Amount
// match: 80%. Confidence: probable."
// ---------------------------------------------------------------------------

function rotationInput(overrides: Partial<ExplainInput> = {}): ExplainInput {
  const base: ExplainInput = {
    rule: 'F',
    severity: 'HIGH',
    symbol: 'BETA',
    metrics: {
      rawWalletCount: 5,
      uniqueEntityCount: 4,
      largestClusterSize: 2,
      netFlowUsd: 4_800,
      soldPct: 10,
      mcapMultiplier: 1.2,
      liquidityUsd: 20_000
    },
    rotation: {
      sourceSymbol: 'ALPHA',
      destSymbol: 'BETA',
      bridged: true,
      bridgeProtocol: 'Wormhole',
      timeGapMin: 65,
      valueMatchPct: 80,
      valueMatchFloorPct: 70,
      confidence: 78
    },
    settings: DEFAULT_SETTINGS
  };
  return { ...base, ...overrides };
}

describe('buildSignalExplanation — ALPHA -> BETA rotation (rule F)', () => {
  it('whyFired mirrors the capture example verbatim shape', () => {
    const result = buildSignalExplanation(rotationInput());
    const joined = result.whyFired.join(' ');
    expect(joined).toContain('Wallet group realized profit on $ALPHA');
    expect(joined).toContain('bridged funds through Wormhole');
    expect(joined).toContain('$BETA');
    expect(joined).toContain('65 minutes later');
    expect(joined).toContain('Amount match: 80%');
    expect(joined.toLowerCase()).toContain('confidence: probable');
  });

  it('confidence band derives from the numeric confidence score (61-80 = probable)', () => {
    const strong = buildSignalExplanation(
      rotationInput({ rotation: { ...rotationInput().rotation!, confidence: 90 } })
    );
    expect(strong.whyFired.join(' ').toLowerCase()).toContain('confidence: strong');

    const weak = buildSignalExplanation(
      rotationInput({ rotation: { ...rotationInput().rotation!, confidence: 20 } })
    );
    expect(weak.whyFired.join(' ').toLowerCase()).toContain('confidence: weak');
  });

  it('omits the bridge clause when not bridged', () => {
    const result = buildSignalExplanation(
      rotationInput({ rotation: { ...rotationInput().rotation!, bridged: false, bridgeProtocol: undefined } })
    );
    const joined = result.whyFired.join(' ').toLowerCase();
    expect(joined).not.toContain('bridged');
  });

  it('conclusion reads as a rotation read, not accumulation/exit', () => {
    const result = buildSignalExplanation(rotationInput());
    expect(result.conclusion.toLowerCase()).toMatch(/rotat/);
  });

  it('headline references both source and destination symbols', () => {
    const result = buildSignalExplanation(rotationInput());
    expect(result.headline).toContain('ALPHA');
    expect(result.headline).toContain('BETA');
  });

  it('is probabilistic (no hype, no imperatives)', () => {
    const result = buildSignalExplanation(rotationInput());
    const all = [result.headline, ...result.whyFired, result.conclusion].join(' ').toLowerCase();
    for (const banned of ['moon', 'pump it', 'guaranteed', 'buy now']) {
      expect(all).not.toContain(banned);
    }
  });

  // -------------------------------------------------------------------------
  // Real match-% vs settings-floor fallback (Task 43 review fix: rotation
  // match-% must be the REAL measured receivedValueUsd/transferredValueUsd
  // figure when available, e.g. ~97% for the ALPHA->BETA scenario's 0.97
  // ratio — never silently substitute the settings floor as if it were the
  // measured value).
  // -------------------------------------------------------------------------

  it('renders the REAL measured value-match% when valueMatchPct is present (e.g. 97%)', () => {
    const result = buildSignalExplanation(
      rotationInput({ rotation: { ...rotationInput().rotation!, valueMatchPct: 97 } })
    );
    const joined = result.whyFired.join(' ');
    expect(joined).toContain('Amount match: 97%');
    expect(joined).not.toContain('exact figure unavailable');
  });

  it('falls back to "≥{floor}% (exact figure unavailable)" wording when valueMatchPct is null (legacy row)', () => {
    const result = buildSignalExplanation(
      rotationInput({ rotation: { ...rotationInput().rotation!, valueMatchPct: null, valueMatchFloorPct: 70 } })
    );
    const joined = result.whyFired.join(' ');
    expect(joined).toContain('Amount match: ≥70%');
    expect(joined).toContain('exact figure unavailable');
    expect(joined).not.toMatch(/Amount match: \d+%\./); // must not look like an exact figure
  });
});

// ---------------------------------------------------------------------------
// General probabilistic-wording lint across every fixture (cheap guard test)
// ---------------------------------------------------------------------------

describe('buildSignalExplanation — no-hype lint (cheap guard)', () => {
  const fixtures: ExplainInput[] = [novaInput(), dumpInput(), rotationInput(), novaInput({ rule: 'B' }), novaInput({ rule: 'C' }), novaInput({ rule: 'D' })];

  it.each(fixtures.map((f) => [f.rule, f] as const))('rule %s output contains no banned hype terms', (_rule, input) => {
    const result = buildSignalExplanation(input);
    const all = [result.headline, ...result.whyFired, ...result.wouldInvalidate, result.conclusion, result.whatChanged ?? '']
      .join(' ')
      .toLowerCase();
    for (const banned of ['moon', 'pump it', 'guaranteed', 'buy now']) {
      expect(all).not.toContain(banned);
    }
  });
});
