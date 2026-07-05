import { describe, expect, it } from 'vitest';
import { isProfitableWallet } from '../src/wallets/profitability';
import { DEFAULT_SETTINGS } from '../src/settings';

// Canonical isProfitableWallet: 5 conditions, all >=, against
// Settings['profitableWallet'] thresholds (pnl30d 4000, minTrades 8,
// minWinRate 0.35, minRealized 1000, minAvgTradeSizeUsd 50 by default).

const thresholds = DEFAULT_SETTINGS.profitableWallet;

function makePassingStats() {
  return {
    pnlUsd: 5000,
    realizedPnlUsd: 1500,
    winRate: 0.4,
    tradeCount: 10,
    avgTradeSizeUsd: 75
  };
}

describe('isProfitableWallet', () => {
  it('passes when every threshold is met', () => {
    expect(isProfitableWallet(makePassingStats(), thresholds)).toBe(true);
  });

  it('passes when every value sits exactly at its threshold (all conditions are >=)', () => {
    const exact = {
      pnlUsd: thresholds.pnl30d,
      realizedPnlUsd: thresholds.minRealized,
      winRate: thresholds.minWinRate,
      tradeCount: thresholds.minTrades,
      avgTradeSizeUsd: thresholds.minAvgTradeSizeUsd
    };

    expect(isProfitableWallet(exact, thresholds)).toBe(true);
  });

  it('fails when pnlUsd is below pnl30d threshold', () => {
    const stats = { ...makePassingStats(), pnlUsd: thresholds.pnl30d - 1 };
    expect(isProfitableWallet(stats, thresholds)).toBe(false);
  });

  it('fails when realizedPnlUsd is below minRealized threshold', () => {
    const stats = { ...makePassingStats(), realizedPnlUsd: thresholds.minRealized - 1 };
    expect(isProfitableWallet(stats, thresholds)).toBe(false);
  });

  it('fails when winRate is below minWinRate threshold', () => {
    const stats = { ...makePassingStats(), winRate: thresholds.minWinRate - 0.01 };
    expect(isProfitableWallet(stats, thresholds)).toBe(false);
  });

  it('fails when tradeCount is below minTrades threshold', () => {
    const stats = { ...makePassingStats(), tradeCount: thresholds.minTrades - 1 };
    expect(isProfitableWallet(stats, thresholds)).toBe(false);
  });

  it('fails when avgTradeSizeUsd is below minAvgTradeSizeUsd threshold', () => {
    const stats = { ...makePassingStats(), avgTradeSizeUsd: thresholds.minAvgTradeSizeUsd - 1 };
    expect(isProfitableWallet(stats, thresholds)).toBe(false);
  });

  it('fails when every condition misses simultaneously', () => {
    const stats = {
      pnlUsd: 0,
      realizedPnlUsd: 0,
      winRate: 0,
      tradeCount: 0,
      avgTradeSizeUsd: 0
    };
    expect(isProfitableWallet(stats, thresholds)).toBe(false);
  });
});
