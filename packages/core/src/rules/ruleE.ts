// FlowRadar — Rule E: fresh-wallet-funded-then-buys (per token, 30-min context).
//
// Normative source: Task 14 binding decision 3 + settings rules.E defaults
// (minDelayMin 5, maxDelayMin 120, maxMcap 5,000,000, minBuyToFundingPct 30,
// maxBuyToFundingPct 110).
//
// Fires when ANY event in extras.fundingEvents matches ALL of:
//   event.fundedAddressFresh === true
//   event.fundedFirstBuy present AND event.fundedFirstBuy.tokenId === agg.tokenId
//     (rule E only cares about funding->buy chains that land on THIS token —
//     a fresh wallet buying a DIFFERENT token is not evidence for this
//     token's signal)
//   delayMin = (fundedFirstBuy.ts - event.ts) in minutes, within
//     [E.minDelayMin, E.maxDelayMin] inclusive
//   fundedFirstBuy.mcapAtBuy !== null AND <= E.maxMcap
//     (null mcap means "unknown" — treated as a hard non-match, not as
//     passing/failing the numeric comparison, per the task brief)
//   ratioPct = fundedFirstBuy.usd / event.amountUsd * 100, within
//     [E.minBuyToFundingPct, E.maxBuyToFundingPct] inclusive
//
// Severity HIGH when fired (single-tier rule, unlike A's WATCH/HIGH split).
//
// metrics carries: total funding event count, matching event count, and the
// FIRST matching event's delay/ratio ("best match" — since matches are
// boolean per-event, "best" here just means "the one we report on"; multiple
// matches do not currently rank against each other).

import type { Rule, RuleResult } from '../types';

export const ruleE: Rule = (agg, settings, extra) => {
  const { E } = settings.rules;
  const fundingEvents = extra?.fundingEvents ?? [];

  interface MatchInfo {
    delayMin: number;
    ratioPct: number;
  }

  let matchCount = 0;
  let bestMatch: MatchInfo | null = null;

  for (const event of fundingEvents) {
    if (!event.fundedAddressFresh) continue;
    const firstBuy = event.fundedFirstBuy;
    if (!firstBuy) continue;
    if (firstBuy.tokenId !== agg.tokenId) continue;
    if (firstBuy.mcapAtBuy === null) continue; // unknown mcap -> do not fire

    const delayMin = (firstBuy.ts.getTime() - event.ts.getTime()) / 60_000;
    const meetsDelay = delayMin >= E.minDelayMin && delayMin <= E.maxDelayMin;
    if (!meetsDelay) continue;

    const meetsMcap = firstBuy.mcapAtBuy <= E.maxMcap;
    if (!meetsMcap) continue;

    const ratioPct = event.amountUsd > 0 ? (firstBuy.usd / event.amountUsd) * 100 : 0;
    const meetsRatio = ratioPct >= E.minBuyToFundingPct && ratioPct <= E.maxBuyToFundingPct;
    if (!meetsRatio) continue;

    matchCount += 1;
    if (bestMatch === null) {
      bestMatch = { delayMin, ratioPct };
    }
  }

  const metrics: RuleResult['metrics'] = {
    fundingEventCount: fundingEvents.length,
    matchingEventCount: matchCount,
    bestMatchDelayMin: bestMatch?.delayMin ?? -1,
    bestMatchRatioPct: bestMatch?.ratioPct ?? -1
  };

  if (bestMatch === null) {
    return {
      rule: 'E',
      fired: false,
      severity: 'INFO',
      reasons: [
        fundingEvents.length === 0
          ? 'No funding events observed for this token.'
          : `${fundingEvents.length} funding event(s) observed but none match the fresh-wallet-funded-then-buys pattern (fresh address, buy on this token, delay ${E.minDelayMin}-${E.maxDelayMin}min, mcap <= $${E.maxMcap}, buy/funding ratio ${E.minBuyToFundingPct}-${E.maxBuyToFundingPct}%).`
      ],
      metrics
    };
  }

  return {
    rule: 'E',
    fired: true,
    severity: 'HIGH',
    reasons: [
      `A freshly-funded wallet likely bought this token ${bestMatch.delayMin.toFixed(1)} minutes after funding — within the ${E.minDelayMin}-${E.maxDelayMin} minute window that suggests a coordinated funding-to-buy chain.`,
      `Buy size was ${bestMatch.ratioPct.toFixed(1)}% of the funding amount, within the ${E.minBuyToFundingPct}-${E.maxBuyToFundingPct}% band typically seen when funding is earmarked for this specific purchase.`,
      `${matchCount} of ${fundingEvents.length} funding event(s) matched this pattern.`
    ],
    metrics
  };
};
