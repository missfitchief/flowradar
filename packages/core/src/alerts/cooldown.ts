// FlowRadar — alert cooldown logic (Task 16 binding decision 2).
//
// Normative source: Spec §9 "Cooldown: default 30 min per (token, rule),
// DB-enforced; severity escalation (HIGH->CRITICAL) bypasses once." Task 16
// task brief: "shouldSendAlert(lastSentAt: Date|null, severityPrev,
// severityNow, settings): boolean (30-min cooldown; HIGH->CRITICAL
// escalation bypasses once)." and binding decision 2's exact input/behavior
// spec (object-shaped input, not positional args — see below).
//
// packages/core is PURE — no I/O, no clock reads (`now` is passed in by the
// caller, same determinism contract as templates.ts).

import type { SignalSeverity } from '../types';

export interface ShouldSendAlertInput {
  /** sentAt of the most recent Alert row for this (tokenId, rule), or null if none exists yet. */
  lastSentAt: Date | null;
  /** severity of the Signal that produced that most recent Alert row, or null if none exists yet. */
  lastSeverity: SignalSeverity | null;
  /** severity of the Signal being evaluated right now. */
  severityNow: SignalSeverity;
  now: Date;
  /** settings.alerts.cooldownMin (default 30). */
  cooldownMin: number;
}

/**
 * True when an alert should be sent for this (tokenId, rule) right now.
 *
 * Rules (Spec §9):
 *   1. No prior alert ever sent for this (tokenId, rule) -> always send.
 *   2. Otherwise send when the prior alert's age (now - lastSentAt) is
 *      >= cooldownMin minutes (boundary is inclusive — exactly at the
 *      cooldown edge counts as elapsed, not still-cooling).
 *   3. Escalation bypass: even INSIDE the cooldown window, send once more
 *      when severity has escalated to CRITICAL from something that was NOT
 *      already CRITICAL (severityNow === 'CRITICAL' && lastSeverity !==
 *      'CRITICAL'). This fires for WATCH->CRITICAL and HIGH->CRITICAL alike
 *      (both are "escalated to CRITICAL from a lower severity"); the brief's
 *      "HIGH->CRITICAL" phrasing is the headline case, not an exclusive
 *      allowlist — the underlying Spec intent ("severity escalation ...
 *      bypasses once") is escalation TO the top severity band, regardless of
 *      which lower band it escalated from. CRITICAL->CRITICAL (no
 *      escalation, already at the ceiling) does NOT bypass — that's rule 2's
 *      ordinary cooldown path, unchanged.
 */
export function shouldSendAlert(input: ShouldSendAlertInput): boolean {
  const { lastSentAt, lastSeverity, severityNow, now, cooldownMin } = input;

  if (lastSentAt === null) {
    return true;
  }

  const ageMs = now.getTime() - lastSentAt.getTime();
  const cooldownMs = cooldownMin * 60 * 1000;
  if (ageMs >= cooldownMs) {
    return true;
  }

  // Still inside the cooldown window — only an escalation TO CRITICAL from a
  // non-CRITICAL prior severity bypasses it, and only once (the very next
  // alert after this one, at the new CRITICAL severity, would have
  // lastSeverity === 'CRITICAL' and therefore NOT bypass again).
  if (severityNow === 'CRITICAL' && lastSeverity !== 'CRITICAL') {
    return true;
  }

  return false;
}
