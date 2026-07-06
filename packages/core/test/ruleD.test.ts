import { describe, expect, it } from 'vitest';
import { ruleD } from '../src/rules/ruleD';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { TokenWindowAggregate } from '../src/types';

// Rule D: whale-anchored conviction check.
//   >= 1 whale buy >= minWhaleBuyUsd (10000)      [agg.whaleBuys]
//   >= minWallets (15) profitable/smart wallets    [agg.smartWalletCount —
//     the aggregate's only wallet-quality count field; see rules/ruleD.ts]
//   buySellRatio > minBuySellRatio (3)
//   Severity contract: fired => always HIGH (D is not tiered, unlike Rule A).

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
    humanOrSmartLabelCount: 0,
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

describe('ruleD', () => {
  it('whale $12k + 16 wallets + ratio 3.5 -> fires', () => {
    const agg = makeAggregate({
      whaleBuys: [{ walletId: 'whale-1', usd: 12000 }],
      smartWalletCount: 16,
      buySellRatio: 3.5
    });

    const result = ruleD(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.rule).toBe('D');
    expect(result.severity).toBe('HIGH');
  });

  it('fired D is always HIGH severity (not tiered — no WATCH tier exists for D)', () => {
    const agg = makeAggregate({
      whaleBuys: [{ walletId: 'whale-1', usd: 50000 }],
      smartWalletCount: 100,
      buySellRatio: 20
    });

    const result = ruleD(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.severity).toBe('HIGH');
  });

  it('whale $9.9k (below minWhaleBuyUsd=10000) -> does not fire', () => {
    const agg = makeAggregate({
      whaleBuys: [{ walletId: 'whale-1', usd: 9900 }],
      smartWalletCount: 16,
      buySellRatio: 3.5
    });

    const result = ruleD(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('14 wallets (below minWallets=15) -> does not fire', () => {
    const agg = makeAggregate({
      whaleBuys: [{ walletId: 'whale-1', usd: 12000 }],
      smartWalletCount: 14,
      buySellRatio: 3.5
    });

    const result = ruleD(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('buySellRatio 2.9 (below minBuySellRatio=3) -> does not fire', () => {
    const agg = makeAggregate({
      whaleBuys: [{ walletId: 'whale-1', usd: 12000 }],
      smartWalletCount: 16,
      buySellRatio: 2.9
    });

    const result = ruleD(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('no whale buys at all -> does not fire regardless of wallet count/ratio', () => {
    const agg = makeAggregate({
      whaleBuys: [],
      smartWalletCount: 50,
      buySellRatio: 10
    });

    const result = ruleD(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('multiple whale buys, only one crossing the threshold -> still fires (>=1 condition)', () => {
    const agg = makeAggregate({
      whaleBuys: [
        { walletId: 'whale-1', usd: 5000 },
        { walletId: 'whale-2', usd: 11000 }
      ],
      smartWalletCount: 16,
      buySellRatio: 3.5
    });

    const result = ruleD(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
  });

  it('buySellRatio exactly at minBuySellRatio (3) does not fire (strictly greater required)', () => {
    const agg = makeAggregate({
      whaleBuys: [{ walletId: 'whale-1', usd: 12000 }],
      smartWalletCount: 16,
      buySellRatio: 3
    });

    const result = ruleD(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('metrics include the whale usd used, smartWalletCount, and buySellRatio', () => {
    const agg = makeAggregate({
      whaleBuys: [{ walletId: 'whale-1', usd: 12000 }],
      smartWalletCount: 16,
      buySellRatio: 3.5
    });

    const result = ruleD(agg, DEFAULT_SETTINGS);

    expect(result.metrics.maxWhaleBuyUsd).toBe(12000);
    expect(result.metrics.smartWalletCount).toBe(16);
    expect(result.metrics.buySellRatio).toBe(3.5);
  });
});
