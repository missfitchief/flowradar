import { describe, expect, it } from 'vitest';
import { evaluateAllRules, firedRules } from '../src/rules/index';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { FundingEvent, RotationCandidate, TokenWindowAggregate } from '../src/types';

// evaluateAllRules(agg30, agg24h, settings, extras): RuleResult[]
//   - A, C, D, E read agg30 (the 30-min window aggregate)
//   - B, F, G read agg24h (the 24h window aggregate)
//   - E reads extras?.fundingEvents ?? []
//   - F reads extras?.rotationCandidates ?? []
//   - returns ALL 7 results (fired and not) in rule order A..G

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

describe('evaluateAllRules', () => {
  it('returns exactly 7 results in rule order A..G', () => {
    const agg30 = makeAggregate();
    const agg24h = makeAggregate({ windowMinutes: 1440 });

    const results = evaluateAllRules(agg30, agg24h, DEFAULT_SETTINGS);

    expect(results).toHaveLength(7);
    expect(results.map((r) => r.rule)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  });

  it('every result has fired/severity/reasons/metrics fields present', () => {
    const agg30 = makeAggregate();
    const agg24h = makeAggregate({ windowMinutes: 1440 });

    const results = evaluateAllRules(agg30, agg24h, DEFAULT_SETTINGS);

    for (const r of results) {
      expect(typeof r.fired).toBe('boolean');
      expect(typeof r.severity).toBe('string');
      expect(Array.isArray(r.reasons)).toBe(true);
      expect(typeof r.metrics).toBe('object');
    }
  });

  it('routes agg30 to rules A, C, D, E (distinguishable via smartWalletCount metric)', () => {
    // agg30 has smartWalletCount 42, agg24h has smartWalletCount 999 — a rule
    // reading the wrong aggregate would report 999 in its metrics instead of 42.
    const agg30 = makeAggregate({ windowMinutes: 30, smartWalletCount: 42 });
    const agg24h = makeAggregate({ windowMinutes: 1440, smartWalletCount: 999 });

    const results = evaluateAllRules(agg30, agg24h, DEFAULT_SETTINGS);
    const byRule = Object.fromEntries(results.map((r) => [r.rule, r]));

    // Rule A metrics.rawWalletCount === agg.smartWalletCount
    expect(byRule.A.metrics.rawWalletCount).toBe(42);
    // Rule D metrics.smartWalletCount === agg.smartWalletCount
    expect(byRule.D.metrics.smartWalletCount).toBe(42);
  });

  it('routes agg24h to rules B, F, G (distinguishable via smartWalletCount/exitedSmartPct metric)', () => {
    const agg30 = makeAggregate({ windowMinutes: 30, smartWalletCount: 42, exitedSmartPct: 1 });
    const agg24h = makeAggregate({ windowMinutes: 1440, smartWalletCount: 999, exitedSmartPct: 77 });

    const results = evaluateAllRules(agg30, agg24h, DEFAULT_SETTINGS);
    const byRule = Object.fromEntries(results.map((r) => [r.rule, r]));

    // Rule B metrics.smartWalletCount === agg24h.smartWalletCount
    expect(byRule.B.metrics.smartWalletCount).toBe(999);
    // Rule G metrics.exitedSmartPct === agg24h.exitedSmartPct
    expect(byRule.G.metrics.exitedSmartPct).toBe(77);
  });

  it('rule C (agg30 consumer) sees agg30, not agg24h', () => {
    const agg30buyers = [
      {
        walletId: 'w1',
        walletScore: 60,
        labels: [],
        buyUsd: 100,
        sellUsd: 0,
        firstBuyTs: new Date('2026-07-05T00:05:00Z'),
        blockOrSlot: BigInt(1),
        isWatched: false
      }
    ];
    const agg24hBuyers = [
      {
        walletId: 'w2',
        walletScore: 60,
        labels: [],
        buyUsd: 100,
        sellUsd: 0,
        firstBuyTs: new Date('2026-07-05T00:05:00Z'),
        blockOrSlot: BigInt(2),
        isWatched: false
      },
      {
        walletId: 'w3',
        walletScore: 60,
        labels: [],
        buyUsd: 100,
        sellUsd: 0,
        firstBuyTs: new Date('2026-07-05T00:05:00Z'),
        blockOrSlot: BigInt(2),
        isWatched: false
      }
    ];
    const agg30 = makeAggregate({ windowMinutes: 30, buyers: agg30buyers, humanLikeCount: 1 });
    const agg24h = makeAggregate({ windowMinutes: 1440, buyers: agg24hBuyers, humanLikeCount: 2 });

    const results = evaluateAllRules(agg30, agg24h, DEFAULT_SETTINGS);
    const ruleC = results.find((r) => r.rule === 'C')!;

    expect(ruleC.metrics.totalBuyers).toBe(1);
  });

  it('missing extras -> E and F are present in results but not fired', () => {
    const agg30 = makeAggregate();
    const agg24h = makeAggregate({ windowMinutes: 1440 });

    const results = evaluateAllRules(agg30, agg24h, DEFAULT_SETTINGS);
    const ruleE = results.find((r) => r.rule === 'E')!;
    const ruleF = results.find((r) => r.rule === 'F')!;

    expect(ruleE).toBeDefined();
    expect(ruleE.fired).toBe(false);
    expect(ruleF).toBeDefined();
    expect(ruleF.fired).toBe(false);
  });

  it('extras.fundingEvents wired to rule E only (rule F unaffected)', () => {
    const agg30 = makeAggregate({ tokenId: 'token-1' });
    const agg24h = makeAggregate({ windowMinutes: 1440, tokenId: 'token-1' });

    const fundingEvents: FundingEvent[] = [
      {
        funderWalletId: 'funder-1',
        fundedWalletId: 'funded-1',
        fundedAddressFresh: true,
        amountUsd: 1000,
        ts: new Date('2026-07-05T00:00:00Z'),
        fundedFirstBuy: {
          tokenId: 'token-1',
          usd: 600,
          ts: new Date('2026-07-05T00:47:00Z'),
          mcapAtBuy: 2_000_000
        }
      }
    ];

    const results = evaluateAllRules(agg30, agg24h, DEFAULT_SETTINGS, { fundingEvents });
    const ruleE = results.find((r) => r.rule === 'E')!;
    const ruleF = results.find((r) => r.rule === 'F')!;

    expect(ruleE.fired).toBe(true);
    expect(ruleF.fired).toBe(false);
  });

  it('extras.rotationCandidates wired to rule F only (rule E unaffected)', () => {
    const agg30 = makeAggregate({ tokenId: 'token-1' });
    const agg24h = makeAggregate({ windowMinutes: 1440, tokenId: 'token-1' });

    const transferTs = new Date('2026-07-04T12:00:00Z');
    const receiptTs = new Date(transferTs.getTime() + 4 * 60 * 60_000);
    const destBuyTs = new Date(receiptTs.getTime() + 30 * 60_000);

    const rotationCandidates: RotationCandidate[] = [
      {
        sourceWalletId: 'source-1',
        destWalletId: 'dest-1',
        sourceTokenId: 'source-token',
        destTokenId: 'token-1',
        realizedProfitUsd: 2000,
        transferredValueUsd: 10_000,
        receivedValueUsd: 9200,
        transferTs,
        receiptTs,
        destBuyTs,
        destBuyUsd: 8000,
        destTokenMcapAtBuy: 800_000,
        bridged: false,
        chainPath: ['SOLANA']
      }
    ];

    const results = evaluateAllRules(agg30, agg24h, DEFAULT_SETTINGS, { rotationCandidates });
    const ruleE = results.find((r) => r.rule === 'E')!;
    const ruleF = results.find((r) => r.rule === 'F')!;

    expect(ruleF.fired).toBe(true);
    expect(ruleE.fired).toBe(false);
  });

  describe('firedRules', () => {
    it('filters to only fired results', () => {
      const agg30 = makeAggregate({
        smartWalletCount: 25,
        trackedBuyVolumeUsd: 30000,
        trackedSellVolumeUsd: 100,
        netFlowUsd: 29900,
        currentMcap: 2_000_000,
        liquidityUsd: 50000,
        tokenAgeDays: 2,
        buyers: Array.from({ length: 25 }, (_, i) => ({
          walletId: `w${i}`,
          walletScore: 60,
          labels: [],
          buyUsd: 1200,
          sellUsd: 0,
          firstBuyTs: new Date('2026-07-05T00:05:00Z'),
          blockOrSlot: BigInt(i),
          isWatched: false
        }))
      });
      const agg24h = makeAggregate({ windowMinutes: 1440 });

      const results = evaluateAllRules(agg30, agg24h, DEFAULT_SETTINGS);
      const fired = firedRules(results);

      expect(fired.every((r) => r.fired)).toBe(true);
      expect(fired.some((r) => r.rule === 'A')).toBe(true);
      expect(fired.length).toBeLessThanOrEqual(results.length);
    });

    it('returns empty array when nothing fired', () => {
      const agg30 = makeAggregate();
      const agg24h = makeAggregate({ windowMinutes: 1440 });

      const results = evaluateAllRules(agg30, agg24h, DEFAULT_SETTINGS);
      const fired = firedRules(results);

      expect(fired).toEqual([]);
    });
  });
});
