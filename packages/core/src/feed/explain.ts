// FlowRadar — buildSignalExplanation: pure plain-English explanation builder
// (Task 43 binding decision 1, Wave 3.5 Phase D).
//
// Normative source: .superpowers/sdd/ui-backtest-wave35.md Phase D (PART 1) —
// the two example paragraphs there are the tone/content bar this module is
// built to match verbatim:
//   accumulation: "36 tracked smart wallets bought $NOVA, but entity
//     clustering estimates 19 unique entities. Net smart flow is +$75k, sell
//     pressure is low, and market cap expanded only 1.4x from average smart
//     entry. This looks like accumulation, not late chase."
//   rotation: "Wallet group realized profit on $ALPHA, bridged funds through
//     Wormhole, and a linked wallet bought $BETA 65 minutes later. Amount
//     match: 80%. Confidence: probable."
//
// packages/core is PURE (zero I/O, zero framework deps) — this module takes
// plain data (ExplainInput) and settings, and returns plain strings. No
// Date.now(), no randomness — output is fully deterministic given its input.
//
// Wording discipline (binding): probabilistic only (probable/possible/
// likely/weak/strong via confidenceBand) — never an imperative ("buy"/
// "sell"), never hype ("moon", "guaranteed", etc). This is asserted by a
// cheap "no-hype lint" test in explain.test.ts and must stay true for any
// future edit to this file.

import type { Settings } from '../settings';
import { confidenceBand } from '../cluster/linkConfidence';

// ---------------------------------------------------------------------------
// Local formatters — packages/core has zero framework deps, so this does NOT
// import apps/web/lib/format.ts (that layering only flows core -> web, never
// back). Mirrors packages/core/src/alerts/templates.ts's own local
// fmtUsdLocal/fmtPctLocal convention for the identical reason.
// ---------------------------------------------------------------------------

/** Trims a trailing ".0" (e.g. "75.0" -> "75") so a round thousand/million reads as "$75k", matching the capture doc's prose style — non-round values keep their one decimal ("$75.4k"). */
function trimTrailingZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

function fmtUsdLocal(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs === 0) return '$0.00';
  if (abs >= 1_000_000_000) return `${sign}$${trimTrailingZero((abs / 1_000_000_000).toFixed(1))}B`;
  if (abs >= 1_000_000) return `${sign}$${trimTrailingZero((abs / 1_000_000).toFixed(1))}M`;
  if (abs >= 1_000) return `${sign}$${trimTrailingZero((abs / 1_000).toFixed(1))}k`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  const four = abs.toFixed(4);
  if (Number.parseFloat(four) > 0) return `${sign}$${four}`;
  return `${sign}$${abs.toFixed(6)}`;
}

