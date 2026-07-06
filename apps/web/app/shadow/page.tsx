import { prisma } from '@/lib/db';
import { shadowStatus } from '@flowradar/core';
import type { BacktestHorizon } from '@flowradar/core';
import { FramingBanner } from '@/components/backtest/FramingBanner';
import { ShadowFeed } from '@/components/shadow/ShadowFeed';
import type { ShadowFeedRow, ShadowRule, ShadowSeverity } from '@/components/shadow/ShadowFeed';

// FlowRadar — /shadow page (Task 42 binding decision 4).
//
// DB-backed dashboard — must render per-request, never freeze at build time
// (same invariant every other DB page in this app follows).
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Design note: "shadow mode" = an evaluation VIEW over the Signal table, not
// a new tracked concept (Task 42 binding decision 1). Every live detection
// already persists a Signal row (Task 15) the instant it fires, and the
// backtest worker (Task 40/41, 6h cadence) evaluates it against real
// TokenMarketSnapshot data without any execution/trading path ever touching
// it — that IS shadow mode, "run live for days, record every signal without
// trading/acting" (Wave 3.5 Phase C brief), already true by construction.
// This page's only job is to join Signal -> BacktestResult -> shadowStatus()
// (packages/core/src/backtest/shadow.ts) and render the result; it creates
// no new table and no new worker job.
// ---------------------------------------------------------------------------

const FEED_CAP = 100;
const ALL_HORIZONS: BacktestHorizon[] = ['M15', 'H1', 'H6', 'H24', 'D3', 'D7'];
const HORIZON_MINUTES: Record<BacktestHorizon, number> = {
  M15: 15,
  H1: 60,
  H6: 6 * 60,
  H24: 24 * 60,
  D3: 3 * 24 * 60,
  D7: 7 * 24 * 60
};
const HORIZON_LABEL: Record<BacktestHorizon, string> = {
  M15: '15m',
  H1: '1h',
  H6: '6h',
  H24: '24h',
  D3: '3d',
  D7: '7d'
};

export default async function ShadowPage() {
  const now = new Date();

  const signals = await prisma.signal.findMany({
    orderBy: { triggeredAt: 'desc' },
    take: FEED_CAP,
    include: {
      token: { select: { id: true, symbol: true } },
      backtestResults: true
    }
  });

  const rows: ShadowFeedRow[] = signals.map((signal) => {
    const signalAgeMs = now.getTime() - signal.triggeredAt.getTime();

    const view = shadowStatus(
      signal.backtestResults.map((r) => ({
        horizon: r.horizon as BacktestHorizon,
        outcomeLabel: r.outcomeLabel,
        notes: r.notes
      })),
      signalAgeMs
    );

    // "roiPct at latest elapsed horizon" (binding decision 4) — the LONGEST
    // horizon whose window has actually elapsed as of now (no
    // window_incomplete note on that row), preferring D7 down to M15,
    // mirroring summarize.ts's own HORIZON_PREFERENCE longest-available-first
    // convention.
    let latestRoiPct: number | null = null;
    let latestElapsedHorizonLabel: string | null = null;
    for (const horizon of [...ALL_HORIZONS].reverse()) {
      const result = signal.backtestResults.find((r) => r.horizon === horizon);
      if (!result) continue;
      const elapsed = now.getTime() >= signal.triggeredAt.getTime() + HORIZON_MINUTES[horizon] * 60_000;
      if (!elapsed) continue;
      latestRoiPct = result.roiPct;
      latestElapsedHorizonLabel = HORIZON_LABEL[horizon];
      break;
    }

    const syntheticEvidence = view.syntheticEvidence;

    return {
      signalId: signal.id,
      tokenId: signal.tokenId,
      tokenSymbol: signal.token.symbol,
      rule: signal.rule as ShadowRule,
      severity: signal.severity as ShadowSeverity,
      triggeredAt: signal.triggeredAt,
      horizons: view.horizons,
      overall: view.overall,
      syntheticEvidence,
      latestRoiPct,
      latestElapsedHorizonLabel
    };
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Shadow Mode</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every live signal, evaluated against real market data at 15m/1h/6h/24h/3d/7d — no trading, no acting, observation
          only. Newest first, capped at {FEED_CAP}.
        </p>
      </div>

      <FramingBanner />

      <ShadowFeed rows={rows} />
    </div>
  );
}
