// FlowRadar — backtest.ts: runBacktestPass (Task 40 binding decision 3).
//
// Thin DB-facing wrapper around @flowradar/core's evaluateSignalOutcome: for
// every Signal older than 15 minutes (a signal can't have ANY horizon's
// window fully elapsed before then — M15 is the shortest horizon) that
// doesn't yet have complete BacktestResult coverage (one row per horizon in
// BacktestHorizon), this loads that signal's token's TokenMarketSnapshot
// series from triggeredAt through `now`, derives an entry point (price
// preferred, mcap fallback — see evaluate.ts's own basis-selection doc),
// calls evaluateSignalOutcome once per signal, and upserts one BacktestResult
// row PER HORIZON.
//
// Horizon completeness + `notes`: a horizon's own window
// [triggeredAt, triggeredAt + horizonMinutes] may not have fully elapsed yet
// relative to `now` (e.g. a signal that triggered 20 minutes ago has a
// complete M15 window but an incomplete H1/H6/H24/D3/D7 window). This pass
// still writes a row for EVERY horizon on EVERY qualifying signal (so a
// caller can always find "the latest known reading for horizon X", even if
// it's partial) but marks incomplete horizons with `notes: 'window_incomplete'`
// so a consumer (Task 41/42) can distinguish "this 2x never happened and the
// window is closed" from "this 2x hasn't happened YET, but there's still
// time left in the window." maxUpsidePct/maxDrawdownPct/roiPct/timeToXxMin
// are still populated with whatever the evaluator computed from the
// currently-available series slice either way — only completeness (and
// hence how much a consumer should TRUST an unrealized non-hit as a genuine
// miss) differs.
//
// `outcomeLabel`/`hitPlus50`/`hit2x`/`hit5x`/`hit10x`/`timeToPeakMin`/`basis`
// are SERIES-LEVEL (not per-horizon — see evaluate.ts's automaton, which
// walks the full available series once) and are therefore repeated
// IDENTICALLY across every horizon row for the same signal. This looks
// redundant at the row level but keeps every BacktestResult row
// self-describing (a consumer querying "all H24 results" doesn't need a
// second join back to some other horizon's row just to read the label) at
// the cost of a small amount of denormalized duplication — the same
// trade-off Signal.metrics/TokenFlowSnapshot already make elsewhere in this
// schema for read-path simplicity.
//
// smartExitedBeforeDump stays externally-supplied per evaluate.ts's own
// contract; this pass does not attempt to compute it (no smart-wallet exit
// data is wired into this task's scope) and persists it as null on every row.

import type { PrismaClient } from '@prisma/client';
import { evaluateSignalOutcome } from '@flowradar/core';
import type { BacktestHorizon, MarketPoint, Settings, SignalOutcome } from '@flowradar/core';

const ALL_HORIZONS: BacktestHorizon[] = ['M15', 'H1', 'H6', 'H24', 'D3', 'D7'];

const HORIZON_MINUTES: Record<BacktestHorizon, number> = {
  M15: 15,
  H1: 60,
  H6: 6 * 60,
  H24: 24 * 60,
  D3: 3 * 24 * 60,
  D7: 7 * 24 * 60
};

const MIN_SIGNAL_AGE_MS = 15 * 60 * 1000;

export interface BacktestLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface BacktestPassResult {
  signalsConsidered: number;
  signalsEvaluated: number;
  rowsUpserted: number;
  labelCounts: Record<string, number>;
}

/**
 * Finds signals eligible for (re-)evaluation: triggeredAt at least
 * MIN_SIGNAL_AGE_MS old, AND missing at least one of the 6 BacktestHorizon
 * rows (a signal that already has all 6 rows with every horizon's window
 * fully elapsed doesn't need re-evaluation — but this pass doesn't bother
 * distinguishing "fully complete" from "has 6 rows, some still
 * window_incomplete", since re-running evaluateSignalOutcome against a fresh
 * series is cheap and idempotent — see the upsert below. It simply re-checks
 * every signal with fewer than 6 rows, plus this task's own worker-tick
 * cadence naturally re-visits older signals on the next backtestHours tick
 * regardless).
 */
async function findEligibleSignals(
  prisma: PrismaClient,
  now: Date
): Promise<{ id: string; tokenId: string; triggeredAt: Date; mcapAtTrigger: unknown }[]> {
  const cutoff = new Date(now.getTime() - MIN_SIGNAL_AGE_MS);
  const candidates = await prisma.signal.findMany({
    where: { triggeredAt: { lte: cutoff } },
    select: {
      id: true,
      tokenId: true,
      triggeredAt: true,
      mcapAtTrigger: true,
      backtestResults: { select: { horizon: true } }
    }
  });
  return candidates
    .filter((s) => s.backtestResults.length < ALL_HORIZONS.length)
    .map((s) => ({ id: s.id, tokenId: s.tokenId, triggeredAt: s.triggeredAt, mcapAtTrigger: s.mcapAtTrigger }));
}

/** Entry price = the TokenMarketSnapshot closest to (at or before) triggeredAt; null if none exists at or before that time. */
async function findEntryPriceUsd(prisma: PrismaClient, tokenId: string, triggeredAt: Date): Promise<number | null> {
  const asOf = await prisma.tokenMarketSnapshot.findFirst({
    where: { tokenId, ts: { lte: triggeredAt } },
    orderBy: { ts: 'desc' },
    select: { priceUsd: true }
  });
  return asOf ? Number(asOf.priceUsd) : null;
}

