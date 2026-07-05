import { describe, expect, it } from 'vitest';
import { ruleG } from '../src/rules/ruleG';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { TokenWindowAggregate } from '../src/types';

// Rule G: exit-warning (24h context, CRITICAL). Fires when ANY of 4 disjuncts:
//   (a) agg.exitedSmartPct >= G.minExitedPct (30)
//   (b) agg.netFlowUsd < 0 AND agg.topHolderExits >= 3
//   (c) agg.liquidityChangePct <= -G.liquidityDropPct (30)   [signed field]
//   (d) agg.mcapExpansionFromAvgEntry >= G.mcapPumpPct/100 (1.0)
//         AND agg.newSmartBuyers < G.maxNewSmartBuyers (3)

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
    newSmartBuyers: 0
  };
  return { ...base, ...overrides };
}

describe('ruleG', () => {
  it('none of the 4 triggers -> does not fire', () => {
    const agg = makeAggregate({
      exitedSmartPct: 5,
      netFlowUsd: 1000,
      topHolderExits: 0,
      liquidityChangePct: 5,
      mcapExpansionFromAvgEntry: 0.5,
      newSmartBuyers: 10
    });

    const result = ruleG(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
    expect(result.rule).toBe('G');
  });

  describe('trigger (a): exitedSmartPct >= minExitedPct', () => {
    it('exitedSmartPct 35% (>= 30 floor) with all other triggers clean -> fires CRITICAL', () => {
      const agg = makeAggregate({
        exitedSmartPct: 35,
        netFlowUsd: 1000,
        topHolderExits: 0,
        liquidityChangePct: 5,
        mcapExpansionFromAvgEntry: 0.5,
        newSmartBuyers: 10
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(true);
      expect(result.severity).toBe('CRITICAL');
      expect(result.reasons.some((r) => /exited/i.test(r))).toBe(true);
    });

    it('boundary: exitedSmartPct exactly 30 fires', () => {
      const agg = makeAggregate({
        exitedSmartPct: 30,
        netFlowUsd: 1000,
        topHolderExits: 0,
        liquidityChangePct: 5,
        mcapExpansionFromAvgEntry: 0.5,
        newSmartBuyers: 10
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(true);
    });

    it('exitedSmartPct 29% (below floor) with all other triggers clean -> does not fire', () => {
      const agg = makeAggregate({
        exitedSmartPct: 29,
        netFlowUsd: 1000,
        topHolderExits: 0,
        liquidityChangePct: 5,
        mcapExpansionFromAvgEntry: 0.5,
        newSmartBuyers: 10
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(false);
    });
  });

  describe('trigger (b): netFlowUsd < 0 AND topHolderExits >= 3', () => {
    it('negative net flow + 3 top-holder exits, all other triggers clean -> fires CRITICAL', () => {
      const agg = makeAggregate({
        exitedSmartPct: 5,
        netFlowUsd: -500,
        topHolderExits: 3,
        liquidityChangePct: 5,
        mcapExpansionFromAvgEntry: 0.5,
        newSmartBuyers: 10
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(true);
      expect(result.severity).toBe('CRITICAL');
      expect(result.reasons.some((r) => /net flow|holder exit/i.test(r))).toBe(true);
    });

    it('negative net flow but only 2 top-holder exits -> does not fire', () => {
      const agg = makeAggregate({
        exitedSmartPct: 5,
        netFlowUsd: -500,
        topHolderExits: 2,
        liquidityChangePct: 5,
        mcapExpansionFromAvgEntry: 0.5,
        newSmartBuyers: 10
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(false);
    });

    it('3 top-holder exits but net flow positive -> does not fire', () => {
      const agg = makeAggregate({
        exitedSmartPct: 5,
        netFlowUsd: 500,
        topHolderExits: 3,
        liquidityChangePct: 5,
        mcapExpansionFromAvgEntry: 0.5,
        newSmartBuyers: 10
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(false);
    });
  });

  describe('trigger (c): liquidityChangePct <= -liquidityDropPct', () => {
    it('liquidity dropped 35% (<= -30 floor), all other triggers clean -> fires CRITICAL', () => {
      const agg = makeAggregate({
        exitedSmartPct: 5,
        netFlowUsd: 1000,
        topHolderExits: 0,
        liquidityChangePct: -35,
        mcapExpansionFromAvgEntry: 0.5,
        newSmartBuyers: 10
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(true);
      expect(result.severity).toBe('CRITICAL');
      expect(result.reasons.some((r) => /liquidity/i.test(r))).toBe(true);
    });

    it('boundary: liquidityChangePct exactly -30 fires', () => {
      const agg = makeAggregate({
        exitedSmartPct: 5,
        netFlowUsd: 1000,
        topHolderExits: 0,
        liquidityChangePct: -30,
        mcapExpansionFromAvgEntry: 0.5,
        newSmartBuyers: 10
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(true);
    });

    it('liquidity dropped only 20% (below floor) -> does not fire', () => {
      const agg = makeAggregate({
        exitedSmartPct: 5,
        netFlowUsd: 1000,
        topHolderExits: 0,
        liquidityChangePct: -20,
        mcapExpansionFromAvgEntry: 0.5,
        newSmartBuyers: 10
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(false);
    });

    it('liquidity increased (positive pct) -> does not fire this trigger', () => {
      const agg = makeAggregate({
        exitedSmartPct: 5,
        netFlowUsd: 1000,
        topHolderExits: 0,
        liquidityChangePct: 40,
        mcapExpansionFromAvgEntry: 0.5,
        newSmartBuyers: 10
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(false);
    });

    it('null liquidityChangePct -> does not fire this trigger (unknown, not a drop)', () => {
      const agg = makeAggregate({
        exitedSmartPct: 5,
        netFlowUsd: 1000,
        topHolderExits: 0,
        liquidityChangePct: null,
        mcapExpansionFromAvgEntry: 0.5,
        newSmartBuyers: 10
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(false);
    });
  });

  describe('trigger (d): mcap pump without smart buyers', () => {
    it('mcap expanded 1.5x (>= 100% pump) with only 1 new smart buyer (< 3) -> fires CRITICAL', () => {
      const agg = makeAggregate({
        exitedSmartPct: 5,
        netFlowUsd: 1000,
        topHolderExits: 0,
        liquidityChangePct: 5,
        mcapExpansionFromAvgEntry: 1.5,
        newSmartBuyers: 1
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(true);
      expect(result.severity).toBe('CRITICAL');
      expect(result.reasons.some((r) => /mcap|pump/i.test(r))).toBe(true);
    });

    it('boundary: mcap expansion exactly 1.0 (100% pump) fires', () => {
      const agg = makeAggregate({
        exitedSmartPct: 5,
        netFlowUsd: 1000,
        topHolderExits: 0,
        liquidityChangePct: 5,
        mcapExpansionFromAvgEntry: 1.0,
        newSmartBuyers: 1
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(true);
    });

    it('mcap pumped but newSmartBuyers=3 (not < 3) -> does not fire this trigger', () => {
      const agg = makeAggregate({
        exitedSmartPct: 5,
        netFlowUsd: 1000,
        topHolderExits: 0,
        liquidityChangePct: 5,
        mcapExpansionFromAvgEntry: 1.5,
        newSmartBuyers: 3
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(false);
    });

    it('newSmartBuyers low but mcap expansion only 0.5x (below pump floor) -> does not fire', () => {
      const agg = makeAggregate({
        exitedSmartPct: 5,
        netFlowUsd: 1000,
        topHolderExits: 0,
        liquidityChangePct: 5,
        mcapExpansionFromAvgEntry: 0.5,
        newSmartBuyers: 0
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(false);
    });

    it('null mcapExpansionFromAvgEntry -> does not fire this trigger', () => {
      const agg = makeAggregate({
        exitedSmartPct: 5,
        netFlowUsd: 1000,
        topHolderExits: 0,
        liquidityChangePct: 5,
        mcapExpansionFromAvgEntry: null,
        newSmartBuyers: 0
      });

      const result = ruleG(agg, DEFAULT_SETTINGS);

      expect(result.fired).toBe(false);
    });
  });

  it('two triggers firing simultaneously ((a) + (c)) -> fires with BOTH reasons listed', () => {
    const agg = makeAggregate({
      exitedSmartPct: 35,
      netFlowUsd: 1000,
      topHolderExits: 0,
      liquidityChangePct: -35,
      mcapExpansionFromAvgEntry: 0.5,
      newSmartBuyers: 10
    });

    const result = ruleG(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.reasons.some((r) => /exited/i.test(r))).toBe(true);
    expect(result.reasons.some((r) => /liquidity/i.test(r))).toBe(true);
  });

  it('all 4 triggers firing simultaneously -> fires with all 4 reasons listed', () => {
    const agg = makeAggregate({
      exitedSmartPct: 35,
      netFlowUsd: -500,
      topHolderExits: 3,
      liquidityChangePct: -35,
      mcapExpansionFromAvgEntry: 1.5,
      newSmartBuyers: 1
    });

    const result = ruleG(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.severity).toBe('CRITICAL');
    expect(result.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it('metrics carry all four trigger inputs regardless of fired state', () => {
    const agg = makeAggregate({
      exitedSmartPct: 5,
      netFlowUsd: 1000,
      topHolderExits: 0,
      liquidityChangePct: 5,
      mcapExpansionFromAvgEntry: 0.5,
      newSmartBuyers: 10
    });

    const result = ruleG(agg, DEFAULT_SETTINGS);

    expect(result.metrics.exitedSmartPct).toBe(5);
    expect(result.metrics.netFlowUsd).toBe(1000);
    expect(result.metrics.topHolderExits).toBe(0);
    expect(result.metrics.liquidityChangePct).toBe(5);
    expect(result.metrics.mcapExpansionFromAvgEntry).toBe(0.5);
    expect(result.metrics.newSmartBuyers).toBe(10);
  });

  it('not-fired result has severity that is not CRITICAL', () => {
    const agg = makeAggregate({
      exitedSmartPct: 5,
      netFlowUsd: 1000,
      topHolderExits: 0,
      liquidityChangePct: 5,
      mcapExpansionFromAvgEntry: 0.5,
      newSmartBuyers: 10
    });

    const result = ruleG(agg, DEFAULT_SETTINGS);

    expect(result.severity).not.toBe('CRITICAL');
  });
});
