// FlowRadar — post-entry behavior classifier (pure; dormancy plan Task 10).
//
// Classifies what ONE wallet did with ONE token AFTER its observed entry,
// using the already-reconstructed TokenPositionSummary (behavior engine) plus
// token-scoped outbound-transfer evidence and receipts-engine burst flags.
//
// Honesty rules (binding):
//   - Forward-looking ONLY: every input is derived from events at/after the
//     entry; nothing here feeds pre-entry dormancy.
//   - A transfer is NEVER a sale without evidence: outbound token flows are
//     labeled transfer_to_linked / transfer_to_service / unknown-destination
//     and reported separately from exits.
//   - Truncated/unpriced local views degrade confidence and are caveated —
//     'unknown' is an honest terminal class, never a default guess.
//   - Multiple labels may apply (a fast flip IS a full exit); the primary
//     class picks the most specific by a versioned, documented order.
//   - Observation-only: nothing here grants eligibility or promotion.

export const POST_ENTRY_ENGINE_VERSION = 1;

export type PostEntryClass =
  | 'durable_hold'
  | 'partial_exit'
  | 'full_exit'
  | 'fast_flip'
  | 'fast_dump'
  | 'burst_exit'
  | 'staged_distribution'
  | 'transfer_to_linked'
  | 'transfer_to_service'
  | 'still_holding'
  | 'unknown';

export interface PostEntryConfig {
  /** Full exit within this after entry == fast_flip. */
  fastFlipMaxSec: number;
  /** FIRST sell within this after entry (with heavy exit) == fast_dump. */
  fastDumpMaxSec: number;
  /** exitRatio >= this counts as a full exit. Matches behavior engine (0.95). */
  fullExitRatio: number;
  /** exitRatio >= this qualifies fast_dump / staged heaviness. */
  heavyExitRatio: number;
  /** Held with no full exit for at least this == durable_hold. */
  durableMinHoldSec: number;
  /** staged_distribution needs >= this many sells... */
  stagedMinSells: number;
  /** ...spread over at least this long. */
  stagedMinSpanSec: number;
}

export const DEFAULT_POST_ENTRY_CONFIG: PostEntryConfig = {
  fastFlipMaxSec: 3600,
  fastDumpMaxSec: 300,
  fullExitRatio: 0.95,
  heavyExitRatio: 0.9,
  durableMinHoldSec: 30 * 86_400,
  stagedMinSells: 4,
  stagedMinSpanSec: 86_400
};

export interface PostEntryInput {
  /** From TokenPositionSummary (behavior engine) — entry-forward facts. */
  position: {
    buyCount: number;
    sellCount: number;
    buyUsd: number;
    sellUsd: number;
    firstBuyTs: string | null;
    lastSellTs: string | null;
    timeToFirstSellSec: number | null;
    exitRatio: number | null;
    stillHolding: boolean;
    fullExitSec: number | null;
  };
  /** First sell ts when known (position only carries last sell). */
  firstSellTs?: string | null;
  /** Token-scoped OUTBOUND transfers at/after entry (evidence-labeled). */
  outboundTransfers: {
    total: number;
    toLinked: number;
    toService: number;
    toUnknown: number;
  };
  /** Receipts-engine single_burst_exit evidence for this (wallet, token). */
  burstExitReceipt: boolean;
  /** Local view truncated/unpriced — honesty degrade. */
  localViewTruncated: boolean;
  /** Observation time — bounds "held so far" for durable/still-holding. */
  now: Date;
}

export interface PostEntryDecision {
  primaryClass: PostEntryClass;
  labels: PostEntryClass[];
  confidence: number; // 0-100, capped 90 (bounded local observation)
  reasonCodes: string[];
  caveats: string[];
  engineVersion: number;
}

const BASE_CAVEATS = [
  'entry-forward local observation only — unobserved external activity cannot be excluded',
  'outbound token transfers are labeled by destination evidence, never assumed to be sales',
  'observation-only: nothing here grants signal eligibility, votes, or promotion'
];

const cap = (n: number) => Math.max(0, Math.min(90, Math.round(n)));

/**
 * THE post-entry rule (pure, versioned). Primary-class specificity order:
 * fast_dump > fast_flip > burst_exit > staged_distribution > full_exit >
 * partial_exit > transfer_to_* > durable_hold > still_holding > unknown —
 * EXIT evidence always outranks transfer labels for the primary class
 * (transfers stay as secondary labels; they are never sales).
 */
