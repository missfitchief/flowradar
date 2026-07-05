import { describe, expect, it } from 'vitest';
import { computeWalletScore } from '../src/scoring/walletScore';

describe('computeWalletScore', () => {
  it('strong fixture scores >75 (expected ~86)', () => {
    const result = computeWalletScore({
      pnl30d: 20000,
      winRate: 0.7,
      tradeCount: 40,
      humanLikelihood: 0.9,
      entryQuality: 0.8,
      holdingQuality: 0.7,
      recentPerf: 0.8,
      botLikelihood: 0,
      pnlConfidence: 90
    });

    expect(result.score).toBeGreaterThan(75);
    expect(result.score).toBeCloseTo(86, 0);
  });

  it('components sum sanity: pre-penalty positive components sum matches score / confidenceMultiplier + penalty', () => {
    const s = {
      pnl30d: 20000,
      winRate: 0.7,
      tradeCount: 40,
      humanLikelihood: 0.9,
      entryQuality: 0.8,
      holdingQuality: 0.7,
      recentPerf: 0.8,
      botLikelihood: 0,
      pnlConfidence: 90
    };
    const result = computeWalletScore(s);
    const c = result.components;

    const positiveSum =
      c.pnl + c.winRate + c.tradeCount + c.human + c.entryQuality + c.holding + c.recentPerf;
    const preMultiplier = positiveSum - c.botPenalty;
    const expectedScore = Math.min(100, Math.max(0, preMultiplier * c.confidenceMultiplier));

    expect(result.score).toBeCloseTo(expectedScore, 5);
    expect(c.botPenalty).toBe(0);
    expect(c.confidenceMultiplier).toBeCloseTo(0.95, 5);
  });

  it('botLikelihood 1 subtracts 30 pre-multiplier', () => {
    const base = {
      pnl30d: 20000,
      winRate: 0.7,
      tradeCount: 40,
      humanLikelihood: 0.9,
      entryQuality: 0.8,
      holdingQuality: 0.7,
      recentPerf: 0.8,
      pnlConfidence: 90
    };
    const noBot = computeWalletScore({ ...base, botLikelihood: 0 });
    const fullBot = computeWalletScore({ ...base, botLikelihood: 1 });

    expect(fullBot.components.botPenalty).toBe(30);
    // difference pre-multiplier is exactly 30; post-multiplier it's 30 * confidenceMultiplier
    const multiplier = noBot.components.confidenceMultiplier;
    expect(noBot.score - fullBot.score).toBeCloseTo(30 * multiplier, 5);
  });

  it('pnlConfidence 0 gives confidenceMultiplier 0.5', () => {
    const result = computeWalletScore({
      pnl30d: 20000,
      winRate: 0.7,
      tradeCount: 40,
      humanLikelihood: 0.9,
      entryQuality: 0.8,
      holdingQuality: 0.7,
      recentPerf: 0.8,
      botLikelihood: 0,
      pnlConfidence: 0
    });

    expect(result.components.confidenceMultiplier).toBeCloseTo(0.5, 5);
  });

  it('all-max inputs clamp to <= 100', () => {
    const result = computeWalletScore({
      pnl30d: 1_000_000,
      winRate: 1,
      tradeCount: 1000,
      humanLikelihood: 1,
      entryQuality: 1,
      holdingQuality: 1,
      recentPerf: 1,
      botLikelihood: 0,
      pnlConfidence: 100
    });

    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeCloseTo(100, 5);
  });

  it('all-zero inputs give score 0', () => {
    const result = computeWalletScore({
      pnl30d: 0,
      winRate: 0,
      tradeCount: 0,
      humanLikelihood: 0,
      entryQuality: 0,
      holdingQuality: 0,
      recentPerf: 0,
      botLikelihood: 0,
      pnlConfidence: 0
    });

    expect(result.score).toBe(0);
  });
});
