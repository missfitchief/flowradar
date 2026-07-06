// FlowRadar — Rule D: whale-anchored conviction buy.
//
// Normative source: Task 13 brief + settings rules.D defaults
// (minWhaleBuyUsd 10000, minWallets 15, minBuySellRatio 3).
//
// Severity contract (Task 15 fix): Rule D is NOT tiered — fired always means
// HIGH. There is no WATCH tier for D (unlike Rule A, which is deliberately
// tiered WATCH/HIGH). A previous implementation returned severity WATCH on
// fire, which let a fired-D Signal row surface at WATCH severity even though
// nothing about D's contract is graduated — fixed here.
//
// Fires when ALL of:
//   >= 1 entry in agg.whaleBuys with usd >= minWhaleBuyUsd
//   agg.smartWalletCount >= minWallets
//     ("profitable wallets" per the brief — TokenWindowAggregate exposes no
//     separate profitable-only count; smartWalletCount [watched OR
//     profitable, per rule A's binding decision] is the aggregate's only
//     wallet-quality count field, so it is reused here — same convention
//     rule A applies to "profitable wallets").
//   agg.buySellRatio > minBuySellRatio (strictly greater, per brief matrix:
//     ratio exactly at 3 does not fire, only 3.5 fires)

import type { Rule, RuleResult } from '../types';

export const ruleD: Rule = (agg, settings) => {
  const { D } = settings.rules;

  const maxWhaleBuyUsd = agg.whaleBuys.reduce((max, w) => Math.max(max, w.usd), 0);
  const hasQualifyingWhaleBuy = agg.whaleBuys.some((w) => w.usd >= D.minWhaleBuyUsd);
  const meetsWalletFloor = agg.smartWalletCount >= D.minWallets;
  const meetsRatio = agg.buySellRatio > D.minBuySellRatio;

  const metrics: RuleResult['metrics'] = {
    maxWhaleBuyUsd,
    whaleBuyCount: agg.whaleBuys.length,
    smartWalletCount: agg.smartWalletCount,
    buySellRatio: agg.buySellRatio
  };

  const fired = hasQualifyingWhaleBuy && meetsWalletFloor && meetsRatio;

  if (!fired) {
    const misses: string[] = [];
    if (!hasQualifyingWhaleBuy) misses.push(`no whale buy >= $${D.minWhaleBuyUsd} (max seen $${maxWhaleBuyUsd})`);
    if (!meetsWalletFloor) misses.push(`smart wallet count ${agg.smartWalletCount} below ${D.minWallets}`);
    if (!meetsRatio) misses.push(`buy/sell ratio ${agg.buySellRatio} not above ${D.minBuySellRatio}`);

    return {
      rule: 'D',
      fired: false,
      severity: 'INFO',
      reasons: [`Whale-anchored conviction conditions not met: ${misses.join('; ')}.`],
      metrics
    };
  }

  return {
    rule: 'D',
    fired: true,
    severity: 'HIGH',
    reasons: [
      `Whale buy of $${maxWhaleBuyUsd.toFixed(0)} >= $${D.minWhaleBuyUsd} threshold.`,
      `${agg.smartWalletCount} profitable/smart wallets >= ${D.minWallets} floor; buy/sell ratio ${agg.buySellRatio} > ${D.minBuySellRatio}.`
    ],
    metrics
  };
};
