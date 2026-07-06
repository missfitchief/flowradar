// FlowRadar — Rule C: organic (non-bot, non-clustered) buyer base.
//
// Normative source: Task 13 brief + settings rules.C defaults (minHumanRatio
// 0.7, maxBotRatio 0.2, maxSingleBlockBuysPct 30, minFundingRoots 3,
// minFundingRootsPct 0.3). Product brief verbatim (Task 15 Fix A — binding,
// supersedes the human_like-only reading below): "70%+ buying wallets are
// human_like OR smart_money".
//
// Fires when ALL of:
//   humanRatio = agg.humanOrSmartLabelCount / agg.buyers.length >= minHumanRatio
//     (humanOrSmartLabelCount = buyers whose labels include human_like OR
//     smart_money, a union — NOT agg.humanLikeCount, which is human_like-only
//     and undercounts scenarios whose smart cohort splits across both
//     labels, e.g. NOVA's 18/17 smart_money/human_like split reading 53.7%
//     on humanLikeCount alone vs. ~100% on the union).
//   botRatio   = agg.possibleBotCount / agg.buyers.length <= maxBotRatio
//   largestSingleBlockPct <= maxSingleBlockBuysPct
//     where largestSingleBlockPct is the largest share of agg.buyers (by
//     buyer COUNT, matching how humanRatio/botRatio are also buyer-count
//     ratios) that share a single agg.buyers[].blockOrSlot value.
//
// Funding-diversity check (minFundingRoots / minFundingRootsPct) is SKIPPED:
// TokenWindowAggregate carries no funding-root data yet (documented gap;
// funding info arrives via RuleExtras.fundingEvents for rule E in a later
// task, not through the aggregate rule C reads).
//
// Empty buyers list: ratios default to 0 (no divide-by-zero), and the rule
// simply does not fire (0 < minHumanRatio in every realistic configuration).

import type { Rule, RuleResult } from '../types';

export const ruleC: Rule = (agg, settings) => {
  const { C } = settings.rules;
  const totalBuyers = agg.buyers.length;

  const humanRatio = totalBuyers > 0 ? agg.humanOrSmartLabelCount / totalBuyers : 0;
  const botRatio = totalBuyers > 0 ? agg.possibleBotCount / totalBuyers : 0;

  let largestSingleBlockPct = 0;
  if (totalBuyers > 0) {
    const countsByBlock = new Map<string, number>();
    for (const buyer of agg.buyers) {
      const key = buyer.blockOrSlot.toString();
      countsByBlock.set(key, (countsByBlock.get(key) ?? 0) + 1);
    }
    const largestBlockCount = Math.max(...countsByBlock.values());
    largestSingleBlockPct = (largestBlockCount / totalBuyers) * 100;
  }

  const metrics: RuleResult['metrics'] = {
    humanRatio,
    botRatio,
    largestSingleBlockPct,
    totalBuyers,
    fundingDiversityChecked: false
  };

  const meetsHuman = humanRatio >= C.minHumanRatio;
  const meetsBot = botRatio <= C.maxBotRatio;
  const meetsBlockSpread = largestSingleBlockPct <= C.maxSingleBlockBuysPct;

  const fired = totalBuyers > 0 && meetsHuman && meetsBot && meetsBlockSpread;

  if (!fired) {
    const misses: string[] = [];
    if (totalBuyers === 0) misses.push('no buyers in window');
    if (totalBuyers > 0 && !meetsHuman) misses.push(`human ratio ${(humanRatio * 100).toFixed(1)}% below ${C.minHumanRatio * 100}%`);
    if (totalBuyers > 0 && !meetsBot) misses.push(`bot ratio ${(botRatio * 100).toFixed(1)}% above ${C.maxBotRatio * 100}%`);
    if (totalBuyers > 0 && !meetsBlockSpread) {
      misses.push(`largest single-block share ${largestSingleBlockPct.toFixed(1)}% above ${C.maxSingleBlockBuysPct}%`);
    }

    return {
      rule: 'C',
      fired: false,
      severity: 'INFO',
      reasons: [`Organic-buyer-base conditions not met: ${misses.join('; ')}.`],
      metrics
    };
  }

  return {
    rule: 'C',
    fired: true,
    severity: 'WATCH',
    reasons: [
      `Human ratio ${(humanRatio * 100).toFixed(1)}% >= ${C.minHumanRatio * 100}%, bot ratio ${(botRatio * 100).toFixed(1)}% <= ${C.maxBotRatio * 100}%.`,
      `Largest single-block buyer share ${largestSingleBlockPct.toFixed(1)}% <= ${C.maxSingleBlockBuysPct}% cap (no single-block domination).`,
      'Funding-diversity check skipped (aggregate carries no funding-root data yet).'
    ],
    metrics
  };
};
