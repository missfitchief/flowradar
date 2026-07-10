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
// bound) — aggregateWindow needs the complete trailing history to compute
// newSmartBuyers ("first trade ever") and trailingBuyVolumeUsd (the window
// immediately before `from`), so trades genuinely can't be windowed without
// changing scores. The MARKET-snapshot load, by contrast, is BOUNDED when a
// caller passes `marketWindow` (F8): aggregateWindow only ever reads the
// earliest snapshot (tokenAgeDays) plus the latest snapshot ≤ to and ≤ from,
// so fetching just those points is score-exact — and it stops the unbounded
// growth of loading a token's full snapshot history every cycle (marketData
// appends one snapshot per token per cycle). Callers that don't pass
// marketWindow (backtest replay, tests) keep the original full-history load.

import type { PrismaClient } from '@prisma/client';
import { isProfitableWallet, resolveWindowBounds } from '@flowradar/core';
import type { Settings, WalletStatus } from '@flowradar/core';
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
 * Optional bounded-market-load hint (F8). When supplied, only the market
 * snapshots aggregateWindow will read are fetched — the earliest (token age)
 * plus the latest ≤ to and ≤ from for EACH window in `windows` — instead of
 * the token's full (unboundedly-growing) snapshot history. Score-exact only if
 * `now` + `windows` match what the caller then feeds aggregateWindow (`to` is
 * window-independent; `from = to − window`). Omit for the full-history load.
 */
export interface AggregateMarketWindow {
  now: Date;
  windows: number[];
}

interface MarketRow {
  ts: Date;
  marketCapUsd: unknown;
  liquidityUsd: unknown;
}

const MARKET_SELECT = { ts: true, marketCapUsd: true, liquidityUsd: true } as const;

/**
 * Bounded (F8) or full market-snapshot load. Bounded returns the deduped set of
 * {earliest, latest ≤ to, latest ≤ from(each window)} — exactly the points
 * aggregateWindow reads — so scores are identical to the full-history load.
 */
async function loadMarketRows(
  prisma: PrismaClient,
  tokenId: string,
  latestTradeTs: number | null,
  marketWindow: AggregateMarketWindow | undefined
): Promise<MarketRow[]> {
  // Empty `windows` would fetch no `from` point (a divergence vs full history),
  // so treat it — like a missing marketWindow — as the safe full-history load.
  if (!marketWindow || marketWindow.windows.length === 0) {
    return prisma.tokenMarketSnapshot.findMany({
      where: { tokenId },
      orderBy: [{ ts: 'asc' }, { id: 'asc' }],
      select: MARKET_SELECT
    });
  }
  // `to` is window-independent (resolveWindowBounds ignores the minutes arg for
  // `to`); one boundary time per window gives its `from`. The secondary `id`
  // ordering makes each boundary pick the SAME physical row the full path
  // would (whose stable ts-sort resolves equal-ts ties by the id-asc load
  // order) — robust even if a future writer ever emits two snapshots at the
  // identical ms (the live marketData pipeline writes one per token per cycle,
  // so this is belt-and-suspenders).
  const { to } = resolveWindowBounds(latestTradeTs, marketWindow.now, marketWindow.windows[0] ?? 0);
  const boundaryTimes = [to, ...marketWindow.windows.map((w) => new Date(to.getTime() - w * 60_000))];
  const [earliest, ...boundaryRows] = await Promise.all([
    prisma.tokenMarketSnapshot.findFirst({
      where: { tokenId },
      orderBy: [{ ts: 'asc' }, { id: 'asc' }],
      select: MARKET_SELECT
    }),
    ...boundaryTimes.map((t) =>
      prisma.tokenMarketSnapshot.findFirst({
        where: { tokenId, ts: { lte: t } },
        orderBy: [{ ts: 'desc' }, { id: 'desc' }],
        select: MARKET_SELECT
      })
    )
  ]);
  const byTs = new Map<number, MarketRow>();
  for (const row of [earliest, ...boundaryRows]) {
    if (row) byTs.set(row.ts.getTime(), row);
  }
  return [...byTs.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
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
  settings: Settings,
  marketWindow?: AggregateMarketWindow
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
  const latestTradeTs = trades.reduce<number | null>(
    (max, t) => (max === null || t.ts.getTime() > max ? t.ts.getTime() : max),
    null
  );

  const [walletRows, statsRows, classificationRows, clusterRows, marketRows] = await Promise.all([
    prisma.wallet.findMany({
      where: { id: { in: walletIds } },
      select: { id: true, isWatched: true, status: true }
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
        avgTradeSizeUsd: true,
        source: true
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
    loadMarketRows(prisma, tokenId, latestTradeTs, marketWindow)
  ]);

  const isWatchedByWallet = new Map(walletRows.map((w) => [w.id, w.isWatched]));
  const statusByWallet = new Map(walletRows.map((w) => [w.id, w.status]));

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
    const isWatched = isWatchedByWallet.get(walletId) ?? false;
    // Trust boundary (2026-07-10 audit): provider-REPORTED stats confer
    // meetsProfitable only for a watched wallet (promotion sets isWatched, so
    // candidate-validated wallets keep counting). An unwatched wallet whose
    // only stats row is an external provider's claim (legacy walletDiscovery
    // path, source='provider') must NOT count as smart money — csv stats are
    // operator-vouched and computed stats are FIFO over real ingested trades,
    // so both stay trusted on their own.
    const meetsProfitable =
      stats && (stats.source !== 'provider' || isWatched)
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
      isWatched,
      walletScore: stats?.walletScore ?? 0,
      labels: labelsByWallet.get(walletId) ?? [],
      meetsProfitable,
      // Wallet.status is NOT NULL with default observation_only, so a wallet
      // that appears in trade history but somehow lacks a row here (deleted
      // mid-flight) degrades to zero signal weight — the safe direction.
      status: (statusByWallet.get(walletId) ?? 'observation_only') as WalletStatus
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
