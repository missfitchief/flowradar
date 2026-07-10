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
  // Last activity before the funding = most recent of a prior trade OR a
  // prior meaningful flow edge (Codex round-4: a transfer-only wallet has no
  // trades, so a trade-only inactivity measure wrongly reported it as
  // long-inactive/fresh even when it received real funds yesterday).
  const lastTradeBefore = receiverWallet
    ? (await prisma.walletTokenTrade.findFirst({
        where: { walletId: receiverWallet.id, ts: { lt: transfer.ts } },
        orderBy: { ts: 'desc' },
        select: { ts: true }
      }))?.ts ?? null
    : null;
  const lastMeaningfulEdgeBefore = (
    await prisma.moneyFlowEdge.findFirst({
      where: {
        OR: [
          { destinationAddress: transfer.toAddress, destinationChain: 'SOLANA' },
          { sourceAddress: transfer.toAddress, sourceChain: 'SOLANA' }
        ],
        amountUsd: { gt: settings.lineage.dustMaxUsd },
        ts: { lt: transfer.ts }
      },
      orderBy: { ts: 'desc' },
      select: { ts: true }
    })
  )?.ts ?? null;
  const lastActiveBeforeTransfer = [lastTradeBefore, lastMeaningfulEdgeBefore]
    .filter((d): d is Date => d !== null)
    .reduce<Date | null>((max, d) => (max === null || d > max ? d : max), null);
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
  // (Codex round-3/5) — OR long-inactive by trade-or-flow activity. A missing
  // Wallet ROW does NOT force fresh: normal ingest can persist counterparty
  // edges without creating the Wallet row, so freshness rests on the observed
  // ACTIVITY (trades + meaningful edges), not on row existence.
  const receiverIsFreshOrInactive =
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

  // Steps 3-6 run in ONE transaction (2026-07-10 Codex round-5): receiver +
  // relationship + subscription + expansion node commit together or not at
  // all, so there is no partial-enrollment state a later cap check could
  // strand. Each step is also individually idempotent, so a retry after a
  // rolled-back attempt re-does cleanly. The budget signal is a NEW
  // RELATIONSHIP for THIS root (per-root notion) — NOT the global hot
  // subscription (which is one-per-wallet and would let a receiver already
  // subscribed via another root bypass this root's child cap).
  const senderAddr = transfer.fromAddress;
  const kind = verdict.relationshipKind!;
  const senderWalletIdForRel = (await walletIdOf(prisma, senderAddr)) ?? null;

  const { newChild, enqueued } = await prisma.$transaction(async (tx) => {
    // 3. Receiver observation_only (NEVER signal_eligible), status preserved;
    // lastActiveAt = transfer time, forward-only.
    const receiverId = await upsertObservationReceiver(tx, transfer.toAddress, transfer.ts);

    // 4. Relationship — interactionCount/value DERIVED from edges (permanent
    // idempotency). Returns created=true only for a genuinely new pair row.
    const { created: newChild } = await upsertRelationship(tx, {
      lineageRootId,
      walletAId: senderWalletIdForRel ?? receiverId,
      walletBId: receiverId,
      senderAddr,
      receiverAddr: transfer.toAddress,
      kind,
      activated: ctx.receiverBecameActiveWithinWindow,
      now: transfer.ts
    });

    // 5. Hot subscription (global per wallet); self-heals but is not the
    // budget signal.
    await upsertSubscription(tx, receiverId, lineageRootId);

    // 6. Enqueue bounded shallow expansion (depth+1). Promotion of an existing
    // deeper node always runs; only NEW node creation is gated by allowEnqueue.
    let enqueued = false;
    if (depth + 1 <= settings.lineage.maxDepth) {
      enqueued = await enqueueExpansion(tx, {
        lineageRootId,
        address: transfer.toAddress,
        depth: depth + 1,
        priority: expansionPriorityFor(kind, verdict.viaGasException, transfer.amountUsd, settings.lineage.minTransferUsd),
        discoveredVia: `${kind} of ${senderAddr}`,
        canCreate: allowEnqueue,
        now
      });
    }
    return { newChild, enqueued };
  });

  return {
    edgePersisted,
    // Counts toward per-root child + daily budgets only for a genuinely NEW
    // child (new relationship for this root); a re-processed transfer to an
    // already-related receiver self-heals but consumes no budget.
    enrolled: newChild,
    replay: !newChild,
    enqueued,
    relationshipKind: kind,
    viaGasException: verdict.viaGasException,
    dust: false,
    reason: newChild ? verdict.reason : 'receiver already related — idempotent re-process'
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

async function upsertObservationReceiver(tx: Prisma.TransactionClient, address: string, activityTs: Date): Promise<string> {
  // Atomic upsert (ON CONFLICT) — NOT create-then-catch (Codex round-5): a
  // caught INSERT error would poison the enclosing Postgres transaction. The
  // update branch is a no-op ({}), PRESERVING status (a public_kol/excluded
  // receiver keeps its classification). A separate guarded updateMany then
  // advances lastActiveAt FORWARD ONLY to the transfer time.
  const wallet = await tx.wallet.upsert({
    where: { address_chain: { address, chain: 'SOLANA' } },
    create: {
      address,
      chain: 'SOLANA',
      firstSeenAt: activityTs,
      lastActiveAt: activityTs,
      isWatched: false,
      status: 'observation_only',
      notes: 'lineage-receiver:enrolled'
    },
    update: {},
    select: { id: true }
  });
  await tx.wallet.updateMany({
    where: { id: wallet.id, lastActiveAt: { lt: activityTs } },
    data: { lastActiveAt: activityTs }
  });
  return wallet.id;
}

const EVIDENCE_SAMPLE_CAP = 100;

async function upsertRelationship(
  tx: Prisma.TransactionClient,
  args: {
    lineageRootId: string;
    walletAId: string;
    walletBId: string;
    senderAddr: string;
    receiverAddr: string;
    kind: WalletRelationshipKind;
    activated: boolean;
    now: Date;
  }
): Promise<{ created: boolean }> {
  // interactionCount + valueTransferredUsd are DERIVED from the persisted
  // transfer edges for this directed pair (Codex round-4): counting distinct
  // txHashes is PERMANENTLY idempotent — a replayed or re-backfilled tx is
  // still one distinct txHash, never a double-increment, with no reliance on a
  // bounded evidence ring. This tx's edge was persisted in step 1, so it is
  // already included.
  const edges = await tx.moneyFlowEdge.findMany({
    where: {
      sourceAddress: args.senderAddr,
      destinationAddress: args.receiverAddr,
      sourceChain: 'SOLANA',
      actionType: { in: TRANSFER_FAMILY }
    },
    select: { txHash: true, amountUsd: true }
  });
  const byTx = new Map<string, number>();
  for (const e of edges) if (!byTx.has(e.txHash)) byTx.set(e.txHash, Number(e.amountUsd));
  const interactionCount = byTx.size;
  const valueTransferredUsd = [...byTx.values()].reduce((s, v) => s + v, 0);
  const evidenceSample = [...byTx.entries()].slice(-EVIDENCE_SAMPLE_CAP).map(([txHash, usd]) => ({ txHash, usd }));
  const confidence = relationshipConfidence(args.kind, { activated: args.activated, interactionCount });

  const existing = await tx.walletRelationship.findUnique({
    where: {
      lineageRootId_walletAId_walletBId_kind: {
        lineageRootId: args.lineageRootId,
        walletAId: args.walletAId,
        walletBId: args.walletBId,
        kind: args.kind
      }
    },
    select: { id: true, lastSeenAt: true }
  });
  await tx.walletRelationship.upsert({
    where: {
      lineageRootId_walletAId_walletBId_kind: {
        lineageRootId: args.lineageRootId,
        walletAId: args.walletAId,
        walletBId: args.walletBId,
        kind: args.kind
      }
    },
    create: {
      lineageRootId: args.lineageRootId,
      walletAId: args.walletAId,
      walletBId: args.walletBId,
      kind: args.kind,
      confidence,
      firstSeenAt: args.now,
      lastSeenAt: args.now,
      interactionCount,
      valueTransferredUsd,
      evidence: evidenceSample as Prisma.InputJsonValue
    },
    update: {
      // lastSeenAt only moves forward (never regress on a re-backfill).
      lastSeenAt: existing && existing.lastSeenAt > args.now ? existing.lastSeenAt : args.now,
      interactionCount,
      valueTransferredUsd,
      confidence,
      evidence: evidenceSample as Prisma.InputJsonValue
    }
  });
  return { created: existing === null };
}

/** Returns { created } — created is true only when a NEW hot subscription was inserted. */
async function upsertSubscription(tx: Prisma.TransactionClient, walletId: string, lineageRootId: string): Promise<{ created: boolean }> {
  const existing = await tx.monitoringSubscription.findUnique({
    where: { walletId_priority: { walletId, priority: 'fresh_receiver_hot' } },
    select: { id: true }
  });
  if (existing) return { created: false }; // preserve operator changes; never reactivate
  try {
    await tx.monitoringSubscription.create({
      data: { walletId, priority: 'fresh_receiver_hot', active: true, reason: 'fresh_receiver_enrollment', lineageRootId }
    });
    return { created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return { created: false }; // lost a create race — someone else made it
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
  tx: Prisma.TransactionClient,
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
  const existing = await tx.lineageExpansionNode.findUnique({
    where: { lineageRootId_walletAddress: { lineageRootId: args.lineageRootId, walletAddress: args.address } },
    select: { id: true, depth: true, status: true }
  });
  if (existing) {
    // Promotion (2026-07-10 Codex review): a wallet first seen as a deep leaf
    // that is LATER discovered via a shallower/higher-priority path must be
    // re-openable at the shallower depth so it can actually expand. Runs even
    // when the frontier is full (it adds no node).
    if (args.depth < existing.depth && existing.status !== 'in_progress') {
      await tx.lineageExpansionNode.update({
        where: { id: existing.id },
        data: { depth: args.depth, priority: args.priority, status: 'pending', stopReason: null }
      });
    }
    return false;
  }
  if (!args.canCreate) return false; // frontier full — new node forbidden
  try {
    await tx.lineageExpansionNode.create({
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
