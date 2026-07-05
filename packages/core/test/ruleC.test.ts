import { describe, expect, it } from 'vitest';
import { ruleC } from '../src/rules/ruleC';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { TokenWindowAggregate } from '../src/types';

// Rule C: organic-buyer-base check.
//   humanRatio = humanLikeCount / buyers.length      >= minHumanRatio (0.7)
//   botRatio   = possibleBotCount / buyers.length     <= maxBotRatio (0.2)
//   no single blockOrSlot holds > maxSingleBlockBuysPct% (30%) of window buyers
//   funding-diversity check (minFundingRoots/minFundingRootsPct) is SKIPPED —
//   aggregate carries no funding-root data yet (documented in rules/ruleC.ts).

function makeBuyer(
  walletId: string,
  blockOrSlot: bigint,
  overrides: Partial<TokenWindowAggregate['buyers'][number]> = {}
): TokenWindowAggregate['buyers'][number] {
  return {
    walletId,
    walletScore: 50,
    labels: [],
    buyUsd: 100,
    sellUsd: 0,
    firstBuyTs: new Date('2026-07-05T00:05:00Z'),
    blockOrSlot,
    ...overrides
  };
}

/** N buyers spread across N distinct blocks (no single-block concentration). */
function spreadBuyers(n: number): TokenWindowAggregate['buyers'] {
  return Array.from({ length: n }, (_, i) => makeBuyer(`w${i}`, BigInt(i)));
}

function makeAggregate(overrides: Partial<TokenWindowAggregate> = {}): TokenWindowAggregate {
  const base: TokenWindowAggregate = {
    tokenId: 'token-1',
    windowMinutes: 30,
    from: new Date('2026-07-05T00:00:00Z'),
    to: new Date('2026-07-05T00:30:00Z'),
    buyers: [],
    trackedBuyVolumeUsd: 0,
    trackedSellVolumeUsd: 0,
    netFlowUsd: 0,
    buySellRatio: 0,
    smartWalletCount: 0,
    humanLikeCount: 0,
    possibleBotCount: 0,
    whaleBuys: [],
    uniqueEntityCount: 0,
    largestClusterSize: 0,
    avgEntryMcap: null,
    currentMcap: null,
    mcapExpansionFromAvgEntry: null,
    liquidityUsd: null,
    liquidityChangePct: null,
    tokenAgeDays: null,
    inflowSpike: false,
    exitedSmartPct: 0,
    topHolderExits: 0,
    newSmartBuyers: 0
  };
  return { ...base, ...overrides };
}

describe('ruleC', () => {
  it('75% human, 10% bot, spread across blocks -> fires', () => {
    const agg = makeAggregate({
      buyers: spreadBuyers(100),
      humanLikeCount: 75,
      possibleBotCount: 10
    });

    const result = ruleC(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.rule).toBe('C');
  });

  it('69% human (below minHumanRatio=0.7) -> does not fire', () => {
    const agg = makeAggregate({
      buyers: spreadBuyers(100),
      humanLikeCount: 69,
      possibleBotCount: 10
    });

    const result = ruleC(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('35% of buys concentrated in one block (above maxSingleBlockBuysPct=30) -> does not fire', () => {
    const buyers: TokenWindowAggregate['buyers'] = [
      ...Array.from({ length: 35 }, (_, i) => makeBuyer(`clustered-${i}`, 1000n)),
      ...Array.from({ length: 65 }, (_, i) => makeBuyer(`spread-${i}`, BigInt(2000 + i)))
    ];
    const agg = makeAggregate({
      buyers,
      humanLikeCount: 80,
      possibleBotCount: 5
    });

    const result = ruleC(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('bot ratio above maxBotRatio (0.2) -> does not fire even with good human ratio', () => {
    const agg = makeAggregate({
      buyers: spreadBuyers(100),
      humanLikeCount: 75,
      possibleBotCount: 25 // 25% > 20%
    });

    const result = ruleC(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('exactly at the single-block boundary (30%) does not trip the over-concentration check', () => {
    const buyers: TokenWindowAggregate['buyers'] = [
      ...Array.from({ length: 30 }, (_, i) => makeBuyer(`clustered-${i}`, 1000n)),
      ...Array.from({ length: 70 }, (_, i) => makeBuyer(`spread-${i}`, BigInt(2000 + i)))
    ];
    const agg = makeAggregate({
      buyers,
      humanLikeCount: 80,
      possibleBotCount: 5
    });

    const result = ruleC(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
  });

  it('empty buyers list does not fire and does not throw (avoids divide-by-zero)', () => {
    const agg = makeAggregate({ buyers: [], humanLikeCount: 0, possibleBotCount: 0 });

    expect(() => ruleC(agg, DEFAULT_SETTINGS)).not.toThrow();
    expect(ruleC(agg, DEFAULT_SETTINGS).fired).toBe(false);
  });

  it('metrics report humanRatio, botRatio, and largestSingleBlockPct', () => {
    const agg = makeAggregate({
      buyers: spreadBuyers(100),
      humanLikeCount: 75,
      possibleBotCount: 10
    });

    const result = ruleC(agg, DEFAULT_SETTINGS);

    expect(result.metrics.humanRatio).toBeCloseTo(0.75, 5);
    expect(result.metrics.botRatio).toBeCloseTo(0.1, 5);
    expect(typeof result.metrics.largestSingleBlockPct).toBe('number');
  });
});
