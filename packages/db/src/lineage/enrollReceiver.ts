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

import type { PrismaClient, Prisma } from '@prisma/client';
import {
  classifyReceiverEnrollment,
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
export async function enrollReceiverFromTransfer(
  prisma: PrismaClient,
  transfer: TransferObservation,
  lineageRootId: string,
  depth: number,
  settings: Settings,
  now: Date
): Promise<EnrollReceiverResult> {
  // 1. Persist the edge FIRST (first-write-wins idempotency), before any
  // deeper analysis — an interrupted pass still leaves the observed flow.
  const edgePersisted = await persistFlowEdge(prisma, transfer);

  // 2. Gather the receiver-classification context.
  const receiverWallet = await prisma.wallet.findUnique({
    where: { address_chain: { address: transfer.toAddress, chain: 'SOLANA' } },
    select: { id: true, status: true, lastActiveAt: true, _count: { select: { trades: true } } }
  });
  const registry = await prisma.addressRegistry.findFirst({
    where: { address: transfer.toAddress, chain: 'SOLANA' },
    select: { category: true }
  });
  const senderWallet = await prisma.wallet.findUnique({
    where: { address_chain: { address: transfer.fromAddress, chain: 'SOLANA' } },
    select: { status: true, lineageRoot: { select: { id: true } } }
  });

  const senderTrusted =
    senderWallet !== null &&
    (senderWallet.lineageRoot !== null ||
      TRUSTED_SENDER_STATUSES.has(senderWallet.status) ||
      (await hasStrongLink(prisma, transfer.fromAddress)));

  // A receiver with no prior trades and no prior inbound is fresh; a
  // long-inactive one (> freshInactiveDays) re-qualifies.
  const priorTrades = receiverWallet?._count.trades ?? 0;
  const inactiveDays = receiverWallet
    ? (now.getTime() - receiverWallet.lastActiveAt.getTime()) / (24 * 60 * 60 * 1000)
    : Infinity;
  const receiverIsFreshOrInactive =
    receiverWallet === null || priorTrades === 0 || inactiveDays >= settings.lineage.freshInactiveDays;

  const priorInbound = await prisma.moneyFlowEdge.count({
    where: {
      destinationAddress: transfer.toAddress,
      destinationChain: 'SOLANA',
      actionType: { in: ['transfer', 'cex_withdrawal', 'bridge_withdrawal'] },
      ts: { lt: transfer.ts }
    }
  });

  const ctx: ReceiverContext = {
    senderTrusted,
    transferUsd: transfer.amountUsd,
    isNativeSol: transfer.isNativeSol,
    receiverIsFreshOrInactive,
    receiverIsServiceOrProgram: registry !== null,
    isReceiverFirstMeaningfulInbound: priorInbound === 0,
    // Activation-within-window is confirmed by a later pass; at enrollment
    // time we optimistically allow the gas exception when the receiver
    // already has post-transfer activity, else it is re-evaluated. For the
    // synchronous path we treat "has any trades" as activated.
    receiverBecameActiveWithinWindow: priorTrades > 0
  };

  const verdict = classifyReceiverEnrollment(ctx, settings.lineage);
  if (!verdict.enroll) {
    return { edgePersisted, enrolled: false, viaGasException: false, dust: verdict.dust, reason: verdict.reason };
  }

  // 3. Upsert receiver observation_only (NEVER signal_eligible), preserving an
  // existing classified status.
  const receiverId = await upsertObservationReceiver(prisma, transfer.toAddress, now);

  // 4. Relationship (probabilistic; upsert bumps interaction count/value).
  const kind = verdict.relationshipKind!;
  const confidence = relationshipConfidence(kind, { activated: ctx.receiverBecameActiveWithinWindow, interactionCount: 1 });
  await upsertRelationship(prisma, {
    lineageRootId,
    walletAId: (await walletIdOf(prisma, transfer.fromAddress)) ?? receiverId,
    walletBId: receiverId,
    kind,
    confidence,
    valueUsd: transfer.amountUsd,
    txHash: transfer.txHash,
    now
  });

  // 5. Hot subscription (fresh_receiver_hot), active immediately.
  await upsertSubscription(prisma, receiverId, lineageRootId);

  // 6. Enqueue bounded shallow expansion (depth+1), respecting maxDepth.
  if (depth + 1 <= settings.lineage.maxDepth) {
    await enqueueExpansion(prisma, {
      lineageRootId,
      address: transfer.toAddress,
      depth: depth + 1,
      discoveredVia: `${kind} of ${transfer.fromAddress}`,
      now
    });
  }

  return {
    edgePersisted,
    enrolled: true,
    relationshipKind: kind,
    viaGasException: verdict.viaGasException,
    dust: false,
    reason: verdict.reason
  };
}

async function persistFlowEdge(prisma: PrismaClient, t: TransferObservation): Promise<boolean> {
  const existing = await prisma.moneyFlowEdge.findFirst({
    where: {
      txHash: t.txHash,
      sourceAddress: t.fromAddress,
      destinationAddress: t.toAddress,
      actionType: { in: ['transfer', 'cex_deposit', 'cex_withdrawal', 'bridge_deposit', 'bridge_withdrawal'] }
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
    valueUsd: number;
    txHash: string;
    now: Date;
  }
): Promise<void> {
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
    const evidence = Array.isArray(existing.evidence) ? existing.evidence : [];
    await prisma.walletRelationship.update({
      where: { id: existing.id },
      data: {
        interactionCount: existing.interactionCount + 1,
        lastSeenAt: args.now,
        valueTransferredUsd: Number(existing.valueTransferredUsd) + args.valueUsd,
        confidence: relationshipConfidence(args.kind, { activated: true, interactionCount: existing.interactionCount + 1 }),
        evidence: [...evidence, { txHash: args.txHash, usd: args.valueUsd }] as Prisma.InputJsonValue
      }
    });
    return;
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
}

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

async function enqueueExpansion(
  prisma: PrismaClient,
  args: { lineageRootId: string; address: string; depth: number; discoveredVia: string; now: Date }
): Promise<void> {
  const existing = await prisma.lineageExpansionNode.findUnique({
    where: { lineageRootId_walletAddress: { lineageRootId: args.lineageRootId, walletAddress: args.address } },
    select: { id: true }
  });
  if (existing) return; // already in the frontier for this root
  try {
    await prisma.lineageExpansionNode.create({
      data: {
        lineageRootId: args.lineageRootId,
        walletAddress: args.address,
        chain: 'SOLANA',
        depth: args.depth,
        priority: 'fresh_activation',
        status: 'pending',
        discoveredVia: args.discoveredVia
      }
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
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
