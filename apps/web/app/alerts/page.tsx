import { prisma } from '@/lib/db';
import { AlertsFeed } from '@/components/alerts/AlertsFeed';
import type { AlertDeliveryStatus, AlertFeedRow, AlertRule, AlertSeverity } from '@/components/alerts/AlertsFeed';

// DB-backed dashboard — must render per-request, never freeze at build time
// (same invariant every other DB page in this app follows: /, /tokens,
// /tokens/[id], /wallets, /wallets/import).
export const dynamic = 'force-dynamic';

const FEED_CAP = 100;

/**
 * Alerts page (Task 17 binding decision 1) — chronological feed (newest
 * first, capped at 100) of every Alert row, joined against its originating
 * Signal (for severity/reasons/wallet-count/entity-count/net-flow/mcap-at-
 * trigger — Alert itself carries none of these) and Token (for symbol +
 * latest market snapshot, to compute post-alert mcap performance).
 *
 * Query shape: one findMany with `include: { signal: true, token: true }`
 * gets everything except "current mcap" (Token has no market-cap column of
 * its own — that lives on TokenMarketSnapshot). A second query fetches only
 * the latest TokenMarketSnapshot per distinct tokenId this page actually
 * needs, keyed by tokenId, then joined in-memory — same "N+1 avoided via a
 * keyed second query" shape app/page.tsx (Overview) already uses for its own
 * flow/market snapshot joins.
 *
 * Every Prisma Decimal is converted via Number(...) and every Date crossing
 * into AlertsFeed (a 'use client' component) is left as a plain Date — Next
 * serializes Date objects across the server/client boundary natively (same
 * as HotTokensTable's firstSeenAt/lastAlertAt props), so no ISO-string
 * conversion is needed here (unlike the chart components on /tokens/[id],
 * which need strings because they feed a charting library, not React itself).
 */
export default async function AlertsPage() {
  const alerts = await prisma.alert.findMany({
    orderBy: { sentAt: 'desc' },
    take: FEED_CAP,
    include: {
      signal: true,
      token: { select: { id: true, symbol: true } },
    },
  });

  const tokenIds = [...new Set(alerts.map((a) => a.tokenId).filter((id): id is string => id !== null))];
  const latestMarketSnapshots =
    tokenIds.length === 0
      ? []
      : await prisma.tokenMarketSnapshot.findMany({
          where: { tokenId: { in: tokenIds } },
          orderBy: { ts: 'desc' },
        });

  // findMany + orderBy desc gives every snapshot ordered newest-first across
  // ALL requested tokens interleaved — keep only the first (newest) one seen
  // per tokenId.
  const currentMcapByToken = new Map<string, number>();
  for (const snapshot of latestMarketSnapshots) {
    if (!currentMcapByToken.has(snapshot.tokenId)) {
      currentMcapByToken.set(snapshot.tokenId, Number(snapshot.marketCapUsd));
    }
  }

  const rows: AlertFeedRow[] = alerts.map((alert) => {
    const payload = alert.payload as { text?: string } | null;
    const reasons = Array.isArray(alert.signal?.reasons) ? (alert.signal!.reasons as unknown[]).map((r) => String(r)) : [];

    return {
      id: alert.id,
      sentAt: alert.sentAt,
      deliveryStatus: alert.deliveryStatus as AlertDeliveryStatus,
      tokenId: alert.tokenId,
      tokenSymbol: alert.token?.symbol ?? null,
      rule: (alert.rule as AlertRule | null) ?? null,
      severity: (alert.signal?.severity as AlertSeverity | undefined) ?? null,
      reasons,
      walletCount: alert.signal?.walletCount ?? null,
      uniqueEntityCount: alert.signal?.uniqueEntityCount ?? null,
      netFlowUsd: alert.signal ? Number(alert.signal.netFlowUsd) : null,
      mcapAtTrigger: alert.signal ? Number(alert.signal.mcapAtTrigger) : null,
      currentMcapUsd: alert.tokenId ? (currentMcapByToken.get(alert.tokenId) ?? null) : null,
      payloadText: payload?.text ?? '',
    };
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {rows.length} alert{rows.length === 1 ? '' : 's'}, newest first (capped at {FEED_CAP}).
      </p>

      <div className="mt-6">
        <AlertsFeed rows={rows} />
      </div>
    </div>
  );
}
