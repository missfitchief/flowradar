// FlowRadar — Capital Lineage Engine (Phase 6b): receiver enrollment + edge
// persistence. This is the operator's "load-bearing rule" — when a trusted
// wallet (root / signal_eligible / strong-linked) funds a fresh receiver, the
// transfer edge is persisted FIRST, then the receiver is upserted
// observation_only, a relationship recorded, a hot subscription created, and
// an expansion node enqueued — all BEFORE any PnL verification, and the
// receiver is NEVER made signal_eligible automatically.
//
// Edges use the canonical MoneyFlowEdge (extended, not duplicated). Idempotency
// is first-write-wins on (txHash, from, to, transfer-family) — the same as
// ingest.ts — so duplicate webhooks/txs never inflate counts.

import type { PrismaClient, Prisma, MoneyFlowActionType } from '@prisma/client';
import {
  classifyReceiverEnrollment,
  isServiceNode,
  relationshipConfidence,
  type ReceiverContext,
  type Settings,
  type WalletRelationshipKind
} from '@flowradar/core';

export interface TransferObservation {
  txHash: string;
  slot: bigint;
  ts: Date;
  fromAddress: string;
  toAddress: string;
  asset: string;
  amountToken: number;
  amountUsd: number;
  isNativeSol: boolean;
  /** Provider that surfaced this transfer (audit). */
  provider: string;
}

export interface EnrollReceiverResult {
  edgePersisted: boolean;
  enrolled: boolean;
  /**
   * True when this exact tx was ALREADY folded into the relationship — the
   * receiver/relationship/subscription already existed and nothing new was
   * created. The driver must NOT count a replay toward child/day budgets
   * (2026-07-10 Codex round-3), else a tx + its provider-overlap replay eats
   * two receiver slots.
   */
  replay: boolean;
  /** True when a NEW expansion node was created (not deduped, allowEnqueue). */
  enqueued: boolean;
  relationshipKind?: WalletRelationshipKind;
  viaGasException: boolean;
  dust: boolean;
  reason: string;
}

const TRANSFER_FAMILY_ACTION = 'transfer' as const;

/** Trusted senders whose funding triggers enrollment. */
const TRUSTED_SENDER_STATUSES = new Set(['signal_eligible']);

/**
 * Processes one observed transfer FROM a lineage-tracked wallet. Persists the
 * edge, then applies the pure enrollment verdict and writes receiver +
 * relationship + subscription + expansion node as needed. Serialized by the
 * caller (worker holds the global job lock during a backfill pass).
 */
export interface EnrollOptions {
  /**
   * When false, enrollment persists the edge but does NOT enqueue a new
   * expansion node — set once a root hits its node cap (2026-07-10 review).
   */
  allowEnqueue?: boolean;
  /**
   * When false, ONLY the edge is persisted — no receiver/relationship/
   * subscription. The driver sets this once a root's daily receiver cap or a
   * node's child cap is exhausted (2026-07-10 Codex round-2 review: those
   * caps previously gated only enqueue, so receivers were still created past
   * the cap).
   */
  allowEnroll?: boolean;
}

