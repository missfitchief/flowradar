// FlowRadar — canonical isProfitableWallet.
//
// Normative source: Task 13 brief note 6 + existing local copy in
// packages/db/src/scoring-pass.ts (field names/shape match exactly; that
// consumer keeps its own copy until Task 15 consolidates call sites onto
// this canonical implementation).
//
// 5 conditions, ALL must hold (every comparison is >=):
//   stats.pnlUsd          >= thresholds.pnl30d
//   stats.tradeCount       >= thresholds.minTrades
//   stats.winRate          >= thresholds.minWinRate
//   stats.realizedPnlUsd   >= thresholds.minRealized
//   stats.avgTradeSizeUsd  >= thresholds.minAvgTradeSizeUsd

import type { Settings } from '../settings';

export interface WalletProfitabilityStats {
  pnlUsd: number;
  realizedPnlUsd: number;
  winRate: number;
  tradeCount: number;
  avgTradeSizeUsd: number;
}

export function isProfitableWallet(
  stats: WalletProfitabilityStats,
  thresholds: Settings['profitableWallet']
): boolean {
  return (
    stats.pnlUsd >= thresholds.pnl30d &&
    stats.tradeCount >= thresholds.minTrades &&
    stats.winRate >= thresholds.minWinRate &&
    stats.realizedPnlUsd >= thresholds.minRealized &&
    stats.avgTradeSizeUsd >= thresholds.minAvgTradeSizeUsd
  );
}
