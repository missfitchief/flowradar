// FlowRadar — calculateWalletLinkConfidence / confidenceBand (Task 22 binding
// decision 2).
//
// Normative source: spec §6's link-confidence weight table (exact deltas
// below, verbatim). Weights are applied ADDITIVELY over LinkEvidence's 14
// boolean fields, then the raw sum is clamped to [0, 100] — negative
// evidence (cexOrMixerInterruption, routerOnlyInteraction, weakAmountMatch,
// dustOnlyInteraction) can never push the score below 0, and a large
// positive combination can never exceed 100.
//
// packages/core is PURE: this module takes only a LinkEvidence value and
// returns a plain number/string — zero I/O, zero framework deps.

import type { LinkEvidence } from '../types';

const WEIGHTS: Record<keyof LinkEvidence, number> = {
  directTransfer: 35,
  repeatedDirectTransfers: 20,
  sameFundingSource: 25,
  sameGasFunder: 10,
  bridgeAmountTimeMatch: 30,
  amountSimilarityAbove90: 15,
  destBuysNewTokenWithin60m: 15,
  freshWalletActivated: 15,
  sameTokenRotation: 10,
  repeatedCrossLaunchPattern: 25,
  cexOrMixerInterruption: -30,
  routerOnlyInteraction: -20,
  weakAmountMatch: -15,
  dustOnlyInteraction: -25
};

/**
 * Sums WEIGHTS[field] for every LinkEvidence field that is `true`, then
 * clamps the raw total to [0, 100].
 */
export function calculateWalletLinkConfidence(evidence: LinkEvidence): number {
  let total = 0;
  for (const key of Object.keys(WEIGHTS) as (keyof LinkEvidence)[]) {
    if (evidence[key]) {
      total += WEIGHTS[key];
    }
  }
  return Math.max(0, Math.min(100, total));
}

export type ConfidenceBand = 'weak' | 'possible' | 'probable' | 'strong';

/**
 * Bands a 0-100 confidence score: <=30 weak, 31-60 possible, 61-80 probable,
 * >=81 strong.
 */
export function confidenceBand(score: number): ConfidenceBand {
  if (score <= 30) return 'weak';
  if (score <= 60) return 'possible';
  if (score <= 80) return 'probable';
  return 'strong';
}