export function classifyPostEntryBehavior(
  input: PostEntryInput,
  configOverride: Partial<PostEntryConfig> = {}
): PostEntryDecision {
  const config: PostEntryConfig = { ...DEFAULT_POST_ENTRY_CONFIG, ...configOverride };
  const p = input.position;
  const labels = new Set<PostEntryClass>();
  const reasons: string[] = [];
  const caveats = [...BASE_CAVEATS];

  const entryMs = p.firstBuyTs ? new Date(p.firstBuyTs).getTime() : NaN;
  const heldSoFarSec = Number.isNaN(entryMs) ? null : Math.round((input.now.getTime() - entryMs) / 1000);
  const exitRatio = p.exitRatio;

  // No local entry (received-not-bought or malformed) => unknown, honestly.
  if (p.firstBuyTs === null || Number.isNaN(entryMs) || p.buyCount === 0) {
    return {
      primaryClass: 'unknown',
      labels: ['unknown'],
      confidence: 20,
      reasonCodes: ['no_locally_observed_entry'],
      caveats,
      engineVersion: POST_ENTRY_ENGINE_VERSION
    };
  }

  const fullyExited = exitRatio !== null && exitRatio >= config.fullExitRatio && p.fullExitSec !== null;
  const heavyExit = exitRatio !== null && exitRatio >= config.heavyExitRatio;
  const partialExit = !fullyExited && p.sellCount > 0 && exitRatio !== null && exitRatio > 0;

  if (fullyExited) {
    labels.add('full_exit');
    reasons.push('cumulative_sells_crossed_full_exit_threshold');
    if ((p.fullExitSec as number) <= config.fastFlipMaxSec) {
      labels.add('fast_flip');
      reasons.push('full_exit_within_fast_flip_window');
    }
  }
  if (
    heavyExit &&
    p.timeToFirstSellSec !== null &&
    p.timeToFirstSellSec <= config.fastDumpMaxSec
  ) {
    labels.add('fast_dump');
    reasons.push('heavy_exit_started_within_fast_dump_window');
  }
  if (input.burstExitReceipt) {
    labels.add('burst_exit');
    reasons.push('receipts_engine_single_burst_exit');
  }
  // Staged distribution: many sells spread over a long span, heavy in total.
  if (p.sellCount >= config.stagedMinSells && heavyExit && input.firstSellTs && p.lastSellTs) {
    const spanSec = Math.round(
      (new Date(p.lastSellTs).getTime() - new Date(input.firstSellTs).getTime()) / 1000
    );
    if (spanSec >= config.stagedMinSpanSec) {
      labels.add('staged_distribution');
      reasons.push('many_sells_spread_over_long_span');
    }
  }
  if (partialExit) {
    labels.add('partial_exit');
    reasons.push('partial_sells_below_full_exit_threshold');
  }
  // Transfers are EVIDENCE-labeled, never sales.
  if (input.outboundTransfers.toLinked > 0) {
    labels.add('transfer_to_linked');
    reasons.push('outbound_token_transfer_to_probable_linked_wallet');
  }
  if (input.outboundTransfers.toService > 0) {
    labels.add('transfer_to_service');
    reasons.push('outbound_token_transfer_to_service_node');
  }
  if (input.outboundTransfers.toUnknown > 0) {
    caveats.push(
      `${input.outboundTransfers.toUnknown} outbound token transfer(s) to unlabeled destinations — not counted as exits or links`
    );
  }
  // Holding shapes.
  if (p.stillHolding && p.sellCount === 0) {
    labels.add('still_holding');
    reasons.push('no_local_sells_observed');
    if (heldSoFarSec !== null && heldSoFarSec >= config.durableMinHoldSec) {
      labels.add('durable_hold');
      reasons.push('held_beyond_durable_threshold');
    }
  }

  if (labels.size === 0) {
    labels.add('unknown');
    reasons.push('no_classifiable_post_entry_shape');
  }

  // Primary class by specificity.
  const order: PostEntryClass[] = [
    'fast_dump',
    'fast_flip',
    'burst_exit',
    'staged_distribution',
    'full_exit',
    'partial_exit',
    'transfer_to_linked',
    'transfer_to_service',
    'durable_hold',
    'still_holding',
    'unknown'
  ];
  const primaryClass = order.find((c) => labels.has(c)) as PostEntryClass;

  let confidence = cap(labels.has('unknown') ? 25 : 75);
  if (input.localViewTruncated) {
    confidence = Math.min(confidence, 45);
    caveats.push('local trade view truncated — position shapes may be artifacts of the cut');
  }

  return {
    primaryClass,
    labels: order.filter((c) => labels.has(c)),
    confidence,
    reasonCodes: reasons,
    caveats,
    engineVersion: POST_ENTRY_ENGINE_VERSION
  };
}