function fmtSignedUsdLocal(n: number): string {
  const formatted = fmtUsdLocal(Math.abs(n));
  if (n > 0) return `+${formatted}`;
  if (n < 0) return `-${formatted}`;
  return formatted;
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type ExplainRule = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

export interface ExplainMetrics {
  rawWalletCount: number;
  uniqueEntityCount: number;
  largestClusterSize: number;
  netFlowUsd: number;
  /** Buyer-share (0-100) that has sold anything — mirrors ruleA.ts's soldPct. */
  soldPct: number;
  /** currentMcap / avgEntry (1.0 = no growth, 1.4 = +40%). */
  mcapMultiplier: number;
  liquidityUsd: number;
}

export interface ExplainRotation {
  sourceSymbol: string;
  destSymbol: string;
  bridged: boolean;
  bridgeProtocol?: string;
  timeGapMin: number;
  valueMatchPct: number;
  /** 0-100 raw confidence score — banded via confidenceBand (weak/possible/probable/strong). */
  confidence: number;
}

export interface ExplainPrevious {
  smartWalletCount: number;
  netFlowUsd: number;
  mcapMultiplier: number;
}

export interface ExplainInput {
  rule: ExplainRule;
  severity: 'INFO' | 'WATCH' | 'HIGH' | 'CRITICAL';
  symbol: string;
  metrics: ExplainMetrics;
  rotation?: ExplainRotation;
  previous?: ExplainPrevious;
  settings: Settings;
}

export interface SignalExplanation {
  headline: string;
  whyFired: string[];
  wouldInvalidate: string[];
  whatChanged: string | null;
  conclusion: string;
}

// ---------------------------------------------------------------------------
// whyFired — accumulation-family sentence (rules A/B/C/D/E all read the same
// evidence block; the exact wording mirrors the capture doc's NOVA example).
// ---------------------------------------------------------------------------

function buildAccumulationWhyFired(input: ExplainInput): string[] {
  const { symbol, metrics } = input;
  const sellPressureWord = metrics.soldPct < 20 ? 'low' : metrics.soldPct < 40 ? 'moderate' : 'high';

  const sentence1 = `${metrics.rawWalletCount} tracked smart wallets bought $${symbol}, but entity clustering estimates ${metrics.uniqueEntityCount} unique entities.`;
  const sentence2 = `Net smart flow is ${fmtSignedUsdLocal(metrics.netFlowUsd)}, sell pressure is ${sellPressureWord} (${metrics.soldPct.toFixed(0)}% of buyers have sold), and market cap expanded only ${metrics.mcapMultiplier.toFixed(1)}x from average smart entry.`;

  return [sentence1, sentence2];
}

// ---------------------------------------------------------------------------
// whyFired — exit-warning (rule G) sentence.
// ---------------------------------------------------------------------------

function buildExitWarningWhyFired(input: ExplainInput): string[] {
  const { symbol, metrics } = input;
  const sentence1 = `${metrics.rawWalletCount} previously-tracked smart wallets are showing distribution on $${symbol} — ${metrics.soldPct.toFixed(0)}% of buyers have sold their position.`;
  const sentence2 = `Net smart flow has turned to ${fmtSignedUsdLocal(metrics.netFlowUsd)}, and liquidity stands at ${fmtUsdLocal(metrics.liquidityUsd)}.`;
  return [sentence1, sentence2];
}

// ---------------------------------------------------------------------------
// whyFired — profit-rotation (rule F) sentence, mirrors the capture doc's
// $ALPHA -> $BETA example verbatim in shape.
// ---------------------------------------------------------------------------

function buildRotationWhyFired(input: ExplainInput): string[] {
  const rotation = input.rotation as ExplainRotation;
  const band = confidenceBand(rotation.confidence);

  const bridgeClause = rotation.bridged
    ? `, bridged funds through ${rotation.bridgeProtocol ?? 'a cross-chain bridge'},`
    : ',';

  const sentence1 = `Wallet group realized profit on $${rotation.sourceSymbol}${bridgeClause} and a linked wallet bought $${rotation.destSymbol} ${rotation.timeGapMin.toFixed(0)} minutes later.`;
  const sentence2 = `Amount match: ${rotation.valueMatchPct.toFixed(0)}%. Confidence: ${band}.`;

  return [sentence1, sentence2];
}

// ---------------------------------------------------------------------------
// wouldInvalidate — derived from the rule's own settings thresholds, so a
// changed setting produces a changed line (binding decision 1's invalidation
// test).
// ---------------------------------------------------------------------------

function buildAccumulationWouldInvalidate(settings: Settings): string[] {
  const { A } = settings.rules;
  return [
    `Sell pressure rising above ${A.maxSoldPct}% of buyers`,
    `Market cap expanding beyond ${settings.rules.B.maxMcapExpansion}× average smart entry`,
    'Net smart flow turning negative'
  ];
}

function buildExitWarningWouldInvalidate(settings: Settings): string[] {
  const { G } = settings.rules;
  return [
    `Exited smart-wallet share dropping back below ${G.minExitedPct}%`,
    `Liquidity stabilizing (no further drop beyond ${G.liquidityDropPct}%)`,
    'Net smart flow turning positive with new smart buyers returning'
  ];
}

function buildRotationWouldInvalidate(settings: Settings): string[] {
  const { F } = settings.rules;
  return [
    `Amount match falling outside the ${F.minValueMatchPct}-${F.maxValueMatchPct}% band`,
    `Re-buy landing beyond the ${F.maxBuyDelayMin}-minute window`,
    'No further linked wallets repeating the pattern'
  ];
}

// ---------------------------------------------------------------------------
// whatChanged — deltas from a previous snapshot, or null.
// ---------------------------------------------------------------------------

function buildWhatChanged(input: ExplainInput): string | null {
  const { previous, metrics } = input;
  if (!previous) return null;

  const walletDelta = metrics.rawWalletCount - previous.smartWalletCount;
  const flowDelta = metrics.netFlowUsd - previous.netFlowUsd;

  const walletPart = `${walletDelta >= 0 ? '+' : ''}${walletDelta} smart wallet${Math.abs(walletDelta) === 1 ? '' : 's'}`;
  const flowPart = `${fmtSignedUsdLocal(flowDelta)} net flow`;

  return `${walletPart} and ${flowPart} since the last check.`;
}

// ---------------------------------------------------------------------------
// conclusion — per rule family.
// ---------------------------------------------------------------------------

const ACCUMULATION_FAMILY: ExplainRule[] = ['A', 'B', 'C', 'D', 'E'];

function buildConclusion(input: ExplainInput): string {
  const { rule, metrics, rotation } = input;

  if (rule === 'F' && rotation) {
    const band = confidenceBand(rotation.confidence);
    return `This looks like a ${band} profit rotation from $${rotation.sourceSymbol} into $${rotation.destSymbol}, not a coincidental buy.`;
  }

  if (rule === 'G') {
    return 'This looks like an exit warning — smart money distribution, not fresh accumulation.';
  }

  if (ACCUMULATION_FAMILY.includes(rule)) {
    if (metrics.mcapMultiplier < 1.5) {
      return 'This looks like accumulation, not late chase.';
    }
    if (metrics.mcapMultiplier > 2) {
      return 'This looks like expansion already underway — late-entry risk.';
    }
    return 'This sits between early accumulation and a confirmed chase — worth continued watching, not yet a clear read.';
  }

  return 'No clear read yet — insufficient signal to characterize this move.';
}

// ---------------------------------------------------------------------------
// headline
// ---------------------------------------------------------------------------

function buildHeadline(input: ExplainInput): string {
  const { rule, severity, symbol, rotation } = input;

  if (rule === 'F' && rotation) {
    return `$${rotation.sourceSymbol} → $${rotation.destSymbol}: probable profit rotation`;
  }
  if (rule === 'G') {
    return `$${symbol}: exit warning (${severity.toLowerCase()})`;
  }
  return `$${symbol}: ${severity.toLowerCase()} signal (rule ${rule})`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds a plain-English explanation for a fired signal — headline, why it
 * fired (real numbers inline), what would invalidate it (derived from the
 * rule's own settings thresholds), what changed since the previous check (or
 * null), and a probabilistic concluding read. Pure — deterministic given its
 * input, no I/O.
 */
export function buildSignalExplanation(input: ExplainInput): SignalExplanation {
  const { rule, settings } = input;

  let whyFired: string[];
  let wouldInvalidate: string[];

  if (rule === 'F' && input.rotation) {
    whyFired = buildRotationWhyFired(input);
    wouldInvalidate = buildRotationWouldInvalidate(settings);
  } else if (rule === 'G') {
    whyFired = buildExitWarningWhyFired(input);
    wouldInvalidate = buildExitWarningWouldInvalidate(settings);
  } else {
    whyFired = buildAccumulationWhyFired(input);
    wouldInvalidate = buildAccumulationWouldInvalidate(settings);
  }

  return {
    headline: buildHeadline(input),
    whyFired,
    wouldInvalidate,
    whatChanged: buildWhatChanged(input),
    conclusion: buildConclusion(input)
  };
}
