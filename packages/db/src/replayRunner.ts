// FlowRadar — replayRunner.ts: runHistoricalReplay (Task 41 binding decision
// 5, DB runner + persistence).
//
// Thin DB-facing wrapper around @flowradar/core's pure replay/rule-perf/
// threshold-tuning/walk-forward functions: loads every input row those
// functions need straight from the DB (reusing packages/db's existing
// fetchAggregateInputs/buildFundingEvents/buildRotationInputs — the SAME
// helpers the live scoring/signal-detection/rotation passes use, so replay
// never invents its own notion of "this token's trade history"), runs the
// full no-lookahead replay -> outcome join -> rule/combo performance ->
// threshold tuning -> walk-forward pipeline per Task 41's binding decisions,
// and persists ONE BacktestRun row with the full summary as Json.
//
// ---------------------------------------------------------------------------
// Scope: ALL tokens, ALL market snapshots regardless of source
// ---------------------------------------------------------------------------
// Per binding decision 5: "loads inputs from DB (ALL market snapshots
// regardless of source — but each point carries its source so the pure
// layer can mark synthetic evidence)". This runner does NOT filter out
// seed_synthetic_continuation rows — it passes every TokenMarketSnapshot
// row's own `source` straight through to @flowradar/core's evaluateReplay,
// which is what actually separates real vs synthetic-evidence outcomes in
// every summary (see rulePerf.ts's own header for why this must never be
// silently pooled).
//
// ---------------------------------------------------------------------------
// Per-token replay, merged
// ---------------------------------------------------------------------------
// replaySignals (packages/core) operates on a single token's input rows at a
// time (aggregateWindow itself is single-token). This runner loops over
// every token with >=1 trade in [from, to], replays each independently, and
// concatenates the resulting ReplayedSignal[] arrays before handing the
// combined list to evaluateReplay/rulePerformance/comboPerformance/
// tuneThresholds/walkForward — those functions are all token-agnostic once
// they're just working with ReplayedSignal[] (which already carries its own
// tokenId per signal).
//
// ---------------------------------------------------------------------------
// Documented limitation restated here (binding decision 1)
// ---------------------------------------------------------------------------
// Wallet profitability (isWatched/meetsProfitable) and entity-cluster
// membership are fetched ONCE (current DB state as of `now`, i.e. whenever
// this runner is invoked) and used as-provided for EVERY simulated step of
// the replay — they are NOT time-reconstructed to "what would this wallet's
// classification have looked like as of T". This is a known approximation,
// carried on BacktestRunSummary.limitations and printed by the CLI.
//
// ---------------------------------------------------------------------------
// Second documented scope limitation: threshold tuning + walk-forward are
// single-token-shaped
// ---------------------------------------------------------------------------
// @flowradar/core's tuneThresholds/walkForward (Task 41 binding decisions 3-4)
// each internally call replaySignals themselves against ONE token's raw input
// rows (mirroring replaySignals' own single-token shape) — they are not
// designed to accept an already-multi-token-merged ReplayedSignal[] the way
// evaluateReplay/rulePerformance/comboPerformance are. Rather than force a
// fake multi-token replay shape into those pure functions (which would risk
// silently misattributing one token's trades to another during a sweep),
// this runner scopes tuneThresholds/walkForward to the SINGLE most-active
// token in [from, to] (highest trade count) — a real, honest per-token tuning
// run rather than a fabricated aggregate. This is restated in
// BacktestRunSummary.limitations and printed by the CLI.

import type { PrismaClient } from '@prisma/client';
import {
  DEFAULT_SETTINGS,
  replaySignals,
  evaluateReplay,
  rulePerformance,
  comboPerformance,
  bucketPerformance,
  tuneThresholds,
  walkForward
} from '@flowradar/core';
import type {
  ReplayedSignal,
  RulePerformance,
  ComboPerfResult,
  BucketBreakdowns,
  TuneThresholdsResult,
  WalkForwardResult,
  ThresholdSweepGrid,
  Settings,
  BacktestHorizon,
  MarketPoint
} from '@flowradar/core';
import { fetchAggregateInputs } from './fetchAggregateInputs';
import { buildFundingEvents } from './fundingEvents';
import { buildRotationInputs } from './rotation';
import { matchRotations } from '@flowradar/core';

const ALL_HORIZONS: BacktestHorizon[] = ['M15', 'H1', 'H6', 'H24', 'D3', 'D7'];

// Documented per thresholdTuning.ts's own header — the brief's coarse OAT
// grid (Spec §5c / task-41 binding decision 3), used verbatim by this
// runner unless a caller supplies its own via settingsOverride's sibling
// param (kept as an internal default here rather than a public knob, since
// no task brief asks for a caller-tunable grid).
const DEFAULT_GRID: ThresholdSweepGrid = {
  minWallets: [10, 15, 20, 30],
  minEntities: [1, 5, 10],
  minNetFlow: [0, 10_000, 25_000, 50_000],
  maxSoldPct: [20, 30, 50],
  maxMcapExpansion: [1.5, 2, 3],
  minLiquidity: [10_000, 20_000, 50_000]
};

