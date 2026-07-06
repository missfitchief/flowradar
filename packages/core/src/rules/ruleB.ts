// FlowRadar — Rule B: early-buyer-base growth without excessive mcap
// expansion or distribution.
//
// Normative source: Task 13 brief + settings rules.B defaults (baseWallets
// 20, targetWallets 40, windowMin 1440, maxMcapExpansion 2, maxSellToBuyPct
// 25).
//
// Fires when:
//   agg.earlyWindowBuyerCount is present (not null/undefined) AND
//     >= rules.B.baseWallets
//   agg.smartWalletCount      >= rules.B.targetWallets
//   mcap multiplier (field+1)  <= rules.B.maxMcapExpansion (multiplier threshold)
//   sellToBuyPct              <= rules.B.maxSellToBuyPct
//     where sellToBuyPct = trackedSellVolumeUsd / trackedBuyVolumeUsd * 100
//     (0 when there is no tracked buy volume).
//
// agg.earlyWindowBuyerCount is OPTIONAL (populated by aggregation in Task
// 15) because a single-window aggregate cannot itself tell you what the
// EARLY sub-window's buyer count was. Missing it means growth cannot be
// evaluated at all, so rule B must not fire — this is a hard "cannot
// evaluate" case, not treated as a failed numeric comparison.

import type { Rule, RuleResult } from '../types';

export const ruleB: Rule = (agg, settings) => {
  const { B } = settings.rules;

  const earlyCount = agg.earlyWindowBuyerCount;
  const canEvaluateGrowth = earlyCount !== null && earlyCount !== undefined;

  const sellToBuyPct =
    agg.trackedBuyVolumeUsd > 0 ? (agg.trackedSellVolumeUsd / agg.trackedBuyVolumeUsd) * 100 : 0;

  // field is growth ratio; settings threshold is the multiplier — bridge units here.
  const mcapMultiplier =
    agg.mcapExpansionFromAvgEntry === null ? null : agg.mcapExpansionFromAvgEntry + 1;

  const metrics: RuleResult['metrics'] = {
    earlyWindowBuyerCount: earlyCount ?? -1,
    smartWalletCount: agg.smartWalletCount,
    mcapExpansionFromAvgEntry: agg.mcapExpansionFromAvgEntry ?? -1,
    mcapMultiplier: mcapMultiplier ?? -1,
    sellToBuyPct,
    canEvaluateGrowth
  };

  if (!canEvaluateGrowth) {
    return {
      rule: 'B',
      fired: false,
      severity: 'INFO',
      reasons: ['earlyWindowBuyerCount is not available — growth cannot be evaluated.'],
      metrics
    };
  }

  const meetsBase = earlyCount >= B.baseWallets;
  const meetsTarget = agg.smartWalletCount >= B.targetWallets;
  const meetsExpansion = mcapMultiplier !== null && mcapMultiplier <= B.maxMcapExpansion;
  const meetsSellPct = sellToBuyPct <= B.maxSellToBuyPct;

  const fired = meetsBase && meetsTarget && meetsExpansion && meetsSellPct;

  if (!fired) {
    const misses: string[] = [];
    if (!meetsBase) misses.push(`early buyer count ${earlyCount} below baseWallets ${B.baseWallets}`);
    if (!meetsTarget) misses.push(`current wallet count ${agg.smartWalletCount} below targetWallets ${B.targetWallets}`);
    if (!meetsExpansion) {
      const mult = mcapMultiplier ?? 'null';
      misses.push(`mcap ${mult}× from avg entry above cap ${B.maxMcapExpansion}×`);
    }
    if (!meetsSellPct) misses.push(`sell-to-buy ${sellToBuyPct.toFixed(1)}% above cap ${B.maxSellToBuyPct}%`);

    return {
      rule: 'B',
      fired: false,
      severity: 'INFO',
      reasons: [`Growth conditions not fully met: ${misses.join('; ')}.`],
      metrics
    };
  }

  return {
    rule: 'B',
    fired: true,
    severity: 'WATCH',
    reasons: [
      `Early-buyer base grew from ${earlyCount} to ${agg.smartWalletCount} wallets (targets: base ${B.baseWallets}, target ${B.targetWallets}).`,
      `Mcap ${(mcapMultiplier as number).toFixed(2)}× from avg entry within cap ${B.maxMcapExpansion}×; sell-to-buy ${sellToBuyPct.toFixed(1)}% within cap ${B.maxSellToBuyPct}%.`
    ],
    metrics
  };
};
