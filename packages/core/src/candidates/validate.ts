// FlowRadar — evaluateCandidate: pure candidate-wallet validation verdict
// (Task 35, Wave 4.5, Spec §5b).
//
// This is the ONLY place a CandidateWallet's fate (promote/reject/insufficient)
// is decided. It never touches I/O — packages/db/src/candidateValidation.ts
// assembles the `evidence` shape from DB rows/provider calls and applies the
// verdict this function returns.
//
// ---------------------------------------------------------------------------
// THE HARD RULE (documented per Task 35 binding decision 1's evidence gate)
// ---------------------------------------------------------------------------
// A candidate's OWN claimed figures (claimedPnlUsd/claimedWinRate/
// claimedTradeCount/claimedRoi) are NEVER, by themselves, a sufficient basis
// to promote. They exist only for RANKING (a source's own leaderboard order)
// and for CROSS-CHECKING against independently computed evidence (the
// confidence blend below). If no computed PnL evidence exists at all — no
// provider wallet-PnL capability, AND no local WalletTokenTrade history to
// FIFO-compute from — the verdict is always 'insufficient', regardless of how
// good the claims look. This is what makes the poisoned "over-claimed"
// scam entries (router/CEX, possible_bot) fail even though their OWN claimed
// numbers clear every threshold: those two auto-reject on registry/label
// grounds before the threshold gate is even reached, and any hypothetical
// candidate with strong claims but zero real evidence simply never promotes,
// full stop.
//
// ---------------------------------------------------------------------------
// Evaluation order
// ---------------------------------------------------------------------------
//   1. AUTO-REJECT — registryCategory in {CEX, ROUTER, POOL, BRIDGE, MIXER}.
//      (DEPLOYER/TOKEN_CONTRACT are NOT excluded — a deployer wallet can
//      legitimately also be a profitable trader; only the 5 "this is a
//      service, not a person" categories auto-reject.)
//   2. AUTO-REJECT — labels include 'possible_bot' or 'mev', OR include
//      'sniper' with no offsetting 'human_like'/'smart_money' label (a sniper
//      bot is bad; a labeled human/smart-money wallet that also triggers the
//      sniper heuristic sometimes is not auto-rejected).
//   3. EVIDENCE GATE — no evidence.computedPnl at all => 'insufficient'.
//   4. THRESHOLD GATE — evidence.computedPnl compared against
//      settings.profitableWallet (pnl30d/minTrades/minWinRate/minRealized/
//      minAvgTradeSizeUsd, all comparisons >=, exactly isProfitableWallet's
//      contract but evaluated field-by-field here so the rejection reason
//      can name every threshold that missed, not just a single boolean).
//
// ---------------------------------------------------------------------------
// Confidence formula (0-100)
// ---------------------------------------------------------------------------
// confidence = evidenceConfidence * agreementMultiplier, clamped [0,100].
//   - evidenceConfidence: evidence.computedPnl.confidence (the FIFO/provider
//     evidence's own confidence, e.g. computeFifoPnl's 10-90 range) when
//     computed evidence exists; a neutral 60 baseline when it doesn't (the
//     registry/bot auto-reject paths, which have no computedPnl at all — the
//     rejection itself is near-certain on registry/label grounds alone, so
//     those paths use a fixed high confidence instead, see below).
//   - agreementMultiplier: compares each claimed figure against its computed
//     counterpart (only for figures the candidate actually claimed — a
//     missing claim contributes nothing, positive or negative). A claim
//     within 2x of computed (ratio in [0.5, 2] either direction) contributes
//     "agreement" (+1 to a running average clamped [0,1]); a wild over/under
//     claim (ratio outside that band) contributes "disagreement" (0). The
//     agreementMultiplier itself is 0.7 + 0.3 * agreementRatio, i.e. ranges
//     0.7 (all claims wildly wrong) to 1.0 (all claims agree, or no claims
//     supplied at all — agreementRatio defaults to 1 when there is nothing to
//     compare, since an absent claim cannot disagree).
//
// Auto-reject paths (registry/bot) report a fixed high confidence (85) since
// those are near-certain, deterministic disqualifications, not a soft
// threshold judgment call.

import type { Settings } from '../settings';

export type CandidateValidationVerdict = 'promote' | 'reject' | 'insufficient';

export interface CandidateClaims {
  claimedPnlUsd?: number;
  claimedWinRate?: number;
  claimedTradeCount?: number;
  claimedRoi?: number;
}

export interface ComputedPnlEvidence {
  pnl30d: number;
  realizedPnlUsd: number;
  winRate: number;
  tradeCount: number;
  avgTradeSizeUsd: number;
  /** 0-100 confidence of the computed/provider evidence itself (e.g. computeFifoPnl's confidence). */
  confidence: number;
}

export type RegistryCategory = 'CEX' | 'ROUTER' | 'POOL' | 'BRIDGE' | 'MIXER' | 'DEPLOYER' | 'TOKEN_CONTRACT';

export interface CandidateEvidence {
  computedPnl?: ComputedPnlEvidence;
  registryCategory?: RegistryCategory | null;
  labels?: string[];
}

