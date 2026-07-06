// FlowRadar — runMoneyFlowRefresh (Task 23 binding decision 4).
//
// Documented no-op-safe stub: MoneyFlowEdge rows for every watched/linked
// wallet's transfer/swap/bridge/cex activity are ALREADY captured during
// ingest (see packages/db/src/ingest.ts's upsertMoneyFlowEdge — every
// token_transfer/native_transfer/bridge_deposit/bridge_withdrawal leg of
// every ingested wallet's tx stream becomes a MoneyFlowEdge row at ingest
// time, deduped on (txHash, sourceAddress, destinationAddress, actionType)).
// There is no SEPARATE raw-chain-data source this pass would poll that
// ingest doesn't already cover in this codebase's current provider set
// (mock today; Wave 4 live providers reuse the exact same ingestNormalizedTxs
// pipeline per Task 5's design) — so a dedicated "moneyFlow" job has nothing
// distinct left to DO beyond what walletActivity's own ingest call already
// does on every tick.
//
// This function exists anyway (rather than omitting the job entirely) to:
//   1. Match the Task 23 brief's explicit job-name list 1:1 (apps/worker's
//      job registry stays a complete, self-documenting map of "one entry per
//      named pipeline stage" even where a stage is currently a pass-through).
//   2. Give a single, stable extension point for a FUTURE live-provider
//      reconciliation pass (e.g. re-deriving edges from a raw mempool/log
//      stream independent of per-wallet activity polling) without having to
//      wire a brand new job name through apps/worker/src/index.ts later.
//   3. Report an honest row count so a verification run can see it executed
//      (rather than silently registering a job that does visibly nothing).
//
// Safe to call on every tick: read-only (COUNT only, no writes), so calling
// it redundantly alongside walletActivity's own ingest is never harmful.

import type { PrismaClient } from '@prisma/client';

export interface MoneyFlowRefreshLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface MoneyFlowRefreshResult {
  totalEdges: number;
  edgesInLookback: number;
}

/**
 * Reports MoneyFlowEdge row counts (total + within the trailing
 * `lookbackHours`) as a health-check signal that ingest is actually
 * populating this table. Performs NO writes — see file header for why this
 * job is currently a documented no-op-safe stub rather than an independent
 * write path.
 */
export async function runMoneyFlowRefresh(
  prisma: PrismaClient,
  now: Date = new Date(),
  lookbackHours = 24,
  log?: MoneyFlowRefreshLogger
): Promise<MoneyFlowRefreshResult> {
  const windowFrom = new Date(now.getTime() - lookbackHours * 60 * 60_000);

  const [totalEdges, edgesInLookback] = await Promise.all([
    prisma.moneyFlowEdge.count(),
    prisma.moneyFlowEdge.count({ where: { ts: { gte: windowFrom, lte: now } } })
  ]);

  const result: MoneyFlowRefreshResult = { totalEdges, edgesInLookback };
  log?.info('moneyFlow refresh pass complete (no-op-safe stub — see file header)', { ...result });
  return result;
}