export async function enrollReceiverFromTransfer(
  prisma: PrismaClient,
  transfer: TransferObservation,
  lineageRootId: string,
  depth: number,
  settings: Settings,
  now: Date,
  opts: EnrollOptions = {}
): Promise<EnrollReceiverResult> {
  const allowEnqueue = opts.allowEnqueue ?? true;
  const allowEnroll = opts.allowEnroll ?? true;
  // 1. Persist the edge FIRST (first-write-wins idempotency), before any
  // deeper analysis — an interrupted pass still leaves the observed flow.
  // NOTE (2026-07-10 Codex round-2): edge existence does NOT imply enrollment
  // already ran — normal wallet-activity ingest writes edges independently.
  // So enrollment idempotency is enforced by TX IDENTITY in the relationship
  // evidence (a repeated txHash never bumps interactionCount), not by whether
  // this call wrote the edge.
  const edgePersisted = await persistFlowEdge(prisma, transfer);

  // Cap-exhausted: persist the edge (observation), skip enrollment entirely.
  if (!allowEnroll) {
    return { edgePersisted, enrolled: false, replay: false, enqueued: false, viaGasException: false, dust: false, reason: 'enrollment cap reached — edge persisted only' };
  }

  // 2. Gather the receiver-classification context.
  const receiverWallet = await prisma.wallet.findUnique({
    where: { address_chain: { address: transfer.toAddress, chain: 'SOLANA' } },
    select: { id: true, status: true, lastActiveAt: true }
  });
  const registry = await prisma.addressRegistry.findFirst({
    where: { address: transfer.toAddress, chain: 'SOLANA' },
    select: { category: true }
  });
  // High-degree unregistered hubs are service nodes too (dust/airdrop
  // distributors) — degree = distinct counterparties across the flow graph.
  // Bounded to threshold+1 (Codex round-2): we only need "meets threshold?",
  // and an unbounded take could under-count above a high threshold.
  const receiverDistinctCounterparties = await countDistinctCounterparties(
    prisma,
    transfer.toAddress,
    settings.lineage.serviceDegreeThreshold + 1
  );
  const receiverIsService = isServiceNode(
    { registryCategory: (registry?.category ?? null) as never, distinctCounterparties: receiverDistinctCounterparties },
    settings.lineage
  );

  // Only ACTIVE subscriptions confer trust (2026-07-10 Codex review): an
  // operator-deactivated or cold subscription must not keep a wallet trusted.
  const senderWallet = await prisma.wallet.findUnique({
    where: { address_chain: { address: transfer.fromAddress, chain: 'SOLANA' } },
    select: {
      status: true,
      lineageRoot: { select: { id: true } },
      monitoringSubscriptions: { where: { active: true }, select: { id: true }, take: 1 }
    }
  });

  // A sender is trusted when it is a lineage root, signal_eligible, strong-
  // linked, OR an ACTIVELY-monitored enrolled lineage wallet. The last case
  // makes recursive expansion work: once a receiver B is enrolled (active
  // fresh_receiver_hot subscription), B's OWN onward transfers are in scope.
  const senderTrusted =
    senderWallet !== null &&
    (senderWallet.lineageRoot !== null ||
      TRUSTED_SENDER_STATUSES.has(senderWallet.status) ||
      senderWallet.monitoringSubscriptions.length > 0 ||
      (await hasStrongLink(prisma, transfer.fromAddress)));

  // Freshness is assessed AS OF the funding time (Codex round-2): a wallet
  // that was fresh when funded but has since traded (its ACTIVATION) must
  // still qualify. Using current state would let the activation trade itself
  // disqualify the very enrollment it should trigger. So "prior trades" means
  // trades STRICTLY BEFORE the transfer, and inactivity is measured to the
  // transfer ts.
  const priorTrades = receiverWallet
    ? await prisma.walletTokenTrade.count({ where: { walletId: receiverWallet.id, ts: { lt: transfer.ts } } })
    : 0;
  const lastActiveBeforeTransfer = receiverWallet
    ? (
        await prisma.walletTokenTrade.findFirst({
          where: { walletId: receiverWallet.id, ts: { lt: transfer.ts } },
          orderBy: { ts: 'desc' },
          select: { ts: true }
        })
      )?.ts ?? null
    : null;
  const inactiveDays = lastActiveBeforeTransfer
    ? (transfer.ts.getTime() - lastActiveBeforeTransfer.getTime()) / (24 * 60 * 60 * 1000)
    : Infinity;
  // "First meaningful inbound": no ABOVE-DUST inbound transfer predates this
  // one (dust doesn't count as meaningful — Codex review).
  const priorMeaningfulInbound = await prisma.moneyFlowEdge.count({
    where: {
      destinationAddress: transfer.toAddress,
      destinationChain: 'SOLANA',
      actionType: { in: ['transfer', 'cex_withdrawal', 'bridge_withdrawal'] },
      amountUsd: { gt: settings.lineage.dustMaxUsd },
      ts: { lt: transfer.ts }
    }
  });

  // Fresh/empty requires no prior TRADES AND no prior MEANINGFUL INBOUNDS
  // (Codex round-3: a transfer-only wallet with several real inbounds and no
  // trades was wrongly classified fresh) — OR it is long-inactive.
  const receiverIsFreshOrInactive =
    receiverWallet === null ||
    (priorTrades === 0 && priorMeaningfulInbound === 0) ||
    inactiveDays >= settings.lineage.freshInactiveDays;

  // Gas-activation: the receiver must actually trade WITHIN the window after
  // the funding (not merely "has any trade ever" — Codex review).
  const activationDeadline = new Date(transfer.ts.getTime() + settings.lineage.gasFundingActivationHours * 3600_000);
  const activatedInWindow = receiverWallet
    ? (await prisma.walletTokenTrade.count({
        where: { walletId: receiverWallet.id, ts: { gt: transfer.ts, lte: activationDeadline } }
      })) > 0
    : false;

  const ctx: ReceiverContext = {
    senderTrusted,
    transferUsd: transfer.amountUsd,
    isNativeSol: transfer.isNativeSol,
    receiverIsFreshOrInactive,
    receiverIsServiceOrProgram: receiverIsService,
    isReceiverFirstMeaningfulInbound: priorMeaningfulInbound === 0,
    receiverBecameActiveWithinWindow: activatedInWindow
  };

  const verdict = classifyReceiverEnrollment(ctx, settings.lineage);
  if (!verdict.enroll) {
    return { edgePersisted, enrolled: false, replay: false, enqueued: false, viaGasException: false, dust: verdict.dust, reason: verdict.reason };
  }

  // 3. Upsert receiver observation_only (NEVER signal_eligible), preserving an
  // existing classified status.
  const receiverId = await upsertObservationReceiver(prisma, transfer.toAddress, now);

  // 4. Relationship (probabilistic; upsert bumps interaction count/value). A
  // replayed tx (already in this relationship's evidence) makes no change and
  // is reported so the driver doesn't count it toward budgets.
  const kind = verdict.relationshipKind!;
  const confidence = relationshipConfidence(kind, { activated: ctx.receiverBecameActiveWithinWindow, interactionCount: 1 });
  const replay = await upsertRelationship(prisma, {
    lineageRootId,
    walletAId: (await walletIdOf(prisma, transfer.fromAddress)) ?? receiverId,
    walletBId: receiverId,
    kind,
    confidence,
    activated: ctx.receiverBecameActiveWithinWindow,
    valueUsd: transfer.amountUsd,
    txHash: transfer.txHash,
    now
  });
  if (replay) {
    return { edgePersisted, enrolled: false, replay: true, enqueued: false, viaGasException: verdict.viaGasException, dust: false, reason: 'replayed transfer — no new enrollment' };
  }

  // 5. Hot subscription (fresh_receiver_hot), active immediately.
  await upsertSubscription(prisma, receiverId, lineageRootId);

  // 6. Enqueue bounded shallow expansion (depth+1), respecting maxDepth.
  // Priority derives from the relationship kind (first_funder highest), not a
  // hard-coded tier (Codex review).
  // Promotion of an EXISTING deeper node always runs (it doesn't grow the
  // frontier); only NEW node creation is gated by allowEnqueue (Codex
  // round-2: the shallower-depth repair must work even when the frontier is
  // full).
  let enqueued = false;
  if (depth + 1 <= settings.lineage.maxDepth) {
    enqueued = await enqueueExpansion(prisma, {
      lineageRootId,
      address: transfer.toAddress,
      depth: depth + 1,
      priority: expansionPriorityFor(kind, verdict.viaGasException, transfer.amountUsd, settings.lineage.minTransferUsd),
      discoveredVia: `${kind} of ${transfer.fromAddress}`,
      canCreate: allowEnqueue,
      now
    });
  }

  return {
    edgePersisted,
    enrolled: true,
    replay: false,
    enqueued,
    relationshipKind: kind,
    viaGasException: verdict.viaGasException,
    dust: false,
    reason: verdict.reason
  };
}

