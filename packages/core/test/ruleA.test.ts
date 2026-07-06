import { describe, expect, it } from 'vitest';
import { ruleA } from '../src/rules/ruleA';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { TokenWindowAggregate } from '../src/types';

// Rule A is TIERED (scope correction, see progress.md):
//   count = agg.smartWalletCount (buyers who are watched OR profitable)
//   count >= rules.A.watchMinWallets (10)                          -> WATCH
//   count >= rules.A.minWallets (20) AND every HIGH condition holds -> HIGH
//   count <  rules.A.watchMinWallets (10)                          -> not fired
//
// HIGH conditions (all must hold, on top of count >= minWallets):
//   buyVol >= minBuyVolumeUsd (25000)
//   netFlow > 0
//   soldPct < maxSoldPct (30)              [soldPct = % of buyers with sellUsd > 0]
//   mcap in [mcapMin, mcapMax] = [100000, 5000000]
//   liq >= minLiquidityUsd (20000)
//   tokenAgeDays < maxTokenAgeDays (7) OR inflowSpike

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

/** A fixture that satisfies every single HIGH-tier condition at smartWalletCount 20. */
function makeAllHighConditionsAggregate(smartWalletCount: number): TokenWindowAggregate {
  // Create 20 buyers: 4 with sellUsd > 0 (20% sold) < maxSoldPct (30)
  const buyers = Array.from({ length: 20 }, (_, i) => ({
    walletId: `w${i}`,
    walletScore: 60,
    labels: [],
    buyUsd: 1500,
    sellUsd: i < 4 ? 150 : 0, // First 4 have sold; rest have not
    firstBuyTs: new Date('2026-07-05T00:05:00Z'),
    blockOrSlot: BigInt(i),
    isWatched: false
  }));

  return makeAggregate({
    smartWalletCount,
    buyers,
    trackedBuyVolumeUsd: 30000, // >= minBuyVolumeUsd (25000)
    trackedSellVolumeUsd: 600, // realistic but load-bearing for rule A
    netFlowUsd: 29400, // > 0
    currentMcap: 2000000, // within [100000, 5000000]
    liquidityUsd: 50000, // >= minLiquidityUsd (20000)
    tokenAgeDays: 2, // < maxTokenAgeDays (7)
    inflowSpike: false
  });
}

describe('ruleA (tiered)', () => {
  it('9 wallets -> not fired (below watchMinWallets)', () => {
    const agg = makeAllHighConditionsAggregate(9);
    const result = ruleA(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('12 wallets -> fires WATCH (above watchMinWallets, below minWallets)', () => {
    const agg = makeAllHighConditionsAggregate(12);
    const result = ruleA(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.severity).toBe('WATCH');
  });

  it('19 wallets meeting every HIGH condition -> still WATCH (count below minWallets=20)', () => {
    const agg = makeAllHighConditionsAggregate(19);
    const result = ruleA(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.severity).toBe('WATCH');
  });

  it('20 wallets + $24k buy volume -> WATCH not HIGH (volume below minBuyVolumeUsd=25000)', () => {
    const agg = makeAllHighConditionsAggregate(20);
    agg.trackedBuyVolumeUsd = 24000;
    agg.netFlowUsd = 24000 - agg.trackedSellVolumeUsd;

    const result = ruleA(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.severity).toBe('WATCH');
  });

  it('20 wallets + all HIGH conditions -> HIGH', () => {
    const agg = makeAllHighConditionsAggregate(20);
    const result = ruleA(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.severity).toBe('HIGH');
  });

  it('35% of buyers have sold -> WATCH not HIGH (soldPct above maxSoldPct=30)', () => {
    const agg = makeAllHighConditionsAggregate(20);
    // Modify buyers: 7 out of 20 with sellUsd > 0 = 35% > maxSoldPct (30)
    for (let i = 0; i < agg.buyers.length; i++) {
      agg.buyers[i].sellUsd = i < 7 ? 150 : 0;
    }

    const result = ruleA(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.severity).toBe('WATCH');
  });

  it('mcap $6M -> WATCH not HIGH (outside [mcapMin, mcapMax]=[100000,5000000])', () => {
    const agg = makeAllHighConditionsAggregate(20);
    agg.currentMcap = 6_000_000;

    const result = ruleA(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.severity).toBe('WATCH');
  });

  it('below watchMinWallets never fires regardless of other HIGH-tier conditions', () => {
    const agg = makeAllHighConditionsAggregate(5);
    const result = ruleA(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('HIGH tier: tokenAgeDays >= maxTokenAgeDays but inflowSpike true still satisfies the age-OR-spike condition', () => {
    const agg = makeAllHighConditionsAggregate(20);
    agg.tokenAgeDays = 30; // >= maxTokenAgeDays (7)
    agg.inflowSpike = true; // OR-branch satisfied

    const result = ruleA(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.severity).toBe('HIGH');
  });

  it('HIGH tier: tokenAgeDays >= maxTokenAgeDays and no inflowSpike -> WATCH not HIGH', () => {
    const agg = makeAllHighConditionsAggregate(20);
    agg.tokenAgeDays = 30;
    agg.inflowSpike = false;

    const result = ruleA(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.severity).toBe('WATCH');
  });

  it('metrics include rawWalletCount, uniqueEntityCount, largestClusterSize, and the volume/mcap inputs used', () => {
    const agg = makeAllHighConditionsAggregate(20);
    agg.uniqueEntityCount = 15;
    agg.largestClusterSize = 3;

    const result = ruleA(agg, DEFAULT_SETTINGS);

    expect(result.metrics.rawWalletCount).toBe(20);
    expect(result.metrics.uniqueEntityCount).toBe(15);
    expect(result.metrics.largestClusterSize).toBe(3);
    expect(result.metrics.buyVolumeUsd).toBe(agg.trackedBuyVolumeUsd);
    expect(result.metrics.mcapUsd).toBe(agg.currentMcap);
    expect(typeof result.reasons[0]).toBe('string');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('WATCH-tier reasons mention the tier explicitly', () => {
    const agg = makeAllHighConditionsAggregate(12);
    const result = ruleA(agg, DEFAULT_SETTINGS);

    expect(result.reasons.some((r) => /watch/i.test(r))).toBe(true);
  });

  it('not-fired result still returns rule "A" and severity is not HIGH/CRITICAL', () => {
    const agg = makeAllHighConditionsAggregate(3);
    const result = ruleA(agg, DEFAULT_SETTINGS);

    expect(result.rule).toBe('A');
    expect(result.fired).toBe(false);
    expect(['INFO', 'WATCH']).toContain(result.severity);
  });
});
