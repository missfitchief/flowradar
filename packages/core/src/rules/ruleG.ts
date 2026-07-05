// FlowRadar — Rule G: exit-warning (24h context, CRITICAL).
//
// Normative source: Task 14 binding decision 5 + settings rules.G defaults
// (minExitedPct 30, liquidityDropPct 30, mcapPumpPct 100, maxNewSmartBuyers 3;
// exitPositionSoldPct/liquidityDropWindowMin/mcapPumpWindowHours describe how
// aggregation computes exitedSmartPct/liquidityChangePct/mcapExpansionFromAvgEntry
// upstream and are not re-read here — rule G consumes the already-windowed
// aggregate fields directly).
//
// Fires when ANY of 4 independent disjuncts holds:
//   (a) agg.exitedSmartPct >= G.minExitedPct
//   (b) agg.netFlowUsd < 0 AND agg.topHolderExits >= 3
//   (c) agg.liquidityChangePct !== null AND agg.liquidityChangePct <= -G.liquidityDropPct
//       (liquidityChangePct is signed: negative = drop, positive = increase;
//       null = unknown, treated as "not a drop" -> does not satisfy (c))
//   (d) agg.mcapExpansionFromAvgEntry !== null
//       AND agg.mcapExpansionFromAvgEntry >= G.mcapPumpPct / 100
//       AND agg.newSmartBuyers < G.maxNewSmartBuyers
//
// Unlike rules A-F (single evaluation path), G accumulates a reasons entry
// per triggered disjunct — multiple can fire simultaneously, and the result
// lists all of them (task brief: "two triggers -> both reasons listed").
//
// Severity CRITICAL when fired (this is the only CRITICAL-severity rule in
// A-G; A can reach HIGH, G is exit-warning territory, one tier above).
//
// metrics always carries all four raw inputs (exitedSmartPct, netFlowUsd,
// topHolderExits, liquidityChangePct, mcapExpansionFromAvgEntry,
// newSmartBuyers), fired or not, so downstream consumers can chart them
// without re-deriving from the aggregate.

import type { Rule, RuleResult } from '../types';

export const ruleG: Rule = (agg, settings) => {
  const { G } = settings.rules;

  const metrics: RuleResult['metrics'] = {
    exitedSmartPct: agg.exitedSmartPct,
    netFlowUsd: agg.netFlowUsd,
    topHolderExits: agg.topHolderExits,
    liquidityChangePct: agg.liquidityChangePct ?? -1,
    mcapExpansionFromAvgEntry: agg.mcapExpansionFromAvgEntry ?? -1,
    newSmartBuyers: agg.newSmartBuyers
  };

  const reasons: string[] = [];

  const triggerA = agg.exitedSmartPct >= G.minExitedPct;
  if (triggerA) {
    reasons.push(
      `${agg.exitedSmartPct.toFixed(1)}% of smart/watched wallets have exited their position, at or above the ${G.minExitedPct}% floor that signals a broad smart-money exit.`
    );
  }

  const triggerB = agg.netFlowUsd < 0 && agg.topHolderExits >= 3;
  if (triggerB) {
    reasons.push(
      `Net flow is negative ($${agg.netFlowUsd.toFixed(0)}) with ${agg.topHolderExits} top-holder exits (>= 3) — net outflow driven by large holders leaving.`
    );
  }

  const triggerC = agg.liquidityChangePct !== null && agg.liquidityChangePct <= -G.liquidityDropPct;
  if (triggerC) {
    reasons.push(
      `Liquidity dropped ${Math.abs(agg.liquidityChangePct as number).toFixed(1)}%, at or beyond the ${G.liquidityDropPct}% drop that suggests LP withdrawal or a rug-pull setup.`
    );
  }

  const triggerD =
    agg.mcapExpansionFromAvgEntry !== null &&
    agg.mcapExpansionFromAvgEntry >= G.mcapPumpPct / 100 &&
    agg.newSmartBuyers < G.maxNewSmartBuyers;
  if (triggerD) {
    reasons.push(
      `Mcap expanded ${(agg.mcapExpansionFromAvgEntry as number).toFixed(2)}x from average smart-money entry (>= ${G.mcapPumpPct}% pump) with only ${agg.newSmartBuyers} new smart buyer(s) (< ${G.maxNewSmartBuyers}) — price is pumping without fresh smart-money conviction, consistent with retail-only chasing or manipulation.`
    );
  }

  const fired = triggerA || triggerB || triggerC || triggerD;

  if (!fired) {
    return {
      rule: 'G',
      fired: false,
      severity: 'INFO',
      reasons: ['No exit-warning conditions met (exited%, net-flow/holder-exits, liquidity drop, mcap pump without smart buyers all clear).'],
      metrics
    };
  }

  return {
    rule: 'G',
    fired: true,
    severity: 'CRITICAL',
    reasons,
    metrics
  };
};