// Transfer-family action types — matches ingest.ts's TRANSFER_FAMILY exactly
// (2026-07-10 Codex review: a wider set including bridge_* let an existing
// bridge row suppress a genuine transfer, and vice versa). Lineage only ever
// writes 'transfer', so dedupe scopes to the same family ingest uses.
const TRANSFER_FAMILY: MoneyFlowActionType[] = ['transfer', 'cex_deposit', 'cex_withdrawal'];

async function persistFlowEdge(prisma: PrismaClient, t: TransferObservation): Promise<boolean> {
  const existing = await prisma.moneyFlowEdge.findFirst({
    where: {
      txHash: t.txHash,
      sourceAddress: t.fromAddress,
      destinationAddress: t.toAddress,
      actionType: { in: TRANSFER_FAMILY }
    },
    select: { id: true }
  });
  if (existing) return false;
  try {
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: t.fromAddress,
        destinationAddress: t.toAddress,
        sourceChain: 'SOLANA',
        destinationChain: 'SOLANA',
        asset: t.asset,
        amountToken: t.amountToken,
        amountUsd: t.amountUsd,
        ts: t.ts,
        txHash: t.txHash,
        actionType: TRANSFER_FAMILY_ACTION,
        confidence: 100,
        providerSource: t.provider,
        metadata: { lineage: true }
      }
    });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

