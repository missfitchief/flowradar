import { describe, expect, it } from 'vitest';
import { ruleB } from '../src/rules/ruleB';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { TokenWindowAggregate } from '../src/types';

// Rule B: base-window buyer count (baseWallets, 20) grows into the daily
// window's smartWalletCount reaching targetWallets (40), while mcap
// expansion from avg entry stays <= maxMcapExpansion (2x) and the
// sell-to-buy ratio stays <= maxSellToBuyPct (25%).
//
// Growth cannot be evaluated without agg.earlyWindowBuyerCount (optional
// field, populated by aggregation in Task 15) — missing it means "cannot
// evaluate growth" and rule B must not fire.

function makeAggregate(overrides: Partial<TokenWindowAggregate> = {}): TokenWindowAggregate {
  const base: TokenWindowAggregate = {
    tokenId: 'token-1',
    windowMinutes: 1440,
    from: new Date('2026-07-04T00:00:00Z'),
    to: new Date('2026-07-05T00:00:00Z'),
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
    newSmartBuyers: 0,
    earlyWindowBuyerCount: undefined
  };
  return { ...base, ...overrides };
}

describe('ruleB', () => {
  it('20 -> 44 growth, expansion 1.6x, sell 20% -> fires', () => {
    const agg = makeAggregate({
      earlyWindowBuyerCount: 20,
      smartWalletCount: 44,
      mcapExpansionFromAvgEntry: 1.6,
      trackedBuyVolumeUsd: 100000,
      trackedSellVolumeUsd: 20000 // 20% of buy volume
    });

    const result = ruleB(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.rule).toBe('B');
  });

  it('20 -> 39 growth (below targetWallets=40) -> does not fire', () => {
    const agg = makeAggregate({
      earlyWindowBuyerCount: 20,
      smartWalletCount: 39,
      mcapExpansionFromAvgEntry: 1.6,
      trackedBuyVolumeUsd: 100000,
      trackedSellVolumeUsd: 20000
    });

    const result = ruleB(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('expansion 2.1x (above maxMcapExpansion=2) -> does not fire', () => {
    const agg = makeAggregate({
      earlyWindowBuyerCount: 20,
      smartWalletCount: 44,
      mcapExpansionFromAvgEntry: 2.1,
      trackedBuyVolumeUsd: 100000,
      trackedSellVolumeUsd: 20000
    });

    const result = ruleB(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('missing earlyWindowBuyerCount -> cannot evaluate growth -> does not fire', () => {
    const agg = makeAggregate({
      earlyWindowBuyerCount: undefined,
      smartWalletCount: 44,
      mcapExpansionFromAvgEntry: 1.6,
      trackedBuyVolumeUsd: 100000,
      trackedSellVolumeUsd: 20000
    });

    const result = ruleB(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('null earlyWindowBuyerCount -> cannot evaluate growth -> does not fire', () => {
    const agg = makeAggregate({
      earlyWindowBuyerCount: null as unknown as undefined,
      smartWalletCount: 44,
      mcapExpansionFromAvgEntry: 1.6,
      trackedBuyVolumeUsd: 100000,
      trackedSellVolumeUsd: 20000
    });

    const result = ruleB(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('earlyWindowBuyerCount below baseWallets (20) -> does not fire', () => {
    const agg = makeAggregate({
      earlyWindowBuyerCount: 10,
      smartWalletCount: 44,
      mcapExpansionFromAvgEntry: 1.6,
      trackedBuyVolumeUsd: 100000,
      trackedSellVolumeUsd: 20000
    });

    const result = ruleB(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('sell-to-buy pct above maxSellToBuyPct (25%) -> does not fire', () => {
    const agg = makeAggregate({
      earlyWindowBuyerCount: 20,
      smartWalletCount: 44,
      mcapExpansionFromAvgEntry: 1.6,
      trackedBuyVolumeUsd: 100000,
      trackedSellVolumeUsd: 30000 // 30% > 25%
    });

    const result = ruleB(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('non-fired result has severity that is not HIGH/CRITICAL', () => {
    const agg = makeAggregate({ earlyWindowBuyerCount: undefined, smartWalletCount: 5 });
    const result = ruleB(agg, DEFAULT_SETTINGS);

    expect(['INFO', 'WATCH']).toContain(result.severity);
  });
});
