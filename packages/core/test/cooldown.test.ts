// FlowRadar — shouldSendAlert truth-table tests (Task 16 binding decision 2 /
// TDD requirement: "Cooldown truth table tests FAIL->PASS", "incl.
// exactly-at-boundary, WATCH->HIGH inside cooldown => false, HIGH->CRITICAL
// inside => true, CRITICAL->CRITICAL inside => false").

import { describe, expect, it } from 'vitest';
import { shouldSendAlert } from '../src/alerts/cooldown';
import type { ShouldSendAlertInput } from '../src/alerts/cooldown';

const NOW = new Date('2026-07-05T12:00:00.000Z');
const COOLDOWN_MIN = 30;

function minutesAgo(min: number): Date {
  return new Date(NOW.getTime() - min * 60 * 1000);
}

function baseInput(overrides: Partial<ShouldSendAlertInput> = {}): ShouldSendAlertInput {
  return {
    lastSentAt: minutesAgo(15), // inside cooldown by default
    lastSeverity: 'HIGH',
    severityNow: 'HIGH',
    now: NOW,
    cooldownMin: COOLDOWN_MIN,
    ...overrides,
  };
}

describe('shouldSendAlert', () => {
  it('no prior alert ever sent -> true (lastSentAt null)', () => {
    expect(shouldSendAlert(baseInput({ lastSentAt: null, lastSeverity: null }))).toBe(true);
  });

  it('prior alert older than cooldown -> true (age > cooldownMin)', () => {
    expect(shouldSendAlert(baseInput({ lastSentAt: minutesAgo(31) }))).toBe(true);
  });

  it('prior alert within cooldown, same severity -> false', () => {
    expect(shouldSendAlert(baseInput({ lastSentAt: minutesAgo(15), lastSeverity: 'HIGH', severityNow: 'HIGH' }))).toBe(false);
  });

  it('exactly-at-boundary (age === cooldownMin) -> true (inclusive boundary)', () => {
    expect(shouldSendAlert(baseInput({ lastSentAt: minutesAgo(30) }))).toBe(true);
  });

  it('just inside the boundary (age === cooldownMin - 1s) -> false', () => {
    const lastSentAt = new Date(NOW.getTime() - (COOLDOWN_MIN * 60 * 1000 - 1000));
    expect(shouldSendAlert(baseInput({ lastSentAt }))).toBe(false);
  });

  it('WATCH -> HIGH inside cooldown -> false (escalation bypass is CRITICAL-only)', () => {
    expect(
      shouldSendAlert(baseInput({ lastSentAt: minutesAgo(10), lastSeverity: 'WATCH', severityNow: 'HIGH' }))
    ).toBe(false);
  });

  it('HIGH -> CRITICAL inside cooldown -> true (escalation bypass)', () => {
    expect(
      shouldSendAlert(baseInput({ lastSentAt: minutesAgo(10), lastSeverity: 'HIGH', severityNow: 'CRITICAL' }))
    ).toBe(true);
  });

  it('WATCH -> CRITICAL inside cooldown -> true (escalation TO critical from any lower band bypasses)', () => {
    expect(
      shouldSendAlert(baseInput({ lastSentAt: minutesAgo(10), lastSeverity: 'WATCH', severityNow: 'CRITICAL' }))
    ).toBe(true);
  });

  it('CRITICAL -> CRITICAL inside cooldown -> false (already at ceiling, no escalation, ordinary cooldown applies)', () => {
    expect(
      shouldSendAlert(baseInput({ lastSentAt: minutesAgo(10), lastSeverity: 'CRITICAL', severityNow: 'CRITICAL' }))
    ).toBe(false);
  });

  it('CRITICAL -> HIGH inside cooldown -> false (de-escalation is not a bypass condition)', () => {
    expect(
      shouldSendAlert(baseInput({ lastSentAt: minutesAgo(10), lastSeverity: 'CRITICAL', severityNow: 'HIGH' }))
    ).toBe(false);
  });

  it('INFO -> WATCH inside cooldown -> false (no escalation bypass below CRITICAL)', () => {
    expect(
      shouldSendAlert(baseInput({ lastSentAt: minutesAgo(5), lastSeverity: 'INFO', severityNow: 'WATCH' }))
    ).toBe(false);
  });

  it('lastSeverity null (defensive — first-ever alert already handled by lastSentAt null, but a caller passing lastSentAt non-null with lastSeverity null should still get ordinary cooldown behavior), CRITICAL now -> true (treated as escalation since null !== CRITICAL)', () => {
    expect(
      shouldSendAlert(baseInput({ lastSentAt: minutesAgo(10), lastSeverity: null, severityNow: 'CRITICAL' }))
    ).toBe(true);
  });

  it('respects a custom cooldownMin (e.g. 5 minutes)', () => {
    expect(shouldSendAlert(baseInput({ lastSentAt: minutesAgo(4), cooldownMin: 5 }))).toBe(false);
    expect(shouldSendAlert(baseInput({ lastSentAt: minutesAgo(5), cooldownMin: 5 }))).toBe(true);
    expect(shouldSendAlert(baseInput({ lastSentAt: minutesAgo(6), cooldownMin: 5 }))).toBe(true);
  });
});
