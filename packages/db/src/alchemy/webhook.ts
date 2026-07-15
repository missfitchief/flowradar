import { createHash } from 'node:crypto';
import { Prisma, type ChainId, type PrismaClient } from '@prisma/client';
import { normalizeAlchemyWebhook, type AlchemyWebhookEnvelope } from '@flowradar/providers';
import { createMassTrackerSession } from '../tracker/massTracker';

export interface AlchemyWebhookIngestResult {
  receiptId: string;
  duplicate: boolean;
  normalizedEvents: number;
  persistedEvents: number;
  eligibilityStatus: string;
  rejectionReason: string | null;
}

export function alchemyPayloadHash(rawBody: string) {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex');
}

/** Signature verification is intentionally performed by the HTTP boundary
 * before this function can write a receipt or event. */
export async function ingestAlchemyWebhook(
  prisma: PrismaClient,
  input: { chain: ChainId; envelope: AlchemyWebhookEnvelope; payloadHash: string; receivedAt?: Date }
): Promise<AlchemyWebhookIngestResult> {
  const receivedAt = input.receivedAt ?? new Date();
  const existing = await prisma.alchemyWebhookReceipt.findUnique({ where: { webhookEventId: input.envelope.id } });
  if (existing) {
    if (existing.payloadHash !== input.payloadHash) throw new Error('Conflicting Alchemy webhook replay');
    return resultOf(existing, true);
  }
  let receipt;
  try {
    receipt = await prisma.alchemyWebhookReceipt.create({ data: {
      webhookEventId: input.envelope.id, webhookId: input.envelope.webhookId, chain: input.chain,
      payloadHash: input.payloadHash, providerCreatedAt: new Date(input.envelope.createdAt), receivedAt,
      signatureVerified: true, status: 'processing', metadataJson: {
        provider: 'Alchemy', type: input.envelope.type, network: String(input.envelope.event.network ?? '')
      }
    } });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await prisma.alchemyWebhookReceipt.findUniqueOrThrow({ where: { webhookEventId: input.envelope.id } });
    if (raced.payloadHash !== input.payloadHash) throw new Error('Conflicting Alchemy webhook replay');
    return resultOf(raced, true);
  }

  const tracker = await createMassTrackerSession(prisma, {
    enrollReceivers: true,
    metadata: { workflow: 'alchemy_address_activity_webhook', chain: input.chain, receiptId: receipt.id }
  });
  try {
    const tracked = await activeCoreAddresses(prisma, input.chain);
    const events = await normalizeAlchemyWebhook(input.chain, input.envelope, tracked, { observedAt: receivedAt });
    await tracker.ingest(events);
    const run = await tracker.complete();
    await updateWalletActivity(prisma, input.chain, events);
    const eligibility = eligibilityOf(events);
    const completed = await prisma.alchemyWebhookReceipt.update({
      where: { id: receipt.id },
      data: {
        status: 'completed', normalizedEvents: events.length, persistedEvents: run.persistedEvents,
        duplicateEvents: run.duplicateEvents, eligibilityStatus: eligibility.status,
        rejectionReason: eligibility.reason, trackerRunId: run.runId, completedAt: new Date(),
        metadataJson: {
          provider: 'Alchemy', type: input.envelope.type, network: String(input.envelope.event.network ?? ''),
          trackedCoreAddresses: tracked.size, relevantEvents: run.relevantEvents,
          receiverEnrollments: run.receiversEnrolled, alertEngine: 'production_v2'
        }
      }
    });
    return resultOf(completed, false);
  } catch (error) {
    await tracker.fail(error).catch(() => undefined);
    await prisma.alchemyWebhookReceipt.update({
      where: { id: receipt.id }, data: { status: 'failed', error: safeError(error), completedAt: new Date() }
    }).catch(() => undefined);
    throw error;
  }
}

async function activeCoreAddresses(prisma: PrismaClient, chain: ChainId) {
  const roots = await prisma.lineageRoot.findMany({
    where: { permanent: true, wallet: { chain }, subscriptions: { some: { active: true, priority: 'root_permanent' } } },
    select: { wallet: { select: { address: true } } }
  });
  return new Set(roots.map((root) => chain === 'SOLANA' ? root.wallet.address : root.wallet.address.toLowerCase()));
}

async function updateWalletActivity(prisma: PrismaClient, chain: ChainId, events: Awaited<ReturnType<typeof normalizeAlchemyWebhook>>) {
  const latest = new Map<string, Date>();
  for (const event of events) {
    if (!event.actor) continue;
    const current = latest.get(event.actor);
    if (!current || event.ts > current) latest.set(event.actor, event.ts);
  }
  for (const [address, ts] of latest) {
    await prisma.wallet.updateMany({ where: { chain, address, lastActiveAt: { lt: ts } }, data: { lastActiveAt: ts } });
  }
}

function eligibilityOf(events: Awaited<ReturnType<typeof normalizeAlchemyWebhook>>) {
  if (!events.length) return { status: 'rejected', reason: 'no_tracked_activity' };
  if (!events.some((event) => event.kind === 'token_buy')) return { status: 'rejected', reason: 'silent_transfer_policy' };
  if (!events.some((event) => event.kind === 'token_buy' && event.asset.amountUsd != null)) return { status: 'rejected', reason: 'usd_value_unavailable' };
  return { status: 'pending', reason: null };
}

function resultOf(receipt: { id: string; normalizedEvents: number; persistedEvents: number; eligibilityStatus: string | null; rejectionReason: string | null }, duplicate: boolean): AlchemyWebhookIngestResult {
  return { receiptId: receipt.id, duplicate, normalizedEvents: receipt.normalizedEvents, persistedEvents: receipt.persistedEvents, eligibilityStatus: receipt.eligibilityStatus ?? 'processing', rejectionReason: receipt.rejectionReason };
}
function isUniqueViolation(error: unknown) { return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'; }
function safeError(error: unknown) { return error instanceof Error ? error.message.replace(/https:\/\/\S+/g, '<redacted-url>').slice(0, 500) : 'webhook ingest failed'; }
