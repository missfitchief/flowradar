import { prisma } from '@/lib/db';
import { AutoRefresh } from '@/components/AutoRefresh';
import { HotTokensTable } from '@/components/tokens/HotTokensTable';
import type { HotTokenRow } from '@/components/tokens/HotTokensTable';

// DB-backed dashboard — must render per-request, never freeze at build time.
export const dynamic = 'force-dynamic';

// Tokens page — Task 43 binding decision 2: this route is now the single
// dense raw-table layer (tertiary evidence view). It absorbs the Wave-1
// Overview hot-tokens table wholesale (same query shape, same
// <HotTokensTable> component, same 30s <AutoRefresh> poll) — '/' itself is
// now the Signal Feed (plain-English cards), and this route is what its
// "view all ->" links point at.
//
// Query shape: one grouped-latest-id query per per-token time series
// (TokenFlowSnapshot, TokenMarketSnapshot, Alert), then an in-memory join
// keyed by tokenId — see the original Overview page's comment (still
// accurate, just relocated here) for why this beats the N+1
// Promise.all(findFirst) pattern once snapshot history grows.
export default async function TokensPage() {
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
  // Binding decision #2 (original Overview task): these count nowhere, not
  // even in a "N excluded" note.
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
      <h1 className="text-2xl font-semibold tracking-tight">Tokens</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {rows.length} tracked token{rows.length === 1 ? '' : 's'} — raw data, sorted by FlowScore desc. For the
        plain-English read, see the Signal Feed.
      </p>

      <div className="mt-6">
        <HotTokensTable rows={rows} />
      </div>
    </div>
  );
}
