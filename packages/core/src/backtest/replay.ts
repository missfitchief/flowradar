// FlowRadar — replaySignals: pure no-lookahead historical replay (Task 41
// binding decision 1).
//
// packages/core is PURE (zero I/O) — this module takes plain in-memory rows
// (the SAME row shapes aggregateWindow/evaluateAllRules/matchRotations
// already consume) plus a [from, to] wall-clock span and a step size, and
// returns every rule that fired at every step walked, deterministically.
//
// ---------------------------------------------------------------------------
// The no-lookahead property (THE review-critical guarantee this file exists
// to enforce)
// ---------------------------------------------------------------------------
// Walking T from `from` to `to` in `stepMinutes` increments, at EACH step this
// function filters every time-series input (trades, market points, funding
// events, rotation candidates) down to rows with `ts <= T` BEFORE calling
// aggregateWindow(..., { now: T }). This filtering happens INSIDE this
// module — callers are NOT trusted to have pre-filtered anything (the task
// brief is explicit: "the filter inside replay.ts is the no-lookahead
// enforcement; do not rely on callers pre-filtering"). aggregateWindow's own
// `now` anchoring (min(now, latest trade ts) — see window/aggregate.ts's own
// header) then computes `to`/`from` for the 30m/1440m windows purely from
// that already-clipped trade set, so nothing dated after T can ever
// contribute to a rule evaluation timestamped at T.
//
// wallets/clusters are the one deliberate exception (documented limitation,
// per binding decision 1): wallet profitability (isWatched/meetsProfitable)
// and entity-cluster membership are used AS-PROVIDED for every step, not
// time-reconstructed to "what would this wallet's classification have looked
// like as of T". Reconstructing those retroactively would need a much larger
// historical-classification pipeline this task does not build. Every
// ReplayedSignal's `metrics` carries no special marker for this — it is a
// structural, run-level limitation restated in the CLI/report output instead
// (see packages/db/src/replayRunner.ts).
//
// FundingEvent gets a SECOND, more subtle filtering pass beyond plain
// `ts <= T` (Critical fix, Task 41 review): FundingEvent.ts is only the
// funding TRANSFER's own timestamp — the event also optionally carries
// `fundedFirstBuy` (see types.ts), a LATER timestamp for the buy that
// transfer supposedly financed, which rules/ruleE.ts reads directly
// (firstBuy.ts/mcapAtBuy/usd) without any T-gating of its own. Filtering the
// funding EVENT list on event.ts <= T alone would still hand Rule E a
// fundedFirstBuy dated after T — a real lookahead leak the plain trades/
// market/rotation ts<=T filters don't catch, since fundedFirstBuy isn't its
// own top-level time-series row. The fix: once event.ts <= T qualifies an
// event for inclusion, additionally scrub `fundedFirstBuy` to `undefined`
// whenever `fundedFirstBuy.ts > T` — the funding transfer is legitimately
// known as of T even when the buy it financed is not, so the event survives
// with its future tail removed rather than being dropped outright. This is
// the exact same principle rotationCandidates' own `destBuyTs`-gating below
// already applies (gate on the LAST timestamp in a multi-step chain, not the
// first) — see the inline comment beside `rotationAsOfT` in replaySignals().
//
// ---------------------------------------------------------------------------
// Live-parity dedupe
// ---------------------------------------------------------------------------
// Mirrors packages/db/src/signals.ts's own "skip creating a new Signal row if
// an ACTIVE Signal already exists for (tokenId, rule) with triggeredAt within
// the last 24h" rule: within this replay, the same (tokenId, rule) pair is
// suppressed for 24h after its most recent fire and refires only once a step
// lands at/after firedAt + 24h.
//
// ---------------------------------------------------------------------------
// Step bounds
// ---------------------------------------------------------------------------
// Both `from` and `to` are INCLUSIVE step points: the walk starts at `from`,
// advances by `stepMinutes` each iteration, and includes a final step
// exactly AT `to` whenever `to` is reached exactly on a step boundary from
// `from` — otherwise the last emitted step is the last one <= `to` (the walk
// never produces a step strictly after `to`). With `from === to` the walk is
// exactly one step.

import { aggregateWindow } from '../window/aggregate';
import type { TradeRowInput, WalletInfoInput, ClusterMembershipInput, MarketPointInput } from '../window/aggregate';
import { evaluateAllRules, firedRules } from '../rules/index';
import type { FundingEvent, RotationCandidate, RuleResult } from '../types';
import type { Settings } from '../settings';

const MIN_MS = 60_000;
const DEFAULT_STEP_MINUTES = 30;
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ReplaySignalsInput {
  /** Full trade history across ALL tokens being replayed — replay groups internally by an inferred token key when present, but this shape (mirroring aggregateWindow's own TradeRowInput) has no explicit tokenId field, so callers replaying a single token at a time is the expected shape; see replayRunner.ts for the per-token DB-driven caller. */
  trades: TradeRowInput[];
  wallets: WalletInfoInput[];
  clusters: ClusterMembershipInput[];
  marketPoints: MarketPointInput[];
  fundingEvents: FundingEvent[];
  rotationCandidates: RotationCandidate[];
  from: Date;
  to: Date;
  /** Step size in minutes between simulated "now" instants. Default 30. */
  stepMinutes?: number;
  settings: Settings;
  /** Optional tokenId to stamp onto every ReplayedSignal (this module itself is single-token; the DB-facing runner loops per-token and passes this through). */
  tokenId?: string;
}

