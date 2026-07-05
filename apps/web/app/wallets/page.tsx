import { parseSettings } from '@flowradar/core';
import { prisma } from '@/lib/db';
import { LeaderboardTable } from '@/components/wallets/LeaderboardTable';
import type {
  LeaderboardChain,
  LeaderboardLabel,
  LeaderboardSource,
  WalletLeaderboardRow,
  WalletTokenPnl,
} from '@/components/wallets/LeaderboardTable';

// Displayed leaderboard rows are capped at this many, ordered by pnl desc
// (binding decision #2). The count line below still reports the true total
// tracked-wallet population, not this display cap.
const MAX_DISPLAYED_WALLETS = 200;

/**
 * Same 5-condition "profitable wallet" check as packages/db/src/scoring-pass.ts's
 * isProfitableWallet — that function isn't exported from @flowradar/db's
 * public surface (only runFlowScoringPass/buildBasicAggregate are), so it's
 * reimplemented here verbatim against settings.profitableWallet (binding
 * decision #2) rather than reaching into scoring-pass.ts's internals.
 */
function meetsProfitableThreshold(
  stats: { pnlUsd: number; realizedPnlUsd: number; winRate: number; tradeCount: number; avgTradeSizeUsd: number },
  thresholds: {
    pnl30d: number;
    minTrades: number;
    minWinRate: number;
    minRealized: number;
    minAvgTradeSizeUsd: number;
  },
): boolean {
  return (
    stats.pnlUsd >= thresholds.pnl30d &&
    stats.tradeCount >= thresholds.minTrades &&
    stats.winRate >= thresholds.minWinRate &&
    stats.realizedPnlUsd >= thresholds.minRealized &&
    stats.avgTradeSizeUsd >= thresholds.minAvgTradeSizeUsd
  );
}

/**
 * Wallet Leaderboard page (Task 10). Server component — replaces the Task-7
 * shell.
 *
 * Query shape:
 *   1. Settings row -> parseSettings -> profitableWallet thresholds.
 *   2. Every WalletStats row (small seeded dataset, ~150 rows total — same
 *      "N+1/full-table-scan is a non-issue at this size" reasoning as the
 *      Tokens page's per-token flow-score lookup), reduced in-memory to the
 *      latest row per walletId (latest-computedAt-wins semantics, matching
 *      the scoring pass's own latestStatsByWallet reduction in
 *      packages/db/src/scoring-pass.ts). Sorted pnl desc, top
 *      MAX_DISPLAYED_WALLETS wallet ids kept for the table; the *count* of
 *      wallets meeting the profitable threshold is computed over the full
 *      latest-stats population, not just the displayed slice.
 *   3. Wallet + classifications rows for exactly those displayed wallet ids.
 *   4. WalletTokenTrade rows (BUY/SELL only, same filter precedent as
 *      app/tokens/[id]/page.tsx) for those wallet ids, aggregated in-memory
 *      per (walletId, tokenId) into buyUsd/sellUsd, then reduced to a
 *      per-wallet best (max sellUsd-buyUsd) and worst (min) token.
 *
 * Every Prisma.Decimal is converted via Number(...) at this query boundary —
 * LeaderboardTable never sees a Decimal.
 */
