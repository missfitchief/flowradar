// FlowRadar — Rule F: profit-rotation (per token, 24h context).
//
// Normative source: Task 14 binding decision 4 + settings rules.F defaults
// (minRealizedProfitUsd 500, maxTransferDelayHours 24, minValueMatchPct 80,
// maxValueMatchPct 105, maxBuyDelayMin 60, maxMcap 5,000,000).
//
// Fires when ANY candidate in extras.rotationCandidates matches ALL of:
//   candidate.destTokenId === agg.tokenId
//     (rule F only cares about rotations that land on THIS token)
//   candidate.realizedProfitUsd >= F.minRealizedProfitUsd
//   valueMatchPct = receivedValueUsd / transferredValueUsd * 100, within
//     [F.minValueMatchPct, F.maxValueMatchPct] inclusive
//     (receivedValueUsd/transferredValueUsd may differ from 100% due to
//     bridge fees/slippage — the match-pct band tolerates that noise while
//     still requiring the received value to plausibly BE the transferred
//     value, not an unrelated coincidental buy)
//   buyDelayMin = (destBuyTs - receiptTs) in minutes <= F.maxBuyDelayMin
//   candidate.destTokenMcapAtBuy !== null AND <= F.maxMcap
//     (null mcap means "unknown" — hard non-match, per task brief)
//
// F.maxTransferDelayHours ("transfer within N hours of the profitable exit")
// is a builder-side invariant per the task brief: candidate builders (Task
// 23) are responsible for only constructing a RotationCandidate once they've
// confirmed the transfer followed the profitable exit within that window —
// RotationCandidate carries transferTs (the transfer moment itself) but no
// separate "exit timestamp" field for this rule to re-derive the gap from.
// Rule F therefore does not re-validate maxTransferDelayHours itself; it
// trusts the candidate's existence as evidence the builder already checked
// it. This is a deliberate scope boundary (see Task 14 brief note on the
// "25h transfer-to-receipt window handled by builder" scenario), not an
// oversight.
//
// Severity HIGH when fired.
//
// metrics carries: total candidate count, matched count, the FIRST matching
// candidate's value-match%/buy-delay/profit/bridged fields.

import type { Rule, RuleResult } from '../types';

export const ruleF: Rule = (agg, settings, extra) => {
  const { F } = settings.rules;
  const candidates = extra?.rotationCandidates ?? [];

  interface MatchInfo {
    valueMatchPct: number;
    buyDelayMin: number;
    realizedProfitUsd: number;
    bridged: boolean;
  }

  let matchCount = 0;
  let bestMatch: MatchInfo | null = null;

  for (const candidate of candidates) {
    if (candidate.destTokenId !== agg.tokenId) continue;
    if (candidate.realizedProfitUsd < F.minRealizedProfitUsd) continue;
    if (candidate.destTokenMcapAtBuy === null) continue; // unknown mcap -> do not fire
    if (candidate.destTokenMcapAtBuy > F.maxMcap) continue;

    const valueMatchPct =
      candidate.transferredValueUsd > 0 ? (candidate.receivedValueUsd / candidate.transferredValueUsd) * 100 : 0;
    const meetsValueMatch = valueMatchPct >= F.minValueMatchPct && valueMatchPct <= F.maxValueMatchPct;
    if (!meetsValueMatch) continue;

    const buyDelayMin = (candidate.destBuyTs.getTime() - candidate.receiptTs.getTime()) / 60_000;
    const meetsBuyDelay = buyDelayMin <= F.maxBuyDelayMin;
    if (!meetsBuyDelay) continue;

    matchCount += 1;
    if (bestMatch === null) {
      bestMatch = {
        valueMatchPct,
        buyDelayMin,
        realizedProfitUsd: candidate.realizedProfitUsd,
        bridged: candidate.bridged
      };
    }
  }

  const metrics: RuleResult['metrics'] = {
    candidateCount: candidates.length,
    matchedCandidateCount: matchCount,
    bestValueMatchPct: bestMatch?.valueMatchPct ?? -1,
    bestBuyDelayMin: bestMatch?.buyDelayMin ?? -1,
    bestRealizedProfitUsd: bestMatch?.realizedProfitUsd ?? -1,
    bridged: bestMatch?.bridged ?? false
  };

  if (bestMatch === null) {
    return {
      rule: 'F',
      fired: false,
      severity: 'INFO',
      reasons: [
        candidates.length === 0
          ? 'No rotation candidates observed for this token.'
          : `${candidates.length} rotation candidate(s) observed but none match the profit-rotation pattern (profit >= $${F.minRealizedProfitUsd}, value match ${F.minValueMatchPct}-${F.maxValueMatchPct}%, re-buy within ${F.maxBuyDelayMin}min, mcap <= $${F.maxMcap}).`
      ],
      metrics
    };
  }

  return {
    rule: 'F',
    fired: true,
    severity: 'HIGH',
    reasons: [
      `A wallet likely rotated a $${bestMatch.realizedProfitUsd.toFixed(0)} profit from another token into this one${bestMatch.bridged ? ' via a cross-chain bridge' : ''} — received value matched ${bestMatch.valueMatchPct.toFixed(1)}% of the transferred amount, within the ${F.minValueMatchPct}-${F.maxValueMatchPct}% band expected for a direct pass-through.`,
      `The destination buy landed ${bestMatch.buyDelayMin.toFixed(1)} minutes after receipt, within the ${F.maxBuyDelayMin}-minute re-buy window that suggests the funds were earmarked for this token.`,
      `${matchCount} of ${candidates.length} rotation candidate(s) matched this pattern.`
    ],
    metrics
  };
};
