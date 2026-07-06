import { prisma } from '@/lib/db';
import { FramingBanner } from '@/components/backtest/FramingBanner';
import { BacktestControls } from '@/components/backtest/BacktestControls';
import { BacktestSummaryView } from '@/components/backtest/BacktestSummaryView';
import type { BacktestRunView } from '@/components/backtest/BacktestSummaryView';

// FlowRadar — /backtest page (Task 42 binding decision 3).
//
// DB-backed dashboard — must render per-request, never freeze at build time
// (same invariant every other DB page in this app follows).
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Design note: shadow mode is an EVALUATION VIEW over live signals, not a new
// tracked concept (Task 42 binding decision 1). FlowRadar's Signal table
// already persists every live detection (Task 15) — that IS the shadow
// record, since there is no execution/trading path anywhere in this app for
// a signal to have "acted" through. This /backtest page renders the LATEST
// BacktestRun (Task 41's runHistoricalReplay output — a no-lookahead replay
// pass over historical data), while /shadow (this task's sibling page)
// renders the live/ongoing evaluation view over Signal + BacktestResult
// directly. Both pages carry the SAME hard-framing banner because a replay
// run and a shadow-mode read are the ONLY two things that can ever validate
// signal quality — mock/seed data only proves the code path runs.
// ---------------------------------------------------------------------------

/**
 * Renders the latest BacktestRun row's summary Json into BacktestSummaryView's
 * typed props. Every Prisma Decimal is already absent from BacktestRun.summary
 * (it's a plain Json blob built by replayRunner.ts from pure @flowradar/core
 * function outputs — no Decimal ever enters it), so this is a straight cast
 * plus Date normalization for the row's own top-level DateTime columns.
 */
function toView(run: {
  id: string;
  kind: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  periodFrom: Date;
  periodTo: Date;
  syntheticEvidence: boolean;
  summary: unknown;
}): BacktestRunView {
  const summary = run.summary as Omit<BacktestRunView, 'id' | 'kind' | 'status' | 'startedAt' | 'finishedAt' | 'periodFrom' | 'periodTo' | 'syntheticEvidence'>;
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    periodFrom: run.periodFrom,
    periodTo: run.periodTo,
    syntheticEvidence: run.syntheticEvidence,
    ...summary
  };
}

export default async function BacktestPage() {
  const latestRun = await prisma.backtestRun.findFirst({
    where: { kind: 'replay', status: 'complete' },
    orderBy: { startedAt: 'desc' }
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Backtest</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          No-lookahead historical replay results — rule performance, threshold tuning, and walk-forward validation.
        </p>
      </div>

      <FramingBanner />

      <BacktestControls />

      {latestRun ? (
        <BacktestSummaryView run={toView(latestRun)} />
      ) : (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          <p>No backtest runs yet.</p>
          <p className="mt-2">
            Click &ldquo;Run replay&rdquo; above, or run <code className="text-xs">npm run backtest:replay</code> from the
            command line, to replay historical signals against real market data and populate this page.
          </p>
        </div>
      )}
    </div>
  );
}
