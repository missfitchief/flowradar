// FlowRadar — Historical Runner-Origin Wallet Mining: pure engine (Task 2).
// Design: docs/RUNNER_MINING_DESIGN.md.
//
// THE NO-LOOKAHEAD WALL is the module layout itself:
//   types.ts   — shared series/config shapes (no logic beyond validation)
//   entry.ts   — entry-time features; imports ./types ONLY, strictly-prior
//                truncation, unknown stays unknown
//   outcome.ts — evaluation-only labels over the full series
// entry.ts can never reference outcome types/functions — enforced by the
// runnerMiningLeakGuard static test, so the guarantee is architectural, not
// procedural. Shadow-only: no FlowScore/threshold/eligibility surface.

export * from './types';
export * from './entry';
export * from './outcome';
export * from './universeClassify';