async function upsertObservationReceiver(prisma: PrismaClient, address: string, now: Date): Promise<string> {
  const existing = await prisma.wallet.findUnique({
    where: { address_chain: { address, chain: 'SOLANA' } },
    select: { id: true }
  });
  if (existing) {
    // PRESERVATION: never touch status (a public_kol/excluded receiver keeps
    // its classification); only advance activity.
    await prisma.wallet.update({ where: { id: existing.id }, data: { lastActiveAt: now } });
    return existing.id;
  }
  const created = await prisma.wallet.create({
    data: {
      address,
      chain: 'SOLANA',
      firstSeenAt: now,
      lastActiveAt: now,
      isWatched: false,
      status: 'observation_only',
      notes: 'lineage-receiver:enrolled'
    },
    select: { id: true }
  });
  return created.id;
}

async function upsertRelationship(
  prisma: PrismaClient,
  args: {
    lineageRootId: string;
    walletAId: string;
    walletBId: string;
    kind: WalletRelationshipKind;
    confidence: number;
    activated: boolean;
    valueUsd: number;
    txHash: string;
    now: Date;
  }
): Promise<boolean> {
  const existing = await prisma.walletRelationship.findUnique({
    where: {
      lineageRootId_walletAId_walletBId_kind: {
        lineageRootId: args.lineageRootId,
        walletAId: args.walletAId,
        walletBId: args.walletBId,
        kind: args.kind
      }
    },
    select: { id: true, interactionCount: true, valueTransferredUsd: true, evidence: true }
  });
  if (existing) {
    const evidence = Array.isArray(existing.evidence) ? (existing.evidence as { txHash?: string }[]) : [];
    // TX-IDENTITY IDEMPOTENCY (Codex round-2/3): a txHash already folded into
    // this relationship never bumps interactionCount/value again, and returns
    // `true` (replay) so the driver doesn't count it toward budgets. This is
    // what makes a replayed tx OR an ingest-preexisting edge safe without
    // suppressing enrollment for genuinely new transfers.
    if (evidence.some((e) => e && e.txHash === args.txHash)) return true;
    // Evidence is a bounded ring of the most recent EVIDENCE_CAP txHashes
    // (Codex round-3: an unbounded array made each update quadratic for
    // high-frequency pairs). The dedupe window this protects — provider
    // overlap / webhook retries — is recent, so a capped tail is sufficient.
    const nextEvidence = [...evidence, { txHash: args.txHash, usd: args.valueUsd }].slice(-EVIDENCE_CAP);
    await prisma.walletRelationship.update({
      where: { id: existing.id },
      data: {
        interactionCount: existing.interactionCount + 1,
        lastSeenAt: args.now,
        valueTransferredUsd: Number(existing.valueTransferredUsd) + args.valueUsd,
        confidence: relationshipConfidence(args.kind, { activated: args.activated, interactionCount: existing.interactionCount + 1 }),
        evidence: nextEvidence as Prisma.InputJsonValue
      }
    });
    return false;
  }
  await prisma.walletRelationship.create({
    data: {
      lineageRootId: args.lineageRootId,
      walletAId: args.walletAId,
      walletBId: args.walletBId,
      kind: args.kind,
      confidence: args.confidence,
      firstSeenAt: args.now,
      lastSeenAt: args.now,
      interactionCount: 1,
      valueTransferredUsd: args.valueUsd,
      evidence: [{ txHash: args.txHash, usd: args.valueUsd }] as Prisma.InputJsonValue
    }
  });
  return false;
}

const EVIDENCE_CAP = 100;