/** The full TokenMarketSnapshot series for tokenId from triggeredAt through now (inclusive), converted to @flowradar/core's MarketPoint shape (Decimal -> number). */
async function loadSeries(prisma: PrismaClient, tokenId: string, triggeredAt: Date, now: Date): Promise<MarketPoint[]> {
  const rows = await prisma.tokenMarketSnapshot.findMany({
    where: { tokenId, ts: { gte: triggeredAt, lte: now } },
    orderBy: { ts: 'asc' },
    select: { ts: true, priceUsd: true, marketCapUsd: true, liquidityUsd: true }
  });
  return rows.map((r) => ({
    ts: r.ts,
    priceUsd: Number(r.priceUsd),
    mcapUsd: r.marketCapUsd !== null ? Number(r.marketCapUsd) : null,
    liquidityUsd: r.liquidityUsd !== null ? Number(r.liquidityUsd) : null
  }));
}

/** True when triggeredAt + horizonMinutes has fully elapsed relative to `now`. */
function horizonElapsed(triggeredAt: Date, horizon: BacktestHorizon, now: Date): boolean {
  const horizonEnd = triggeredAt.getTime() + HORIZON_MINUTES[horizon] * 60_000;
  return now.getTime() >= horizonEnd;
}

/**
 * Runs one full backtest pass: finds eligible signals (>=15min old, missing
 * >=1 horizon row), evaluates each via evaluateSignalOutcome, and upserts one
 * BacktestResult row per horizon. Returns a summary including the label
 * distribution across every signal evaluated THIS pass (not a cumulative
 * all-time distribution — a caller wanting the all-time picture should query
 * BacktestResult directly).
 */
export async function runBacktestPass(prisma: PrismaClient, _settings: Settings, now: Date = new Date(), log?: BacktestLogger): Promise<BacktestPassResult> {
  const eligible = await findEligibleSignals(prisma, now);

  let signalsEvaluated = 0;
  let rowsUpserted = 0;
  const labelCounts: Record<string, number> = {};

  for (const signal of eligible) {
    const [entryPriceUsd, series] = await Promise.all([
      findEntryPriceUsd(prisma, signal.tokenId, signal.triggeredAt),
      loadSeries(prisma, signal.tokenId, signal.triggeredAt, now)
    ]);
    const entryMcapUsd = signal.mcapAtTrigger !== null ? Number(signal.mcapAtTrigger) : null;

    const outcome: SignalOutcome = evaluateSignalOutcome({
      triggeredAt: signal.triggeredAt,
      entryPriceUsd,
      entryMcapUsd,
      series
    });

    labelCounts[outcome.label] = (labelCounts[outcome.label] ?? 0) + 1;
    signalsEvaluated += 1;

    for (const horizon of ALL_HORIZONS) {
      const horizonResult = outcome.horizons[horizon];
      const complete = horizonElapsed(signal.triggeredAt, horizon, now);
      const notes = complete ? null : 'window_incomplete';

      await prisma.backtestResult.upsert({
        where: { signalId_horizon: { signalId: signal.id, horizon } },
        create: {
          signalId: signal.id,
          horizon,
          maxUpsidePct: horizonResult?.maxUpsidePct ?? 0,
          maxDrawdownPct: horizonResult?.maxDrawdownPct ?? 0,
          roiPct: horizonResult?.roiPct ?? 0,
          timeTo2xMin: horizonResult?.timeTo2xMin ?? null,
          timeTo5xMin: horizonResult?.timeTo5xMin ?? null,
          timeTo10xMin: horizonResult?.timeTo10xMin ?? null,
          smartExitedBeforeDump: outcome.smartExitedBeforeDump,
          notes,
          outcomeLabel: outcome.label,
          hitPlus50: outcome.hitPlus50,
          hit2x: outcome.hit2x,
          hit5x: outcome.hit5x,
          hit10x: outcome.hit10x,
          timeToPeakMin: outcome.timeToPeakMin !== null ? Math.round(outcome.timeToPeakMin) : null,
          evaluatedAt: now,
          basis: outcome.basis
        },
        update: {
          maxUpsidePct: horizonResult?.maxUpsidePct ?? 0,
          maxDrawdownPct: horizonResult?.maxDrawdownPct ?? 0,
          roiPct: horizonResult?.roiPct ?? 0,
          timeTo2xMin: horizonResult?.timeTo2xMin ?? null,
          timeTo5xMin: horizonResult?.timeTo5xMin ?? null,
          timeTo10xMin: horizonResult?.timeTo10xMin ?? null,
          smartExitedBeforeDump: outcome.smartExitedBeforeDump,
          notes,
          outcomeLabel: outcome.label,
          hitPlus50: outcome.hitPlus50,
          hit2x: outcome.hit2x,
          hit5x: outcome.hit5x,
          hit10x: outcome.hit10x,
          timeToPeakMin: outcome.timeToPeakMin !== null ? Math.round(outcome.timeToPeakMin) : null,
          evaluatedAt: now,
          basis: outcome.basis
        }
      });
      rowsUpserted += 1;
    }
  }

  const result: BacktestPassResult = {
    signalsConsidered: eligible.length,
    signalsEvaluated,
    rowsUpserted,
    labelCounts
  };
  log?.info('backtest pass complete', { ...result });
  return result;
}
