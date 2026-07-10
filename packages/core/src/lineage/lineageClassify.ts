// FlowRadar — Capital Lineage Engine (Phase 6b): pure classification.
//
// The receiver-enrollment rule and relationship scoring are the load-bearing
// decisions of the lineage engine. They live here as pure functions (plain
// data in, verdict out — no I/O, no DB) so every spec branch is unit-pinned
// and the DB worker is a thin orchestrator over them.
//
// Ethics contract (operator rules 9-10): confidence is a probabilistic score
// (possible/probable/strong bands), NEVER an identity claim.

import type { WalletRelationshipKind } from '../types';

type LineageConfig = {
  minTransferUsd: number;
  gasFundingMaxUsd: number;
  gasFundingMinSol: number;
  gasFundingMaxSol: number;
  dustMaxUsd: number;
  serviceDegreeThreshold: number;
};

export interface ServiceNodeContext {
  /** AddressRegistry category if the address is a known service, else null. */
  registryCategory: 'CEX' | 'BRIDGE' | 'ROUTER' | 'POOL' | 'DEPLOYER' | 'MIXER' | 'TOKEN_CONTRACT' | null;
  /** Distinct counterparties observed for this address (fan-out degree). */
  distinctCounterparties: number;
}

const NON_EXPAND_CATEGORIES = new Set(['CEX', 'BRIDGE', 'ROUTER', 'POOL', 'TOKEN_CONTRACT', 'MIXER']);

/**
 * A service node is graph-visible but NEVER recursively expanded: a known
 * registry service (CEX/bridge/router/pool/token contract/mixer) or an
 * unregistered high-degree hub (dust/airdrop distributor territory).
 */
export function isServiceNode(ctx: ServiceNodeContext, config: LineageConfig): boolean {
  if (ctx.registryCategory !== null && NON_EXPAND_CATEGORIES.has(ctx.registryCategory)) return true;
  return ctx.distinctCounterparties >= config.serviceDegreeThreshold;
}

export interface ReceiverContext {
  /** Sender is a root, signal_eligible, or strong-linked wallet. */
  senderTrusted: boolean;
  /** USD value of the transfer (0 when unknown/unpriced). */
  transferUsd: number;
  /** True when the transfer is native SOL (gas-funding exception is SOL-only). */
  isNativeSol: boolean;
  /** Raw native-SOL amount (for the raw-SOL gas path when USD is unavailable); null otherwise. */
  rawSolAmount?: number | null;
  /** True when the transfer's USD value could NOT be determined — the ONLY case the raw-SOL gas path may fire (a valued transfer uses the USD min/dust logic). */
  usdUnavailable?: boolean;
  /** Receiver is fresh / empty / previously unknown / long-inactive. */
  receiverIsFreshOrInactive: boolean;
  /** Receiver is a service/program/router/pool/bridge/CEX (never hot-enroll). */
  receiverIsServiceOrProgram: boolean;
  /** This is the receiver's first meaningful incoming transfer. */
  isReceiverFirstMeaningfulInbound: boolean;
  /** Receiver became active within gasFundingActivationHours of the transfer. */
  receiverBecameActiveWithinWindow: boolean;
}

export interface EnrollmentVerdict {
  /** Hot-enroll the receiver (fresh_receiver_hot subscription + shallow backfill). */
  enroll: boolean;
  /** Always persist the transfer edge first, even when not enrolling. */
  persistEdge: boolean;
  /** Relationship to record; undefined for dust / no-relationship cases. */
  relationshipKind?: WalletRelationshipKind;
  /** Enrolled subscriptions are always hot when enroll is true. */
  hot: boolean;
  /** The gas-funding exception carried this enrollment below minTransferUsd. */
  viaGasException: boolean;
  /** Inbound was dust (<= dustMaxUsd): edge only, no enrollment, no strong link. */
  dust: boolean;
  /**
   * Inbound value is UNKNOWN (a valuation was attempted but USD is unavailable
   * and the raw-SOL gas path did not apply): edge stored, NOT enrolled, and —
   * critically — NOT classified as dust. Unknown ≠ zero/safe: it is deferred to
   * revaluation, which reopens the node and re-runs enrollment once a price is
   * available. Distinct from `dust` so an unpriced (possibly large) transfer is
   * never silently treated as benign.
   */
  unknown: boolean;
  /** Human-readable decision reason (audit + stop-reason persistence). */
  reason: string;
}

/**
 * THE immediate-receiver enrollment rule (operator "load-bearing rule").
 * Ordering matters: service receivers and untrusted senders are rejected
 * before value tests; dust short-circuits; the gas exception is the only path
 * that enrolls below minTransferUsd.
 */
