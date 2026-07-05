// FlowRadar — Rule A: early smart-money accumulation (TIERED).
//
// Normative source: SCOPE CORRECTION 2026-07-05 (progress.md) — Rule A is
// tiered, not a single on/off gate:
//   count = agg.smartWalletCount (buyers who are watched OR profitable —
//     TokenWindowAggregate.smartWalletCount is populated by aggregation as
//     exactly that "watched OR profitable" buyer count; see Task 15/plan).
//
//   count >= rules.A.watchMinWallets (10)  -> fired, severity WATCH
//   count <  rules.A.watchMinWallets       -> not fired
//
//   Additionally, on top of the WATCH floor, HIGH requires ALL of:
//     count            >= rules.A.minWallets (20)
//     buyVolumeUsd     >= rules.A.minBuyVolumeUsd
//     netFlowUsd       >  0
//     soldPct          <  rules.A.maxSoldPct
//     mcap             in [rules.A.mcapMin, rules.A.mcapMax]
//     liquidityUsd     >= rules.A.minLiquidityUsd
//     tokenAgeDays     <  rules.A.maxTokenAgeDays  OR  inflowSpike
//
// soldPct derivation: TokenWindowAggregate has no directly-named "sold
// percentage" field. The natural derivation from the two volume fields the
// aggregate DOES expose is soldPct = trackedSellVolumeUsd /
// trackedBuyVolumeUsd * 100 (0 when there is no tracked buy volume to divide
// by) — this is a documented interpretation, not found verbatim elsewhere in
// the spec/plan docs.
//
// RuleResult.metrics carries rawWalletCount, uniqueEntityCount,
// largestClusterSize (straight from the aggregate; clustering may not have
// run yet, in which case these equal raw counts / 0 per Task 13 note), plus
// the volume/mcap inputs used for the HIGH-tier evaluation.

import type { Rule, RuleResult } from '../types';

export const ruleA: Rule = (agg, settings) => {
  const { A } = settings.rules;
  const count = agg.smartWalletCount;

  const buyVolumeUsd = agg.trackedBuyVolumeUsd;
  const sellVolumeUsd = agg.trackedSellVolumeUsd;
  const soldPct = buyVolumeUsd > 0 ? (sellVolumeUsd / buyVolumeUsd) * 100 : 0;
  const mcapUsd = agg.currentMcap;

  const metrics: RuleResult['metrics'] = {
    rawWalletCount: count,
    uniqueEntityCount: agg.uniqueEntityCount,
    largestClusterSize: agg.largestClusterSize,
    buyVolumeUsd,
    sellVolumeUsd,
    soldPct,
    netFlowUsd: agg.netFlowUsd,
    mcapUsd: mcapUsd ?? 0,
    liquidityUsd: agg.liquidityUsd ?? 0,
    tokenAgeDays: agg.tokenAgeDays ?? -1,
    inflowSpike: agg.inflowSpike
  };

  if (count < A.watchMinWallets) {
    return {
      rule: 'A',
      fired: false,
      severity: 'INFO',
      reasons: [`Only ${count} smart/watched wallets bought (below WATCH floor of ${A.watchMinWallets}).`],
      metrics
    };
  }

  const meetsHighWalletFloor = count >= A.minWallets;
  const meetsVolume = buyVolumeUsd >= A.minBuyVolumeUsd;
  const meetsNetFlow = agg.netFlowUsd > 0;
  const meetsSoldPct = soldPct < A.maxSoldPct;
  const meetsMcap = mcapUsd !== null && mcapUsd >= A.mcapMin && mcapUsd <= A.mcapMax;
  const meetsLiquidity = agg.liquidityUsd !== null && agg.liquidityUsd >= A.minLiquidityUsd;
  const meetsAgeOrSpike = (agg.tokenAgeDays !== null && agg.tokenAgeDays < A.maxTokenAgeDays) || agg.inflowSpike;

  const isHigh =
    meetsHighWalletFloor &&
    meetsVolume &&
    meetsNetFlow &&
    meetsSoldPct &&
    meetsMcap &&
    meetsLiquidity &&
    meetsAgeOrSpike;

  if (isHigh) {
    return {
      rule: 'A',
      fired: true,
      severity: 'HIGH',
      reasons: [
        `${count} smart/watched wallets bought >= HIGH floor of ${A.minWallets}.`,
        `Buy volume $${buyVolumeUsd.toFixed(0)} >= $${A.minBuyVolumeUsd}, net flow positive, sold ${soldPct.toFixed(1)}% < ${A.maxSoldPct}% cap.`,
        `Mcap $${(mcapUsd ?? 0).toFixed(0)} within [$${A.mcapMin}, $${A.mcapMax}], liquidity $${(agg.liquidityUsd ?? 0).toFixed(0)} >= $${A.minLiquidityUsd}.`,
        agg.inflowSpike
          ? 'Inflow spike detected (age-or-spike condition satisfied via spike).'
          : `Token age ${agg.tokenAgeDays} days < ${A.maxTokenAgeDays} day cap.`
      ],
      metrics
    };
  }

  return {
    rule: 'A',
    fired: true,
    severity: 'WATCH',
    reasons: [
      `${count} smart/watched wallets bought (WATCH tier: >= ${A.watchMinWallets}, HIGH tier needs >= ${A.minWallets} plus volume/mcap/liquidity/age conditions).`,
      count < A.minWallets
        ? `Wallet count ${count} below HIGH floor of ${A.minWallets}.`
        : 'Wallet count meets HIGH floor, but at least one other HIGH condition (volume, sold%, mcap band, liquidity, or age/spike) failed.'
    ],
    metrics
  };
};
