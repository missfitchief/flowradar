// FlowRadar — meaningful-activity classifier (pure; dormancy plan Task 6).
//
// Classifies ONE wallet-perspective activity event (a local trade or a
// money-flow transfer) into an economic-significance class. This is the
// gatekeeper for every dormancy calculation downstream (Tasks 7/8): only
// events classified MEANINGFUL may establish or reset dormancy — dust,
// spam, service interactions, self-transfers, artifacts and unknown-value
// events NEVER do.
//
// Honesty rules (binding):
//   - Missing valuation => 'unknown_value'. Unknown is NEVER dust, NEVER
//     meaningful, NEVER zero. It is a recorded state of ignorance.
//   - Service interactions are classified by REGISTRY/degree evidence the
//     caller supplies (exact-address lookups / lineage isServiceNode) — never
//     by symbol text or provider labels.
//   - Every decision carries reason codes, a rule version, a confidence and
//     a receipt so it can be audited and re-derived.
//   - Nothing here grants signal eligibility or any promotion.

// v2 — the classification CONTRACT (what the DB layer feeds this classifier)
// changed after the Batch-A adversarial review: (a) TRANSFER_IN/OUT trade
// rows are fed as counterparty-less transfers (counterpartyKnown:false =>
// 'unknown_counterparty', never meaningful pseudo-SELLs) and LP_ADD/LP_REMOVE
// as pool service interactions; (b) legacy trades whose amountUsd carries the
// 0-for-unpriced ingest marker are fed as usd=null (unknown_value, never
// dust); (c) transfer counterparty service detection is registry + REAL
// bounded fan-out degree (never a fabricated degree of 0). Rows persisted
// under v1 are stale and are re-persisted by the Task 7 context loader.
export const MEANINGFUL_ACTIVITY_RULES_VERSION = 2;

export type ActivityEventKind = 'trade' | 'transfer';

/** Wallet-perspective role: trade side, or transfer direction. */
export type ActivityEventRole = 'BUY' | 'SELL' | 'in' | 'out';

export type ActivityClassification =
  | 'meaningful_trade'
  | 'meaningful_transfer'
  | 'dust'
  | 'service_interaction'
  | 'non_economic'
  | 'artifact'
  | 'unknown_value'
  | 'unknown_counterparty';

export interface ActivityEvent {
  kind: ActivityEventKind;
  role: ActivityEventRole;
  /**
   * HONEST USD valuation. null == valuation unavailable (e.g. an unpriced
   * money-flow edge whose valuedUsd is NULL). Callers must NEVER substitute
   * 0 for unknown — pass null and the event classifies as 'unknown_value'.
   */
  usd: number | null;
  /** 0-100 confidence of the valuation itself when the source records one. */
  valuationConfidence?: number | null;
  ts: Date;
  txHash: string;
  tokenAddress?: string | null;
  /** transfer-only: the other side of the flow (wallet perspective). */
  counterpartyAddress?: string | null;
  /**
   * transfer-only: counterparty is a known service node — AddressRegistry
   * category (CEX/bridge/router/pool/token contract/mixer) or lineage
   * degree-based isServiceNode. Decided by the CALLER from registry data.
   */
  counterpartyIsService?: boolean;
  /** Human-readable basis for the service flag (receipt field). */
  counterpartyServiceBasis?: string | null;
  /** transfer-only: source address === destination address. */
  selfTransfer?: boolean;
  /**
   * transfer-only: set FALSE when the source row cannot name the other side
   * of the flow (e.g. TRANSFER_IN/TRANSFER_OUT rows in the trades table).
   * An unverifiable counterparty could be a service or the wallet itself, so
   * such an event can NEVER classify meaningful — it becomes
   * 'unknown_counterparty' regardless of its value.
   */
  counterpartyKnown?: boolean;
}

export interface MeaningfulActivityConfig {
  /** KNOWN value at or below this is dust. Matches lineage dustMaxUsd ($1). */
  dustMaxUsd: number;
}

export const DEFAULT_MEANINGFUL_ACTIVITY_CONFIG: MeaningfulActivityConfig = {
  dustMaxUsd: 1
};

export interface ActivityDecisionReceipt {
  txHash: string;
  ts: string;
  kind: ActivityEventKind;
  role: ActivityEventRole;
  usd: number | null;
  tokenAddress: string | null;
  counterpartyAddress: string | null;
  counterpartyServiceBasis: string | null;
  dustMaxUsd: number;
}

export interface ActivityDecision {
  classification: ActivityClassification;
  /** True ONLY for meaningful_trade / meaningful_transfer. */
  meaningful: boolean;
  reasonCodes: string[];
  ruleVersion: number;
  /** 0-100 confidence in the ECONOMIC reading of the event. */
  confidence: number;
  receipt: ActivityDecisionReceipt;
}

function clampConfidence(base: number, valuationConfidence: number | null | undefined): number {
  if (valuationConfidence == null) return base;
  // A weakly-priced valuation weakens any value-based decision, floor 30.
  return Math.max(30, Math.min(base, Math.round(valuationConfidence)));
}

