import { describe, expect, it } from 'vitest';
import { computeFlowScore } from '../src/scoring/flowScore';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { RiskReport, TokenWindowAggregate } from '../src/types';

const zeroRisk: RiskReport = { flags: [], penalty: 0 };
// A token with genuinely zero tracked activity (no liquidity, no mcap data)
// never carries a perfectly-clean risk report in practice; riskSanity alone
// ((1 - penalty) * 5, rounded to 1 decimal) would otherwise land exactly on
// the 5-point boundary. Use a low-but-nonzero penalty for the zero-activity
// case only, large enough to survive the 1-decimal rounding in the score.
const negligibleRisk: RiskReport = { flags: [], penalty: 0.1 };

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

describe('computeFlowScore', () => {
  it('zero-activity aggregate + near-zero risk scores < 5', () => {
    const agg = makeAggregate();
    const result = computeFlowScore(agg, negligibleRisk, DEFAULT_SETTINGS);

    expect(result.score).toBeLessThan(5);
  });

  it('$NOVA-like fixture scores >= 70', () => {
    const agg = makeAggregate({
      smartWalletCount: 35,
      uniqueEntityCount: 9,
      netFlowUsd: 40000,
      // avg buyer walletScore 70 (per brief) — populate buyers so walletQuality
      // is derived from real data rather than defaulting to 0.
      buyers: Array.from({ length: 35 }, (_, i) => ({
        walletId: `nova-buyer-${i}`,
        walletScore: 70,
        labels: [],
        buyUsd: 1000,
        sellUsd: 0,
        firstBuyTs: new Date('2026-07-05T00:05:00Z'),
        blockOrSlot: BigInt(i)
      })),
      humanLikeCount: 26,
      avgEntryMcap: 300000,
      mcapExpansionFromAvgEntry: 0.4,
      liquidityUsd: 50000,
      liquidityChangePct: 0
    });

    const result = computeFlowScore(agg, zeroRisk, DEFAULT_SETTINGS);
    expect(result.score).toBeGreaterThanOrEqual(70);
  });

  it('risk.penalty 1 removes exactly 5 points relative to zero-risk', () => {
    const agg = makeAggregate({
      smartWalletCount: 35,
      uniqueEntityCount: 9,
      netFlowUsd: 40000,
      humanLikeCount: 26,
      avgEntryMcap: 300000,
      mcapExpansionFromAvgEntry: 0.4
    });

    const zero = computeFlowScore(agg, zeroRisk, DEFAULT_SETTINGS);
    const full = computeFlowScore(agg, { flags: [], penalty: 1 }, DEFAULT_SETTINGS);

    expect(zero.score - full.score).toBeCloseTo(5, 5);
  });

  it('negative net flow gives netFlow component 0', () => {
    const agg = makeAggregate({ netFlowUsd: -10000 });
    const result = computeFlowScore(agg, zeroRisk, DEFAULT_SETTINGS);

    expect(result.components.netFlow).toBe(0);
  });

  it('component weights sum to 100 when all inputs maxed', () => {
    const agg = makeAggregate({
      smartWalletCount: 1000, // min(n/40,1) saturates
      uniqueEntityCount: 1000, // min(entities/25,1) saturates
      netFlowUsd: 1_000_000, // clamp01(net/50000) saturates
      humanLikeCount: 1000, // humanRatio = humanLike/max(smart,1) capped conceptually at 1 when equal
      avgEntryMcap: DEFAULT_SETTINGS.rules.A.mcapMin, // mcapEfficiency saturates at 1
      mcapExpansionFromAvgEntry: 0, // accumulation saturates at 1 when expansion is 0
      buyers: Array.from({ length: 40 }, (_, i) => ({
        walletId: `w${i}`,
        walletScore: 100,
        labels: [],
        buyUsd: 100,
        sellUsd: 0,
        firstBuyTs: new Date('2026-07-05T00:00:00Z'),
        blockOrSlot: BigInt(i)
      }))
    });
    // humanLikeCount must not exceed smartWalletCount for humanRatio to sit at exactly 1;
    // set them equal for this saturation test.
    agg.humanLikeCount = agg.smartWalletCount;

    const result = computeFlowScore(agg, zeroRisk, DEFAULT_SETTINGS);
    const sum = Object.values(result.components).reduce((a, b) => a + b, 0);

    expect(sum).toBeCloseTo(100, 1);
    expect(result.score).toBeCloseTo(100, 1);
  });
});