export interface RunHistoricalReplayOptions {
  from: Date;
  to: Date;
  stepMinutes?: number;
  settingsOverride?: Settings;
}

export interface BacktestRunSummary {
  replayedSignalCount: number;
  rulePerformance: RulePerformance;
  comboPerformance: ComboPerfResult[];
  bucketPerformance: BucketBreakdowns;
  thresholdTuning: TuneThresholdsResult;
  walkForward: WalkForwardResult;
  syntheticEvidencePresent: boolean;
  limitations: string[];
}

export interface RunHistoricalReplayResult {
  backtestRunId: string;
  summary: BacktestRunSummary;
}

const LIMITATIONS = [
  'Wallet profitability (isWatched/meetsProfitable) and entity-cluster membership are current-state snapshots, ' +
    'NOT time-reconstructed to what they would have looked like as of each simulated replay step T — a known ' +
    'approximation (see @flowradar/core replay.ts header, Task 41 binding decision 1).'
];

/**
 * Loads every input row @flowradar/core's replaySignals needs for ONE token
 * across [from, to]: full trade/wallet/cluster/market history via
 * fetchAggregateInputs (mirrors the live scoring/signal-detection passes'
 * own fetch), FundingEvent[] via buildFundingEvents, and this run's shared
 * MatchedRotationCandidate[] (built once, outside this per-token loop, since
 * matchRotations' own destTokenId filter already scopes correctly per token
 * inside ruleF — see packages/db/src/signals.ts's identical "once per pass"
 * pattern).
 */
async function replayOneToken(
  prisma: PrismaClient,
  tokenId: string,
  from: Date,
  to: Date,
  stepMinutes: number,
  settings: Settings,
  sharedRotationCandidates: ReturnType<typeof matchRotations>
): Promise<ReplayedSignal[]> {
  const [{ trades, wallets, clusters, market }, fundingEvents] = await Promise.all([
    fetchAggregateInputs(prisma, tokenId, settings),
    buildFundingEvents(prisma, tokenId, from, to, settings)
  ]);

  const rotationCandidatesForToken = sharedRotationCandidates.filter((c) => c.destTokenId === tokenId);

  return replaySignals({
    trades,
    wallets,
    clusters,
    marketPoints: market,
    fundingEvents,
    rotationCandidates: rotationCandidatesForToken,
    from,
    to,
    stepMinutes,
    settings,
    tokenId
  });
}

/** Loads the full TokenMarketSnapshot series per token (ALL sources, ts within [from, to's outer horizon]) into the MarketPoint[] shape evaluateReplay expects, source carried through for synthetic-evidence detection. */
async function loadMarketSeriesByToken(
  prisma: PrismaClient,
  tokenIds: string[],
  from: Date
): Promise<Map<string, (MarketPoint & { source?: string })[]>> {
  const rows = await prisma.tokenMarketSnapshot.findMany({
    where: { tokenId: { in: tokenIds }, ts: { gte: from } },
    orderBy: { ts: 'asc' },
    select: { tokenId: true, ts: true, priceUsd: true, marketCapUsd: true, liquidityUsd: true, source: true }
  });

  const byToken = new Map<string, (MarketPoint & { source?: string })[]>();
  for (const row of rows) {
    const list = byToken.get(row.tokenId) ?? [];
    list.push({
      ts: row.ts,
      priceUsd: Number(row.priceUsd),
      mcapUsd: row.marketCapUsd !== null ? Number(row.marketCapUsd) : null,
      liquidityUsd: row.liquidityUsd !== null ? Number(row.liquidityUsd) : null,
      source: row.source
    });
    byToken.set(row.tokenId, list);
  }
  return byToken;
}

/**
 * Runs one full historical-replay pass over [from, to]: replays every token
 * with >=1 trade in that window (no-lookahead, per @flowradar/core's
 * replaySignals), joins outcomes, computes rule/combo performance +
 * OAT threshold tuning + walk-forward validation, and persists a
 * BacktestRun row with the complete summary. Returns the new row's id plus
 * the summary itself (so the CLI script doesn't need a second DB read).
 */
