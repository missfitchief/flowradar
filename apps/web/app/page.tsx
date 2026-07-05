import { prisma } from '@/lib/db';
import { AutoRefresh } from '@/components/AutoRefresh';
import { HotTokensTable } from '@/components/tokens/HotTokensTable';
import type { HotTokenRow } from '@/components/tokens/HotTokensTable';

// DB-backed dashboard — must render per-request, never freeze at build time.
export const dynamic = 'force-dynamic';

// Overview page — spec §8 item 1: hot tokens table sorted by FlowScore desc,
// 30s poll (via <AutoRefresh>, which just calls router.refresh() on an
// interval — this server component re-runs its query on every refresh).
//
// Query shape: one grouped-latest-id query per per-token time series
// (TokenFlowSnapshot, TokenMarketSnapshot, Alert), then an in-memory join
// keyed by tokenId. This is the "3 grouped queries" option from binding
// decision #2 rather than 29x Promise.all(findFirst) like /tokens uses today
// — picked here because Overview needs *two* latest-snapshot joins (flow +
// market) instead of one, so the N+1 pattern would mean ~58 round-trips per
// load on a 29-token seeded DB; still small enough that either approach would
// work fine at this scale, but this one doesn't get worse as snapshot history
// grows (each grouped query is O(tokens), not O(tokens * snapshot rows)).
export default async function OverviewPage() {
  const tokens = await prisma.token.findMany();

  const [latestFlowIds, latestMarketIds, latestAlertIds] = await Promise.all([
    prisma.tokenFlowSnapshot.groupBy({
      by: ['tokenId'],
      _max: { ts: true },
    }),
    prisma.tokenMarketSnapshot.groupBy({
      by: ['tokenId'],
      _max: { ts: true },
    }),
    prisma.alert.groupBy({
      by: ['tokenId'],
      _max: { sentAt: true },
      where: { tokenId: { not: null } },
    }),
  ]);

  // groupBy only gives (tokenId, max(ts)) pairs, not the full row, so a
  // second pass fetches the actual snapshot rows at those exact timestamps.
  const [flowSnapshots, marketSnapshots, alerts] = await Promise.all([
    prisma.tokenFlowSnapshot.findMany({
      where: {
        OR: latestFlowIds.map((g) => ({ tokenId: g.tokenId, ts: g._max.ts! })),
      },
    }),
    prisma.tokenMarketSnapshot.findMany({
      where: {
        OR: latestMarketIds.map((g) => ({ tokenId: g.tokenId, ts: g._max.ts! })),
      },
    }),
    prisma.alert.findMany({
      where: {
        OR: latestAlertIds.map((g) => ({ tokenId: g.tokenId, sentAt: g._max.sentAt! })),
      },
    }),
  ]);

  const flowByToken = new Map(flowSnapshots.map((s) => [s.tokenId, s]));
  const marketByToken = new Map(marketSnapshots.map((s) => [s.tokenId, s]));
  const alertByToken = new Map(alerts.filter((a) => a.tokenId).map((a) => [a.tokenId!, a]));

  // Exclude tokens with no flow snapshot (the incidental USDC stub created by
  // ingest when it sees a USDC-asset transfer — it never goes through
  // flow-scoring since it isn't one of the 7 scripted scenario/noise tokens).
  // Binding decision #2: these count nowhere, not even in a "N excluded" note.
  const rows: HotTokenRow[] = tokens
    .map((token): HotTokenRow | null => {
      const flow = flowByToken.get(token.id);
      if (!flow) return null;

      const market = marketByToken.get(token.id);
      const alert = alertByToken.get(token.id);

      return {
        id: token.id,
        symbol: token.symbol,
        name: token.name,
        chain: token.chain,
        firstSeenAt: token.firstSeenAt,
        flowScore: flow.flowScore,
        smartWalletCount: flow.smartWalletCount,
        uniqueEntityCount: flow.uniqueEntityCount,
        netFlowUsd: Number(flow.netFlowUsd),
        humanLikeCount: flow.humanLikeCount,
        possibleBotCount: flow.possibleBotCount,
        signalStatus: flow.signalStatus,
        marketCapUsd: market ? Number(market.marketCapUsd) : null,
        liquidityUsd: market ? Number(market.liquidityUsd) : null,
        vol5m: market ? Number(market.vol5m) : null,
        vol1h: market ? Number(market.vol1h) : null,
        vol24h: market ? Number(market.vol24h) : null,
        lastAlertAt: alert ? alert.sentAt : null,
      };
    })
    .filter((row): row is HotTokenRow => row !== null)
    .sort((a, b) => b.flowScore - a.flowScore);

  return (
    <div>
      <AutoRefresh />
      <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
      <p className="mt-2 text-sm text-muted-foreground">Hot tokens by smart-wallet flow</p>

      <div className="mt-6">
        <HotTokensTable rows={rows} />
      </div>
    </div>
  );
}
