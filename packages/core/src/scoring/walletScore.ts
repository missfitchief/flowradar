// FlowRadar — WalletScore (0-100).
//
// Normative source: Spec §6 "Core engine":
//   pnl 25%, winRate 15%, tradeCount 10%, humanLikelihood 15%, avgEntryQuality 10%,
//   holdingQuality 10%, recentPerformance 15%; botPenalty up to -30; result x
//   confidence multiplier (0.5-1.0 from pnlConfidence); clamp 0-100. Components
//   stored in scoreComponents.
//
// Curves (plan Shared Contracts / task brief):
//   pnl        = clamp01(pnl30d / 10000) * 25
//   winRate    = clamp01(winRate / 0.7) * 15
//   tradeCount = clamp01(tradeCount / 30) * 10
//   human      = humanLikelihood * 15
//   entryQuality = entryQuality * 10
//   holding      = holdingQuality * 10
//   recentPerf   = recentPerf * 15
//   botPenalty   = 30 * botLikelihood (subtracted from the positive-component sum)
//   confidenceMultiplier = 0.5 + 0.5 * (pnlConfidence / 100), applied to the
//     post-penalty sum, then clamp 0-100.

import type { WalletStatsInput } from '../types.js';

export interface WalletScoreResult {
  score: number;
  components: Record<string, number>;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function computeWalletScore(s: WalletStatsInput): WalletScoreResult {
  const pnl = clamp01(s.pnl30d / 10000) * 25;
  const winRate = clamp01(s.winRate / 0.7) * 15;
  const tradeCount = clamp01(s.tradeCount / 30) * 10;
  const human = s.humanLikelihood * 15;
  const entryQuality = s.entryQuality * 10;
  const holding = s.holdingQuality * 10;
  const recentPerf = s.recentPerf * 15;

  const botPenalty = 30 * s.botLikelihood;
  const confidenceMultiplier = 0.5 + 0.5 * (s.pnlConfidence / 100);

  const positiveSum = pnl + winRate + tradeCount + human + entryQuality + holding + recentPerf;
  const postPenalty = positiveSum - botPenalty;
  const score = Math.min(100, Math.max(0, postPenalty * confidenceMultiplier));

  return {
    score,
    components: {
      pnl,
      winRate,
      tradeCount,
      human,
      entryQuality,
      holding,
      recentPerf,
      botPenalty,
      confidenceMultiplier
    }
  };
}