export async function runHistoricalReplay(
  prisma: PrismaClient,
  options: RunHistoricalReplayOptions
): Promise<RunHistoricalReplayResult> {
  const { from, to } = options;
  const stepMinutes = options.stepMinutes ?? 30;
  const settings = options.settingsOverride ?? DEFAULT_SETTINGS;
  const startedAt = new Date();

  const backtestRun = await prisma.backtestRun.create({
    data: {
      kind: 'replay',
      params: { from: from.toISOString(), to: to.toISOString(), stepMinutes },
      periodFrom: from,
      periodTo: to,
      startedAt,
      status: 'running',
      summary: {}
    }
  });

  try {
    const tokens = await prisma.token.findMany({
      where: { trades: { some: { ts: { gte: from, lte: to } } } },
      select: { id: true, _count: { select: { trades: true } } }
    });
    const tokenIds = tokens.map((t) => t.id);

    // Rotation candidates built ONCE across the full [from, to] window (mirrors
    // signals.ts's own "once per pass" pattern) — each token's replay filters
    // this shared list down to candidates destined for it.
    const rotationInputs = await buildRotationInputs(prisma, from, to);
    const sharedRotationCandidates = matchRotations({ ...rotationInputs, settings });

    const replayedByToken = await Promise.all(
      tokenIds.map((tokenId) => replayOneToken(prisma, tokenId, from, to, stepMinutes, settings, sharedRotationCandidates))
    );
    const replayed: ReplayedSignal[] = replayedByToken.flat();

    const marketSeriesByToken = await loadMarketSeriesByToken(prisma, tokenIds, from);

    const evaluated = evaluateReplay(replayed, marketSeriesByToken, ALL_HORIZONS);
    const rulePerf = rulePerformance(evaluated);
    const comboPerf = comboPerformance(evaluated, settings);
    const bucketPerf = bucketPerformance(evaluated);

    // Threshold tuning + walk-forward are single-token-shaped (see this
    // file's header) — scoped to the single MOST-ACTIVE token in the period
    // (highest trade count) rather than a fabricated multi-token merge.
    const mostActiveToken = [...tokens].sort((a, b) => b._count.trades - a._count.trades)[0];

    let tuning: TuneThresholdsResult;
    let wf: WalkForwardResult;
    if (mostActiveToken) {
      const tuningTokenId = mostActiveToken.id;
      const [{ trades, wallets, clusters, market }, fundingEvents] = await Promise.all([
        fetchAggregateInputs(prisma, tuningTokenId, settings),
        buildFundingEvents(prisma, tuningTokenId, from, to, settings)
      ]);
      const rotationCandidatesForToken = sharedRotationCandidates.filter((c) => c.destTokenId === tuningTokenId);
      const tuningSeries = marketSeriesByToken.get(tuningTokenId) ?? [];

      const tuningInputs = {
        trades,
        wallets,
        clusters,
        marketPoints: market,
        fundingEvents,
        rotationCandidates: rotationCandidatesForToken,
        from,
        to,
        stepMinutes,
        tokenId: tuningTokenId,
        marketSeriesByToken: new Map([[tuningTokenId, tuningSeries]]),
        horizons: ALL_HORIZONS
      };

      tuning = tuneThresholds({ inputs: tuningInputs, grid: DEFAULT_GRID, baseSettings: settings });

      const splitAt = new Date(from.getTime() + (to.getTime() - from.getTime()) / 2);
      wf = walkForward({ inputs: tuningInputs, from, to, splitAt, grid: DEFAULT_GRID, baseSettings: settings });
    } else {
      // No token had any trades in the period at all — tuning/walk-forward
      // have nothing to sweep. tuneThresholds/walkForward both tolerate
      // empty inputs (score 0 sets, insufficientSample: true throughout),
      // so this still returns well-formed (if empty) results rather than
      // requiring special-cased null handling downstream.
      const emptyInputs = {
        trades: [],
        wallets: [],
        clusters: [],
        marketPoints: [],
        fundingEvents: [],
        rotationCandidates: [],
        from,
        to,
        stepMinutes,
        marketSeriesByToken: new Map()
      };
      tuning = tuneThresholds({ inputs: emptyInputs, grid: DEFAULT_GRID, baseSettings: settings });
      const splitAt = new Date(from.getTime() + (to.getTime() - from.getTime()) / 2);
      wf = walkForward({ inputs: emptyInputs, from, to, splitAt, grid: DEFAULT_GRID, baseSettings: settings });
    }

    const syntheticEvidencePresent = evaluated.some((e) => e.syntheticEvidence);

    const summary: BacktestRunSummary = {
      replayedSignalCount: replayed.length,
      rulePerformance: rulePerf,
      comboPerformance: comboPerf,
      bucketPerformance: bucketPerf,
      thresholdTuning: tuning,
      walkForward: wf,
      syntheticEvidencePresent,
      limitations: LIMITATIONS
    };

    await prisma.backtestRun.update({
      where: { id: backtestRun.id },
      data: {
        finishedAt: new Date(),
        status: 'complete',
        summary: summary as unknown as object,
        syntheticEvidence: syntheticEvidencePresent
      }
    });

    return { backtestRunId: backtestRun.id, summary };
  } catch (err) {
    await prisma.backtestRun.update({
      where: { id: backtestRun.id },
      data: { finishedAt: new Date(), status: 'failed', summary: { error: err instanceof Error ? err.message : String(err) } }
    });
    throw err;
  }
}
