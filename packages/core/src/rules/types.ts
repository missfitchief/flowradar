// FlowRadar — rules/types.ts: re-exports of the canonical Rule contract.
//
// Per Task 13 binding decision 1: this file re-exports/aliases the Rule
// contract pieces from ../types — NO duplicate type definitions. The single
// source of truth for Rule/RuleResult/RuleExtras/TokenWindowAggregate stays
// packages/core/src/types.ts.

export type { Rule, RuleResult, RuleExtras, FundingEvent, RotationCandidate, SignalSeverity } from '../types';
export type { TokenWindowAggregate } from '../types';
export type { Settings } from '../settings';
