// FlowRadar — FlowScore (0-100).
//
// Normative source: Spec §6 "Core engine":
//   weighted sum of normalized components: smartWalletCount 20 (min(n/40,1)),
//   entityAdjustedCount 15 (min(entities/25,1)), netSmartBuyVolume 15
//   (clamp(net/50k,0,1)), walletQualityAvg 15 (avgScore/100), humanLikeRatio 10,
//   mcapEfficiency 10 (higher when avg entry mcap sits low in the configured band),
//   accumulationWithoutExpansion 10 (1-min(expansion/2,1)), riskLiquiditySanity 5
//   (1 - risk penalty).
//
// Curves (plan Shared Contracts / task brief, exact):
//   smartWalletCount  = min(n/40, 1) * 20
//   uniqueEntityCount = min(entities/25, 1) * 15
//   netFlow           = clamp01(netFlowUsd/50000) * 15 (negative -> 0)
//   walletQuality     = (avg buyer walletScore / 100) * 15
//   humanRatio        = (humanLikeCount / max(smartWalletCount, 1)) * 10
//   mcapEfficiency    = if avgEntryMcap null -> 0
//                       else (1 - clamp01((avgEntryMcap - rules.A.mcapMin) / (rules.A.mcapMax - rules.A.mcapMin))) * 10
//   accumulation      = if mcapExpansionFromAvgEntry null -> 0
//                       else (1 - min(mcapExpansion/2, 1)) * 10
//   riskSanity        = (1 - risk.penalty) * 5
//   sum, clamp 0-100, round to 1 decimal.

import type { Settings } from '../settings';
import type { RiskReport, TokenWindowAggregate } from '../types';

export interface FlowScoreResult {
  score: number;
  components: Record<string, number>;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function computeFlowScore(
  agg: TokenWindowAggregate,
  risk: RiskReport,
  settings: Settings
): FlowScoreResult {
  const smartWalletCount = Math.min(agg.smartWalletCount / 40, 1) * 20;
  const uniqueEntityCount = Math.min(agg.uniqueEntityCount / 25, 1) * 15;
  const netFlow = clamp01(agg.netFlowUsd / 50000) * 15;

  const avgWalletScore =
    agg.buyers.length > 0
      ? agg.buyers.reduce((sum, b) => sum + b.walletScore, 0) / agg.buyers.length
      : 0;
  const walletQuality = (avgWalletScore / 100) * 15;

  const humanRatio = (agg.humanLikeCount / Math.max(agg.smartWalletCount, 1)) * 10;

  const { mcapMin, mcapMax } = settings.rules.A;
  const mcapEfficiency =
    agg.avgEntryMcap === null
      ? 0
      : (1 - clamp01((agg.avgEntryMcap - mcapMin) / (mcapMax - mcapMin))) * 10;

  const accumulation =
    agg.mcapExpansionFromAvgEntry === null
      ? 0
      : (1 - Math.min(agg.mcapExpansionFromAvgEntry / 2, 1)) * 10;

  const riskSanity = (1 - risk.penalty) * 5;

  const sum =
    smartWalletCount +
    uniqueEntityCount +
    netFlow +
    walletQuality +
    humanRatio +
    mcapEfficiency +
    accumulation +
    riskSanity;

  const score = round1(Math.min(100, Math.max(0, sum)));

  return {
    score,
    components: {
      smartWalletCount,
      uniqueEntityCount,
      netFlow,
      walletQuality,
      humanRatio,
      mcapEfficiency,
      accumulation,
      riskSanity
    }
  };
}