function receiptOf(event: ActivityEvent, config: MeaningfulActivityConfig): ActivityDecisionReceipt {
  return {
    txHash: event.txHash,
    ts: event.ts instanceof Date && !Number.isNaN(event.ts.getTime()) ? event.ts.toISOString() : 'invalid',
    kind: event.kind,
    role: event.role,
    usd: event.usd,
    tokenAddress: event.tokenAddress ?? null,
    counterpartyAddress: event.counterpartyAddress ?? null,
    counterpartyServiceBasis: event.counterpartyServiceBasis ?? null,
    dustMaxUsd: config.dustMaxUsd
  };
}

/**
 * THE per-event rule. Decision order is load-bearing and versioned:
 *   1. artifact             — malformed rows never contaminate dormancy inputs
 *   2. service              — service flows never reset dormancy, whatever their value
 *   3. non_economic         — self-transfers move nothing between entities
 *   4. unknown_counterparty — a transfer whose other side cannot be named can
 *                             never be proven non-service/non-self => never meaningful
 *   5. unknown_value        — missing valuation is recorded ignorance (never dust,
 *                             never meaningful; deferred to revaluation)
 *   6. dust                 — known value <= dustMaxUsd
 *   7. meaningful           — known value above the dust threshold
 */
export function classifyActivityEvent(
  event: ActivityEvent,
  configOverride: Partial<MeaningfulActivityConfig> = {}
): ActivityDecision {
  const config: MeaningfulActivityConfig = { ...DEFAULT_MEANINGFUL_ACTIVITY_CONFIG, ...configOverride };
  const receipt = receiptOf(event, config);
  const base = { ruleVersion: MEANINGFUL_ACTIVITY_RULES_VERSION, receipt };

  // 1. artifact — malformed source rows.
  const artifactReasons: string[] = [];
  if (!event.txHash || event.txHash.trim() === '') artifactReasons.push('missing_tx_hash');
  if (!(event.ts instanceof Date) || Number.isNaN(event.ts.getTime())) artifactReasons.push('invalid_timestamp');
  if (event.usd !== null && !Number.isFinite(event.usd)) artifactReasons.push('non_finite_value');
  if (event.usd !== null && Number.isFinite(event.usd) && event.usd < 0) artifactReasons.push('negative_value');
  if (artifactReasons.length > 0) {
    return { ...base, classification: 'artifact', meaningful: false, reasonCodes: artifactReasons, confidence: 95 };
  }

  // 2. service interaction — registry/degree evidence supplied by the caller.
  if (event.kind === 'transfer' && event.counterpartyIsService === true) {
    return {
      ...base,
      classification: 'service_interaction',
      meaningful: false,
      reasonCodes: ['counterparty_service_node'],
      confidence: 90
    };
  }

  // 3. non-economic — self-transfer moves nothing between entities.
  if (event.kind === 'transfer' && event.selfTransfer === true) {
    return { ...base, classification: 'non_economic', meaningful: false, reasonCodes: ['self_transfer'], confidence: 95 };
  }

  // 4. unknown counterparty — the other side of the flow cannot be named, so
  // service/self cannot be ruled out. NEVER meaningful, whatever the value.
  if (event.kind === 'transfer' && event.counterpartyKnown === false) {
    return {
      ...base,
      classification: 'unknown_counterparty',
      meaningful: false,
      reasonCodes: ['counterparty_unavailable'],
      confidence: 30
    };
  }

  // 5. unknown value — recorded ignorance. NEVER falls through to dust.
  if (event.usd === null) {
    return {
      ...base,
      classification: 'unknown_value',
      meaningful: false,
      reasonCodes: ['valuation_unavailable'],
      confidence: 20
    };
  }

  // 6. dust — known value at or below the threshold.
  if (event.usd <= config.dustMaxUsd) {
    const reasons = ['below_dust_threshold'];
    if (event.kind === 'transfer' && event.role === 'in') reasons.push('inbound_dust_possible_spam');
    return {
      ...base,
      classification: 'dust',
      meaningful: false,
      reasonCodes: reasons,
      confidence: clampConfidence(85, event.valuationConfidence)
    };
  }

  // 7. meaningful.
  return {
    ...base,
    classification: event.kind === 'trade' ? 'meaningful_trade' : 'meaningful_transfer',
    meaningful: true,
    reasonCodes: ['value_above_dust_threshold'],
    confidence: clampConfidence(90, event.valuationConfidence)
  };
}

export interface ActivityBatchSummary {
  decisions: ActivityDecision[];
  byClass: Record<string, number>;
  meaningfulCount: number;
}

/** Convenience batch wrapper (pure): classify many events + tally classes. */
export function classifyActivityEvents(
  events: ActivityEvent[],
  configOverride: Partial<MeaningfulActivityConfig> = {}
): ActivityBatchSummary {
  const decisions = events.map((e) => classifyActivityEvent(e, configOverride));
  const byClass: Record<string, number> = {};
  let meaningfulCount = 0;
  for (const d of decisions) {
    byClass[d.classification] = (byClass[d.classification] ?? 0) + 1;
    if (d.meaningful) meaningfulCount += 1;
  }
  return { decisions, byClass, meaningfulCount };
}