export interface ReplayedSignal {
  tokenId?: string;
  rule: RuleResult['rule'];
  severity: RuleResult['severity'];
  firedAt: Date;
  metrics: RuleResult['metrics'];
}

/** Builds the inclusive list of step timestamps from `from` to `to` at `stepMinutes` intervals. */
function buildSteps(from: Date, to: Date, stepMinutes: number): Date[] {
  const steps: Date[] = [];
  const stepMs = stepMinutes * MIN_MS;
  let t = from.getTime();
  const toMs = to.getTime();
  if (stepMs <= 0) {
    steps.push(new Date(t));
    return steps;
  }
  while (t <= toMs) {
    steps.push(new Date(t));
    t += stepMs;
  }
  // Ensure `to` itself is always represented as the final walked instant when
  // it wasn't already hit exactly on a step boundary — "to inclusive" per
  // this file's header.
  if (steps.length === 0 || steps[steps.length - 1]!.getTime() !== toMs) {
    steps.push(new Date(toMs));
  }
  return steps;
}

/**
 * Replays signal detection across [from, to] at `stepMinutes` resolution,
 * enforcing no-lookahead by filtering every time-series input to ts <= T
 * before evaluating each step. Returns every rule firing observed, with
 * live-parity (tokenId, rule) 24h dedupe applied across the whole walk.
 */
export function replaySignals(input: ReplaySignalsInput): ReplayedSignal[] {
  const {
    trades,
    wallets,
    clusters,
    marketPoints,
    fundingEvents,
    rotationCandidates,
    from,
    to,
    settings,
    tokenId
  } = input;
  const stepMinutes = input.stepMinutes ?? DEFAULT_STEP_MINUTES;

  const steps = buildSteps(from, to, stepMinutes);

  const results: ReplayedSignal[] = [];
  // Last-fire timestamp per rule, for the live-parity 24h dedupe.
  const lastFireByRule = new Map<RuleResult['rule'], number>();

  for (const T of steps) {
    const tMs = T.getTime();

    // --- no-lookahead filtering: ts <= T for every time-series input ---
    const tradesAsOfT = trades.filter((t) => t.ts.getTime() <= tMs);
    const marketAsOfT = marketPoints.filter((m) => m.ts.getTime() <= tMs);
    // FundingEvent has TWO timestamps that can each independently leak: the
    // funding transfer itself (event.ts) and the LAST-in-chain fundedFirstBuy.ts.
    // Filtering ONLY on event.ts <= T (as this used to do) passed through the
    // whole event — including a fundedFirstBuy dated AFTER T — to Rule E, which
    // reads firstBuy.ts/mcapAtBuy/usd directly (see rules/ruleE.ts). That is a
    // lookahead leak: the funding transfer may have happened by T, but the buy
    // it supposedly financed hasn't happened YET as of T, so Rule E must not be
    // able to see it. Mirrors rotationCandidates' own gating one line below,
    // which gates on destBuyTs (the LAST-in-chain timestamp of that chain) —
    // here we scrub the not-yet-happened tail of the chain instead of dropping
    // the whole event, since the funding transfer itself IS legitimately known
    // as of T even when the buy isn't.
    const fundingAsOfT = fundingEvents
      .filter((f) => f.ts.getTime() <= tMs)
      .map((f) =>
        f.fundedFirstBuy && f.fundedFirstBuy.ts.getTime() > tMs ? { ...f, fundedFirstBuy: undefined } : f
      );
    // rotationCandidates gates on destBuyTs — the LAST timestamp in the
    // exit->transfer->buy chain (see types.ts's RotationCandidate) — not on
    // transferTs/receiptTs, so a candidate is only visible once its ENTIRE
    // chain, including the destination buy, has happened as of T. This is the
    // same principle the fundingAsOfT fix above applies to FundingEvent: gate
    // (or scrub) on the latest event in the chain, never on an earlier one.
    const rotationAsOfT = rotationCandidates.filter((r) => r.destBuyTs.getTime() <= tMs);

    const agg30 = { ...aggregateWindow({ trades: tradesAsOfT, wallets, clusters, market: marketAsOfT, windowMinutes: 30, now: T, inflowSpikeMult: settings.rules.A.inflowSpikeMult }), tokenId: tokenId ?? '' };
    const agg24h = { ...aggregateWindow({ trades: tradesAsOfT, wallets, clusters, market: marketAsOfT, windowMinutes: 1440, now: T }), tokenId: tokenId ?? '' };

    const allResults = evaluateAllRules(agg30, agg24h, settings, {
      fundingEvents: fundingAsOfT,
      rotationCandidates: rotationAsOfT
    });

    for (const result of firedRules(allResults)) {
      const lastFire = lastFireByRule.get(result.rule);
      if (lastFire !== undefined && tMs - lastFire < DEDUPE_WINDOW_MS) {
        continue; // suppressed — same rule fired within the last 24h
      }
      lastFireByRule.set(result.rule, tMs);
      results.push({
        ...(tokenId !== undefined ? { tokenId } : {}),
        rule: result.rule,
        severity: result.severity,
        firedAt: T,
        metrics: result.metrics
      });
    }
  }

  return results;
}