export default async function WalletsPage() {
  const [settingsRow, totalWalletCount, allStats] = await Promise.all([
    prisma.settings.findFirst(),
    prisma.wallet.count(),
    prisma.walletStats.findMany({
      orderBy: { computedAt: 'desc' },
      select: {
        walletId: true,
        pnlUsd: true,
        realizedPnlUsd: true,
        winRate: true,
        tradeCount: true,
        avgTradeSizeUsd: true,
        walletScore: true,
        source: true,
        computedAt: true,
      },
    }),
  ]);

  const settings = parseSettings(settingsRow?.values);

  // Latest WalletStats row per wallet (rows already ordered computedAt desc,
  // so the first occurrence per walletId wins) — same reduction pattern as
  // scoring-pass.ts's latestStatsByWallet.
  interface LatestStats {
    walletId: string;
    pnlUsd: number;
    realizedPnlUsd: number;
    winRate: number;
    tradeCount: number;
    avgTradeSizeUsd: number;
    walletScore: number;
    source: LeaderboardSource;
  }
  const latestStatsByWallet = new Map<string, LatestStats>();
  for (const row of allStats) {
    if (latestStatsByWallet.has(row.walletId)) continue;
    latestStatsByWallet.set(row.walletId, {
      walletId: row.walletId,
      pnlUsd: Number(row.pnlUsd),
      realizedPnlUsd: Number(row.realizedPnlUsd),
      winRate: row.winRate,
      tradeCount: row.tradeCount,
      avgTradeSizeUsd: Number(row.avgTradeSizeUsd),
      walletScore: row.walletScore,
      source: row.source as LeaderboardSource,
    });
  }

  const profitableCount = [...latestStatsByWallet.values()].filter((s) =>
    meetsProfitableThreshold(s, settings.profitableWallet),
  ).length;

  const displayedStats = [...latestStatsByWallet.values()]
    .sort((a, b) => b.pnlUsd - a.pnlUsd)
    .slice(0, MAX_DISPLAYED_WALLETS);
  const displayedWalletIds = displayedStats.map((s) => s.walletId);

  const [wallets, trades] = await Promise.all([
    prisma.wallet.findMany({
      where: { id: { in: displayedWalletIds } },
      include: { classifications: true },
    }),
    prisma.walletTokenTrade.findMany({
      where: { walletId: { in: displayedWalletIds }, action: { in: ['BUY', 'SELL'] } },
      select: {
        walletId: true,
        tokenId: true,
        action: true,
        amountUsd: true,
        token: { select: { symbol: true } },
      },
    }),
  ]);
  const walletById = new Map(wallets.map((w) => [w.id, w]));

  // Per (walletId, tokenId) buy/sell USD totals -> deltaUsd = sellUsd -
  // buyUsd (binding decision #2's "realized-ish delta").
  interface TokenAgg {
    tokenId: string;
    symbol: string;
    buyUsd: number;
    sellUsd: number;
  }
  const aggByWallet = new Map<string, Map<string, TokenAgg>>();
  for (const trade of trades) {
    let byToken = aggByWallet.get(trade.walletId);
    if (!byToken) {
      byToken = new Map();
      aggByWallet.set(trade.walletId, byToken);
    }
    let agg = byToken.get(trade.tokenId);
    if (!agg) {
      agg = { tokenId: trade.tokenId, symbol: trade.token.symbol, buyUsd: 0, sellUsd: 0 };
      byToken.set(trade.tokenId, agg);
    }
    const usd = Number(trade.amountUsd);
    if (trade.action === 'BUY') agg.buyUsd += usd;
    else agg.sellUsd += usd;
  }

  function bestWorstFor(walletId: string): { best: WalletTokenPnl | null; worst: WalletTokenPnl | null } {
    const byToken = aggByWallet.get(walletId);
    if (!byToken || byToken.size === 0) return { best: null, worst: null };
    let best: WalletTokenPnl | null = null;
    let worst: WalletTokenPnl | null = null;
    for (const agg of byToken.values()) {
      const deltaUsd = agg.sellUsd - agg.buyUsd;
      const entry: WalletTokenPnl = { tokenId: agg.tokenId, symbol: agg.symbol, deltaUsd };
      if (best === null || deltaUsd > best.deltaUsd) best = entry;
      if (worst === null || deltaUsd < worst.deltaUsd) worst = entry;
    }
    // A wallet that only ever traded one token has the same best/worst
    // token — both cells render (no special-casing to hide "worst" when
    // it equals "best"), matching the plain max/min-pick definition in the
    // binding decision.
    return { best, worst };
  }

  const rows: WalletLeaderboardRow[] = displayedStats.map((stats) => {
    const wallet = walletById.get(stats.walletId);
    const { best, worst } = bestWorstFor(stats.walletId);
    return {
      walletId: stats.walletId,
      address: wallet?.address ?? '',
      chain: (wallet?.chain as LeaderboardChain) ?? 'SOLANA',
      pnlUsd: stats.pnlUsd,
      winRate: stats.winRate,
      tradeCount: stats.tradeCount,
      avgTradeSizeUsd: stats.avgTradeSizeUsd,
      walletScore: stats.walletScore,
      source: stats.source,
      labels: (wallet?.classifications.map((c) => c.label) ?? []) as LeaderboardLabel[],
      bestToken: best,
      worstToken: worst,
      meetsProfitableThreshold: meetsProfitableThreshold(stats, settings.profitableWallet),
    };
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Wallet Leaderboard</h1>
      <p className="mt-2 text-sm text-muted-foreground">Tracked and imported wallets by 30d performance</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {totalWalletCount} wallet{totalWalletCount === 1 ? '' : 's'} · {profitableCount} meet profitable thresholds
      </p>

      <div className="mt-6">
        <LeaderboardTable rows={rows} />
      </div>
    </div>
  );
}