async function upsertSubscription(prisma: PrismaClient, walletId: string, lineageRootId: string): Promise<void> {
  const existing = await prisma.monitoringSubscription.findUnique({
    where: { walletId_priority: { walletId, priority: 'fresh_receiver_hot' } },
    select: { id: true }
  });
  if (existing) return; // preserve operator changes; never reactivate
  try {
    await prisma.monitoringSubscription.create({
      data: { walletId, priority: 'fresh_receiver_hot', active: true, reason: 'fresh_receiver_enrollment', lineageRootId }
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

type ExpansionPriorityValue =
  | 'first_funder'
  | 'direct_high_value'
  | 'fresh_activation'
  | 'post_funding_buy'
  | 'bridge_correlated'
  | 'repeated_transfer'
  | 'profit_rotation'
  | 'weak';

/** Maps a relationship kind + value to the expansion frontier priority. */
function expansionPriorityFor(
  kind: WalletRelationshipKind,
  viaGas: boolean,
  amountUsd: number,
  minTransferUsd: number
): ExpansionPriorityValue {
  if (kind === 'first_funder') return 'first_funder';
  if (kind === 'direct_funding') return amountUsd >= minTransferUsd * 10 ? 'direct_high_value' : 'fresh_activation';
  if (kind === 'fresh_wallet_activation') return 'fresh_activation';
  if (kind === 'repeated_transfer') return 'repeated_transfer';
  void viaGas;
  return 'weak';
}

/** Returns true iff a NEW node was created (a dedupe/promotion returns false). */
async function enqueueExpansion(
  prisma: PrismaClient,
  args: {
    lineageRootId: string;
    address: string;
    depth: number;
    priority: ExpansionPriorityValue;
    discoveredVia: string;
    canCreate: boolean;
    now: Date;
  }
): Promise<boolean> {
  const existing = await prisma.lineageExpansionNode.findUnique({
    where: { lineageRootId_walletAddress: { lineageRootId: args.lineageRootId, walletAddress: args.address } },
    select: { id: true, depth: true, status: true }
  });
  if (existing) {
    // Promotion (2026-07-10 Codex review): a wallet first seen as a deep leaf
    // that is LATER discovered via a shallower/higher-priority path must be
    // re-openable at the shallower depth so it can actually expand. Runs even
    // when the frontier is full (it adds no node).
    if (args.depth < existing.depth && existing.status !== 'in_progress') {
      await prisma.lineageExpansionNode.update({
        where: { id: existing.id },
        data: { depth: args.depth, priority: args.priority, status: 'pending', stopReason: null }
      });
    }
    return false;
  }
  if (!args.canCreate) return false; // frontier full — new node forbidden
  try {
    await prisma.lineageExpansionNode.create({
      data: {
        lineageRootId: args.lineageRootId,
        walletAddress: args.address,
        chain: 'SOLANA',
        depth: args.depth,
        priority: args.priority,
        status: 'pending',
        discoveredVia: args.discoveredVia
      }
    });
    return true;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return false;
  }
}

/**
 * Distinct counterparties (in + out) observed for an address — service-node
 * degree. `cap` bounds the scan: we only need to know whether the degree
 * MEETS the service threshold, so each direction fetches up to `cap` distinct
 * rows (Codex round-2: an unbounded/undersized take could under-count above a
 * high threshold and misclassify a real hub as a normal wallet).
 */
async function countDistinctCounterparties(prisma: PrismaClient, address: string, cap: number): Promise<number> {
  const [asSource, asDest] = await Promise.all([
    prisma.moneyFlowEdge.findMany({
      where: { sourceAddress: address, sourceChain: 'SOLANA' },
      select: { destinationAddress: true },
      distinct: ['destinationAddress'],
      take: cap
    }),
    prisma.moneyFlowEdge.findMany({
      where: { destinationAddress: address, destinationChain: 'SOLANA' },
      select: { sourceAddress: true },
      distinct: ['sourceAddress'],
      take: cap
    })
  ]);
  const set = new Set<string>();
  for (const e of asSource) set.add(e.destinationAddress);
  for (const e of asDest) set.add(e.sourceAddress);
  return set.size;
}

async function walletIdOf(prisma: PrismaClient, address: string): Promise<string | null> {
  const w = await prisma.wallet.findUnique({ where: { address_chain: { address, chain: 'SOLANA' } }, select: { id: true } });
  return w?.id ?? null;
}

async function hasStrongLink(prisma: PrismaClient, address: string): Promise<boolean> {
  const wallet = await prisma.wallet.findUnique({ where: { address_chain: { address, chain: 'SOLANA' } }, select: { id: true } });
  if (!wallet) return false;
  const strong = await prisma.walletRelationship.count({
    where: { OR: [{ walletAId: wallet.id }, { walletBId: wallet.id }], confidence: { gte: 80 } }
  });
  return strong > 0;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
