// FlowRadar — rules/index.ts: evaluateAllRules + firedRules.
//
// Normative source: Task 14 binding decision 6.
//
// evaluateAllRules runs all 7 signal rules (A-G) against the two window
// aggregates a token snapshot needs:
//   - agg30  (30-minute window)  -> rules A, C, D, E
//   - agg24h (24-hour/1440min window) -> rules B, F, G
// This split mirrors each rule's normative context (see ruleA.ts..ruleG.ts
// header comments): A/C/D/E are "is something suspicious happening right
// now" checks; B/F/G are "how has this token behaved over the last day"
// checks. Rules E and F additionally consume RuleExtras (fundingEvents /
// rotationCandidates respectively); when extras or its relevant field is
// omitted, each defaults to an empty array inside the rule itself (see
// ruleE.ts/ruleF.ts) — evaluateAllRules does not need its own defaulting
// logic, it just passes `extra` through unchanged.
//
// Results are returned in rule order A..B..C..D..E..F..G regardless of
// firing state, so callers can always index results[i].rule to find a
// specific rule's outcome, and can render a full A-G scorecard (fired or
// not) without filtering first.

import type { RuleExtras, RuleResult, TokenWindowAggregate } from '../types';
import type { Settings } from '../settings';
import { ruleA } from './ruleA';
import { ruleB } from './ruleB';
import { ruleC } from './ruleC';
import { ruleD } from './ruleD';
import { ruleE } from './ruleE';
import { ruleF } from './ruleF';
import { ruleG } from './ruleG';

export function evaluateAllRules(
  agg30: TokenWindowAggregate,
  agg24h: TokenWindowAggregate,
  settings: Settings,
  extras?: RuleExtras
): RuleResult[] {
  return [
    ruleA(agg30, settings, extras),
    ruleB(agg24h, settings, extras),
    ruleC(agg30, settings, extras),
    ruleD(agg30, settings, extras),
    ruleE(agg30, settings, extras),
    ruleF(agg24h, settings, extras),
    ruleG(agg24h, settings, extras)
  ];
}

/** Filters an evaluateAllRules() result list down to just the rules that fired. */
export function firedRules(results: RuleResult[]): RuleResult[] {
  return results.filter((r) => r.fired);
}