export function classifyReceiverEnrollment(ctx: ReceiverContext, config: LineageConfig): EnrollmentVerdict {
  const base = { persistEdge: true, hot: false, viaGasException: false, dust: false, unknown: false };

  if (!ctx.senderTrusted) {
    return { ...base, enroll: false, reason: 'sender is untrusted (not root/signal_eligible/strong-linked)' };
  }
  if (ctx.receiverIsServiceOrProgram) {
    return { ...base, enroll: false, reason: 'receiver is a service/program node — edge stored, never hot-enrolled' };
  }

  // RAW-SOL gas-funding path (Wave B2): a FIRST native-SOL funding whose USD
  // value is UNAVAILABLE (Helius doesn't price native SOL) can still enroll on
  // the RAW SOL amount alone — bounded to [gasFundingMinSol, gasFundingMaxSol]
  // — when the receiver is fresh, this is its first meaningful inbound, and it
  // becomes active within the window. Gated on usdUnavailable (Codex Wave-B
  // P1): a VALUED transfer must NOT use this path — it goes through the USD
  // min/dust logic below, so a valued sub-threshold or dust transfer can't
  // sneak in via the raw amount.
  if (
    ctx.usdUnavailable === true &&
    ctx.isNativeSol &&
    ctx.rawSolAmount != null &&
    ctx.rawSolAmount >= config.gasFundingMinSol &&
    ctx.rawSolAmount <= config.gasFundingMaxSol &&
    ctx.receiverIsFreshOrInactive &&
    ctx.isReceiverFirstMeaningfulInbound &&
    ctx.receiverBecameActiveWithinWindow
  ) {
    return {
      ...base,
      enroll: true,
      hot: true,
      viaGasException: true,
      relationshipKind: 'first_funder',
      reason: 'raw-SOL gas-funding exception — first native-SOL funding within bounds + prompt activation (USD unavailable)'
    };
  }

  // UNKNOWN value (Codex final review): a transfer whose USD is unavailable and
  // which the raw-SOL gas path above did NOT enroll must NOT fall through to the
  // dust test below — its classificationUsd is a placeholder 0, and calling a
  // possibly-large unpriced transfer "dust" would treat unknown as benign
  // (violates "unknown ≠ zero/safe"). Persist the edge, do not enroll, and defer
  // to revaluation (which reopens the node once a price exists).
  if (ctx.usdUnavailable === true) {
    return { ...base, enroll: false, unknown: true, reason: 'USD value unavailable — edge stored, value UNKNOWN (never dust); deferred to revaluation' };
  }

  // Dust is dust regardless of asset (2026-07-10 Codex review): the USD
  // gas-funding exception below requires transferUsd strictly ABOVE dustMaxUsd.
  if (ctx.transferUsd <= config.dustMaxUsd) {
    return { ...base, enroll: false, dust: true, reason: 'inbound is dust — edge stored, no enrollment, no strong relationship' };
  }
  if (!ctx.receiverIsFreshOrInactive) {
    return { ...base, enroll: false, reason: 'receiver is already active (not fresh/empty/inactive) — edge stored, no hot enrollment' };
  }

  const kind: WalletRelationshipKind = ctx.isReceiverFirstMeaningfulInbound ? 'first_funder' : 'direct_funding';

  if (ctx.transferUsd >= config.minTransferUsd) {
    return { ...base, enroll: true, hot: true, relationshipKind: kind, reason: `above minTransferUsd — enrolled as ${kind}` };
  }

  // Gas-funding exception: a small FIRST native-SOL funding from a trusted
  // sender whose receiver activates shortly after.
  const gasEligible =
    ctx.isNativeSol &&
    ctx.isReceiverFirstMeaningfulInbound &&
    ctx.receiverBecameActiveWithinWindow &&
    ctx.transferUsd <= config.gasFundingMaxUsd &&
    ctx.transferUsd > config.dustMaxUsd;
  if (gasEligible) {
    return {
      ...base,
      enroll: true,
      hot: true,
      viaGasException: true,
      relationshipKind: 'first_funder',
      reason: 'gas-funding exception — small first native-SOL funding + prompt activation'
    };
  }

  return { ...base, enroll: false, reason: 'below minTransferUsd and no gas-funding exception applies' };
}

export interface RelationshipEvidence {
  /** Receiver became active after the funding (raises confidence). */
  activated: boolean;
  /** Number of observed interactions of this kind (repeated_transfer growth). */
  interactionCount: number;
}

/**
 * Probabilistic relationship confidence 0-100. Bands (via @flowradar/core
 * confidenceBand): possible <50, probable 50-79, strong >=80. NOT an identity
 * claim — a strong first-funder-with-activation is "strong on-chain link".
 */
export function relationshipConfidence(kind: WalletRelationshipKind, evidence: RelationshipEvidence): number {
  switch (kind) {
    case 'first_funder':
      return evidence.activated ? 85 : 65;
    case 'fresh_wallet_activation':
      return evidence.activated ? 80 : 60;
    case 'direct_funding':
      return 60;
    case 'repeated_transfer': {
      // 40 base, +5 per interaction beyond the first, capped at 100.
      return Math.min(100, 40 + (evidence.interactionCount - 1) * 5);
    }
    case 'service_interrupted':
      return 30;
    case 'unknown':
    default:
      return 20;
  }
}