export interface EvaluateCandidateInput {
  candidate: CandidateClaims;
  evidence: CandidateEvidence;
  settings: Settings;
}

export interface EvaluateCandidateResult {
  verdict: CandidateValidationVerdict;
  /** 0-100. */
  confidence: number;
  reason: string;
}

const EXCLUDED_REGISTRY_CATEGORIES: ReadonlySet<RegistryCategory> = new Set(['CEX', 'ROUTER', 'POOL', 'BRIDGE', 'MIXER']);
const SMART_OFFSET_LABELS = new Set(['human_like', 'smart_money']);
const AUTO_REJECT_CONFIDENCE = 85;

export function evaluateCandidate(input: EvaluateCandidateInput): EvaluateCandidateResult {
  const { candidate, evidence, settings } = input;
  const labels = evidence.labels ?? [];

  // -- 1. AUTO-REJECT: excluded registry category --------------------------
  if (evidence.registryCategory && EXCLUDED_REGISTRY_CATEGORIES.has(evidence.registryCategory)) {
    return {
      verdict: 'reject',
      confidence: AUTO_REJECT_CONFIDENCE,
      reason: `excluded service address (${evidence.registryCategory})`
    };
  }

  // -- 2. AUTO-REJECT: bot/mev, or sniper with no offsetting human/smart label
  const hasBotLabel = labels.includes('possible_bot') || labels.includes('mev');
  const hasUnoffsetSniper = labels.includes('sniper') && !labels.some((l) => SMART_OFFSET_LABELS.has(l));
  if (hasBotLabel || hasUnoffsetSniper) {
    return {
      verdict: 'reject',
      confidence: AUTO_REJECT_CONFIDENCE,
      reason: `bot/sniper-dominant (labels: ${labels.join(', ') || 'none'})`
    };
  }

  // -- 3. EVIDENCE GATE: no computed evidence => insufficient, never promote
  //    on claims alone.
  if (!evidence.computedPnl) {
    return {
      verdict: 'insufficient',
      confidence: 0,
      reason: 'no computed PnL evidence available (provider and local trade history both unavailable) — claims alone never promote'
    };
  }

  // -- 4. THRESHOLD GATE ------------------------------------------------
  const thresholds = settings.profitableWallet;
  const pnl = evidence.computedPnl;

  const failing: string[] = [];
  if (pnl.pnl30d < thresholds.pnl30d) failing.push(`pnl30d (${pnl.pnl30d} < ${thresholds.pnl30d})`);
  if (pnl.tradeCount < thresholds.minTrades) failing.push(`tradeCount (${pnl.tradeCount} < ${thresholds.minTrades})`);
  if (pnl.winRate < thresholds.minWinRate) failing.push(`winRate (${pnl.winRate} < ${thresholds.minWinRate})`);
  if (pnl.realizedPnlUsd < thresholds.minRealized) failing.push(`realizedPnlUsd (${pnl.realizedPnlUsd} < ${thresholds.minRealized})`);
  if (pnl.avgTradeSizeUsd < thresholds.minAvgTradeSizeUsd) {
    failing.push(`avgTradeSizeUsd (${pnl.avgTradeSizeUsd} < ${thresholds.minAvgTradeSizeUsd})`);
  }

  const confidence = computeConfidence(candidate, pnl);

  if (failing.length > 0) {
    return {
      verdict: 'reject',
      confidence,
      reason: `below thresholds (${failing.join(', ')})`
    };
  }

  return {
    verdict: 'promote',
    confidence,
    reason: 'computed PnL evidence clears every profitableWallet threshold'
  };
}

/**
 * Blends the computed evidence's own confidence with claimed-vs-computed
 * agreement (see file header formula doc). Only claims the candidate
 * actually supplied are compared; an absent claim neither helps nor hurts.
 */
function computeConfidence(candidate: CandidateClaims, pnl: ComputedPnlEvidence): number {
  const comparisons: Array<{ claimed?: number; computed: number }> = [
    { claimed: candidate.claimedPnlUsd, computed: pnl.pnl30d },
    { claimed: candidate.claimedWinRate, computed: pnl.winRate },
    { claimed: candidate.claimedTradeCount, computed: pnl.tradeCount }
  ];

  const usable = comparisons.filter(
    (c): c is { claimed: number; computed: number } => c.claimed !== undefined && c.computed > 0
  );

  let agreementRatio = 1; // default: nothing to compare => no disagreement
  if (usable.length > 0) {
    const agreementScores: number[] = usable.map(({ claimed, computed }) => {
      const ratio = claimed / computed;
      const withinBand = ratio >= 0.5 && ratio <= 2;
      return withinBand ? 1 : 0;
    });
    agreementRatio = agreementScores.reduce((a, b) => a + b, 0) / agreementScores.length;
  }

  const agreementMultiplier = 0.7 + 0.3 * agreementRatio;
  const raw = pnl.confidence * agreementMultiplier;
  return Math.max(0, Math.min(100, Math.round(raw)));
}
