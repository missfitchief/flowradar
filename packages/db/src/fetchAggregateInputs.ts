// FlowRadar — fetchAggregateInputs: DB rows -> @flowradar/core aggregateWindow inputs.
//
// Normative source: Task 15 binding decision 2/3 ("factor a shared
// fetchAggregateInputs(prisma, tokenId, now) in packages/db so scoring +
// signals don't duplicate queries"). This is the ONE place raw
// WalletTokenTrade/Wallet/WalletStats/WalletClassification/
// TokenMarketSnapshot/EntityClusterWallet rows become the four
// aggregateWindow input row types (TradeRowInput/WalletInfoInput/
// ClusterMembershipInput/MarketPointInput) — packages/db/src/scoring-pass.ts
// and apps/worker/src/jobs/signalDetection.ts (+ seed.ts's shared signal
// pass) both call this instead of writing their own queries.
//
// Scope: fetches the token's FULL trade history (all BUY/SELL rows, no time
// bound) and FULL market-snapshot history — aggregateWindow itself needs the
// complete trailing history to compute newSmartBuyers ("first trade ever"),
// trailingBuyVolumeUsd (the window immediately before `from`), and
// tokenAgeDays (earliest market point). This is safe at the current
// mock/seed scale (~920 trades across 28 tokens total, per progress.md) —
// a real-scale deployment would need this narrowed to a bounded lookback,
// but that's out of this task's scope (no task brief asks for pagination
// here, and every existing worker job in this codebase makes the same
// "small dataset, full scan is fine" assumption — see e.g.
// apps/web/app/wallets/page.tsx's own header comment).

import type { PrismaClient } from '@prisma/client';
import { isProfitableWallet } from '@flowradar/core';
import type { Settings } from '@flowradar/core';
import type {
  ClusterMembershipInput,
  MarketPointInput,
  TradeRowInput,
  WalletInfoInput
} from '@flowradar/core';

export interface AggregateInputs {
  trades: TradeRowInput[];
  wallets: WalletInfoInput[];
  clusters: ClusterMembershipInput[];
  market: MarketPointInput[];
}

/**
 * Fetches every row aggregateWindow needs for one token: the token's full
 * BUY/SELL trade history, WalletInfoInput for every wallet that appears in
 * that trade history (isWatched + latest WalletStats-derived
 * meetsProfitable + WalletClassification labels + latest walletScore),
 * EntityClusterWallet memberships for those same wallets (empty result set
 * until Task 22's clustering job populates the table), and the token's full
 * TokenMarketSnapshot history.
 */
export async function fetchAggregateInputs(
  prisma: PrismaClient,
  tokenId: string,
  settings: Settings
): Promise<AggregateInputs> {
  const tradeRows = await prisma.walletTokenTrade.findMany({
    where: { tokenId, action: { in: ['BUY', 'SELL'] } },
    orderBy: { ts: 'asc' },
    select: {
      walletId: true,
      action: true,
      amountUsd: true,
      ts: true,
      blockOrSlot: true,
      marketCapAtTrade: true
    }
  });

  const trades: TradeRowInput[] = tradeRows.map((row) => ({
    walletId: row.walletId,
    action: row.action as 'BUY' | 'SELL',
    amountUsd: Number(row.amountUsd),
    ts: row.ts,
    blockOrSlot: row.blockOrSlot,
    marketCapAtTrade: row.marketCapAtTrade !== null ? Number(row.marketCapAtTrade) : null
  }));

  const walletIds = [...new Set(trades.map((t) => t.walletId))];

  const [walletRows, statsRows, classificationRows, clusterRows, marketRows] = await Promise.all([
    prisma.wallet.findMany({
      where: { id: { in: walletIds } },
      select: { id: true, isWatched: true }
    }),
    prisma.walletStats.findMany({
      where: { walletId: { in: walletIds } },
      orderBy: { computedAt: 'desc' },
      select: {
        walletId: true,
        walletScore: true,
        pnlUsd: true,
        realizedPnlUsd: true,
        winRate: true,
        tradeCount: true,
        avgTradeSizeUsd: true
      }
    }),
    prisma.walletClassification.findMany({
      where: { walletId: { in: walletIds } },
      select: { walletId: true, label: true }
    }),
    prisma.entityClusterWallet.findMany({
      where: { walletId: { in: walletIds } },
      select: { walletId: true, clusterId: true }
    }),
    prisma.tokenMarketSnapshot.findMany({
      where: { tokenId },
      orderBy: { ts: 'asc' },
      select: { ts: true, marketCapUsd: true, liquidityUsd: true }
    })
  ]);

  const isWatchedByWallet = new Map(walletRows.map((w) => [w.id, w.isWatched]));

  // Latest WalletStats row per wallet (rows already ordered computedAt
  // desc, so first occurrence per walletId wins) — same reduction pattern
  // as packages/db/src/scoring-pass.ts's prior latestStatsByWallet.
  const latestStatsByWallet = new Map<string, (typeof statsRows)[number]>();
  for (const row of statsRows) {
    if (!latestStatsByWallet.has(row.walletId)) {
      latestStatsByWallet.set(row.walletId, row);
    }
  }

  const labelsByWallet = new Map<string, string[]>();
  for (const row of classificationRows) {
    const list = labelsByWallet.get(row.walletId) ?? [];
    list.push(row.label);
    labelsByWallet.set(row.walletId, list);
  }

  const wallets: WalletInfoInput[] = walletIds.map((walletId) => {
    const stats = latestStatsByWallet.get(walletId);
    const meetsProfitable = stats
      ? isProfitableWallet(
          {
            pnlUsd: Number(stats.pnlUsd),
            realizedPnlUsd: Number(stats.realizedPnlUsd),
            winRate: stats.winRate,
            tradeCount: stats.tradeCount,
            avgTradeSizeUsd: Number(stats.avgTradeSizeUsd)
          },
          settings.profitableWallet
        )
      : false;
    return {
      walletId,
      isWatched: isWatchedByWallet.get(walletId) ?? false,
      walletScore: stats?.walletScore ?? 0,
      labels: labelsByWallet.get(walletId) ?? [],
      meetsProfitable
    };
  });

  const clusters: ClusterMembershipInput[] = clusterRows.map((row) => ({
    walletId: row.walletId,
    clusterId: row.clusterId
  }));

  const market: MarketPointInput[] = marketRows.map((row) => ({
    ts: row.ts,
    marketCapUsd: row.marketCapUsd !== null ? Number(row.marketCapUsd) : null,
    liquidityUsd: row.liquidityUsd !== null ? Number(row.liquidityUsd) : null
  }));

  return { trades, wallets, clusters, market };
}
