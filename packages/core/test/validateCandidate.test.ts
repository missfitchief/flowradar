import { describe, expect, it } from 'vitest';
import { evaluateCandidate } from '../src/candidates/validate';
import { DEFAULT_SETTINGS } from '../src/settings';

// evaluateCandidate fixture matrix (Task 35 binding decision 1). Thresholds
// come from DEFAULT_SETTINGS.profitableWallet: pnl30d 4000, minTrades 8,
// minWinRate 0.35, minRealized 1000, minAvgTradeSizeUsd 50.

const settings = DEFAULT_SETTINGS;

function goodComputedPnl(overrides: Partial<NonNullable<Parameters<typeof evaluateCandidate>[0]['evidence']['computedPnl']>> = {}) {
  return {
    pnl30d: 8000,
    realizedPnlUsd: 5000,
    winRate: 0.5,
    tradeCount: 20,
    avgTradeSizeUsd: 200,
    confidence: 85,
    ...overrides
  };
}

describe('evaluateCandidate', () => {
  it('promotes a candidate whose computed PnL clears every threshold', () => {
    const result = evaluateCandidate({
      candidate: { claimedPnlUsd: 8500, claimedWinRate: 0.52, claimedTradeCount: 22, claimedRoi: 1.5 },
      evidence: { computedPnl: goodComputedPnl(), registryCategory: null, labels: [] },
      settings
    });

    expect(result.verdict).toBe('promote');
    expect(result.confidence).toBeGreaterThan(50);
    expect(result.reason).toBeTruthy();
  });

  // -- AUTO-REJECT: registry category ---------------------------------------

  for (const category of ['CEX', 'ROUTER', 'POOL', 'BRIDGE', 'MIXER'] as const) {
    it(`auto-rejects a ${category} registry-tagged address regardless of computed PnL`, () => {
      const result = evaluateCandidate({
        candidate: { claimedPnlUsd: 50000, claimedWinRate: 0.7, claimedTradeCount: 40, claimedRoi: 3 },
        evidence: { computedPnl: goodComputedPnl(), registryCategory: category, labels: [] },
        settings
      });

      expect(result.verdict).toBe('reject');
      expect(result.reason).toContain('excluded service address');
      expect(result.reason).toContain(category);
    });
  }

  it('does NOT auto-reject a DEPLOYER/TOKEN_CONTRACT-tagged address (not in the excluded set)', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: { computedPnl: goodComputedPnl(), registryCategory: 'DEPLOYER', labels: [] },
      settings
    });
    expect(result.verdict).toBe('promote');
  });

  // -- AUTO-REJECT: bot/sniper labels ----------------------------------------

  it('auto-rejects a possible_bot-labeled address regardless of computed PnL', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: { computedPnl: goodComputedPnl(), registryCategory: null, labels: ['possible_bot'] },
      settings
    });
    expect(result.verdict).toBe('reject');
    expect(result.reason).toContain('bot/sniper-dominant');
  });

  it('auto-rejects an mev-labeled address regardless of computed PnL', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: { computedPnl: goodComputedPnl(), registryCategory: null, labels: ['mev'] },
      settings
    });
    expect(result.verdict).toBe('reject');
    expect(result.reason).toContain('bot/sniper-dominant');
  });

  it('auto-rejects a sniper label with no offsetting human_like/smart_money label', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: { computedPnl: goodComputedPnl(), registryCategory: null, labels: ['sniper'] },
      settings
    });
    expect(result.verdict).toBe('reject');
    expect(result.reason).toContain('bot/sniper-dominant');
  });

  it('does NOT auto-reject a sniper label when offset by human_like', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: { computedPnl: goodComputedPnl(), registryCategory: null, labels: ['sniper', 'human_like'] },
      settings
    });
    expect(result.verdict).toBe('promote');
  });

  it('does NOT auto-reject a sniper label when offset by smart_money', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: { computedPnl: goodComputedPnl(), registryCategory: null, labels: ['sniper', 'smart_money'] },
      settings
    });
    expect(result.verdict).toBe('promote');
  });

  // -- EVIDENCE GATE: no computedPnl ever means 'insufficient', never promote on claims alone --

  it('is insufficient (stays pending) when there is no computed PnL evidence at all, even with strong claims', () => {
    const result = evaluateCandidate({
      candidate: { claimedPnlUsd: 999999, claimedWinRate: 0.95, claimedTradeCount: 500, claimedRoi: 20 },
      evidence: { registryCategory: null, labels: [] },
      settings
    });
    expect(result.verdict).toBe('insufficient');
    expect(result.reason).toBeTruthy();
  });

  it('is insufficient even when registryCategory/labels are also absent (truly no evidence)', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: {},
      settings
    });
    expect(result.verdict).toBe('insufficient');
  });

  // -- THRESHOLD GATE: each miss rejects individually ------------------------

  it('rejects when computed pnl30d is below the threshold', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: { computedPnl: goodComputedPnl({ pnl30d: settings.profitableWallet.pnl30d - 1 }), registryCategory: null, labels: [] },
      settings
    });
    expect(result.verdict).toBe('reject');
    expect(result.reason).toContain('below thresholds');
    expect(result.reason).toContain('pnl30d');
  });

  it('rejects when computed tradeCount is below the threshold', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: { computedPnl: goodComputedPnl({ tradeCount: settings.profitableWallet.minTrades - 1 }), registryCategory: null, labels: [] },
      settings
    });
    expect(result.verdict).toBe('reject');
    expect(result.reason).toContain('below thresholds');
    expect(result.reason).toContain('tradeCount');
  });

  it('rejects when computed winRate is below the threshold', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: { computedPnl: goodComputedPnl({ winRate: settings.profitableWallet.minWinRate - 0.01 }), registryCategory: null, labels: [] },
      settings
    });
    expect(result.verdict).toBe('reject');
    expect(result.reason).toContain('below thresholds');
    expect(result.reason).toContain('winRate');
  });

  it('rejects when computed realizedPnlUsd is below the threshold', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: { computedPnl: goodComputedPnl({ realizedPnlUsd: settings.profitableWallet.minRealized - 1 }), registryCategory: null, labels: [] },
      settings
    });
    expect(result.verdict).toBe('reject');
    expect(result.reason).toContain('below thresholds');
    expect(result.reason).toContain('realizedPnlUsd');
  });

  it('rejects when computed avgTradeSizeUsd is below the threshold', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: {
        computedPnl: goodComputedPnl({ avgTradeSizeUsd: settings.profitableWallet.minAvgTradeSizeUsd - 1 }),
        registryCategory: null,
        labels: []
      },
      settings
    });
    expect(result.verdict).toBe('reject');
    expect(result.reason).toContain('below thresholds');
    expect(result.reason).toContain('avgTradeSizeUsd');
  });

  it('rejects and reports every failing threshold when multiple miss simultaneously', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: {
        computedPnl: {
          pnl30d: 100,
          realizedPnlUsd: 50,
          winRate: 0.1,
          tradeCount: 1,
          avgTradeSizeUsd: 5,
          confidence: 80
        },
        registryCategory: null,
        labels: []
      },
      settings
    });
    expect(result.verdict).toBe('reject');
    expect(result.reason).toContain('pnl30d');
    expect(result.reason).toContain('tradeCount');
    expect(result.reason).toContain('winRate');
    expect(result.reason).toContain('realizedPnlUsd');
    expect(result.reason).toContain('avgTradeSizeUsd');
  });

  it('passes at exactly-at-threshold values (all comparisons are >=)', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: {
        computedPnl: {
          pnl30d: settings.profitableWallet.pnl30d,
          realizedPnlUsd: settings.profitableWallet.minRealized,
          winRate: settings.profitableWallet.minWinRate,
          tradeCount: settings.profitableWallet.minTrades,
          avgTradeSizeUsd: settings.profitableWallet.minAvgTradeSizeUsd,
          confidence: 70
        },
        registryCategory: null,
        labels: []
      },
      settings
    });
    expect(result.verdict).toBe('promote');
  });

  // -- confidence blending ----------------------------------------------------

  it('over-claiming (claims wildly above computed) lowers confidence even though it still promotes', () => {
    const honest = evaluateCandidate({
      candidate: { claimedPnlUsd: 8500, claimedWinRate: 0.52, claimedTradeCount: 22, claimedRoi: 1.5 },
      evidence: { computedPnl: goodComputedPnl(), registryCategory: null, labels: [] },
      settings
    });

    const overClaimed = evaluateCandidate({
      candidate: { claimedPnlUsd: 500000, claimedWinRate: 0.99, claimedTradeCount: 900, claimedRoi: 50 },
      evidence: { computedPnl: goodComputedPnl(), registryCategory: null, labels: [] },
      settings
    });

    expect(overClaimed.verdict).toBe('promote');
    expect(overClaimed.confidence).toBeLessThan(honest.confidence);
  });

  it('claims within 2x of computed keep confidence high (agreement)', () => {
    const result = evaluateCandidate({
      candidate: { claimedPnlUsd: 9000, claimedWinRate: 0.55, claimedTradeCount: 25, claimedRoi: 1.8 },
      evidence: { computedPnl: goodComputedPnl(), registryCategory: null, labels: [] },
      settings
    });
    expect(result.verdict).toBe('promote');
    expect(result.confidence).toBeGreaterThanOrEqual(70);
  });

  it('no claims at all (evidence-only) still produces a defined confidence and promotes', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: { computedPnl: goodComputedPnl(), registryCategory: null, labels: [] },
      settings
    });
    expect(result.verdict).toBe('promote');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
  });

  it('low evidence.confidence pulls down the final confidence even when verdict is promote', () => {
    const highEvidenceConfidence = evaluateCandidate({
      candidate: {},
      evidence: { computedPnl: goodComputedPnl({ confidence: 90 }), registryCategory: null, labels: [] },
      settings
    });
    const lowEvidenceConfidence = evaluateCandidate({
      candidate: {},
      evidence: { computedPnl: goodComputedPnl({ confidence: 20 }), registryCategory: null, labels: [] },
      settings
    });
    expect(lowEvidenceConfidence.confidence).toBeLessThan(highEvidenceConfidence.confidence);
  });

  it('confidence is always clamped to [0, 100]', () => {
    const result = evaluateCandidate({
      candidate: { claimedPnlUsd: 10_000_000, claimedWinRate: 1, claimedTradeCount: 100000, claimedRoi: 1000 },
      evidence: { computedPnl: goodComputedPnl({ confidence: 10 }), registryCategory: null, labels: [] },
      settings
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
  });

  it('registry rejection confidence is high (rejection is certain, not a soft signal)', () => {
    const result = evaluateCandidate({
      candidate: { claimedPnlUsd: 50000 },
      evidence: { registryCategory: 'CEX', labels: [] },
      settings
    });
    expect(result.verdict).toBe('reject');
    expect(result.confidence).toBeGreaterThanOrEqual(80);
  });

  it('bot-label rejection confidence is high (rejection is certain, not a soft signal)', () => {
    const result = evaluateCandidate({
      candidate: {},
      evidence: { registryCategory: null, labels: ['possible_bot'] },
      settings
    });
    expect(result.verdict).toBe('reject');
    expect(result.confidence).toBeGreaterThanOrEqual(80);
  });
});
