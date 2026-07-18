import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestAlchemyWebhook } from '../src/alchemy/webhook';
import { OperatorService } from '../src/operator/service';
import { prisma } from '../src/client';

const USER = 'ALCHEMYWEBHOOKTEST';
const ACTOR = `0x${'11'.repeat(20)}`;
const RECEIVER = `0x${'22'.repeat(20)}`;
const HASH = `0x${'ab'.repeat(32)}`;
const EVENT_ID = 'alchemy-webhook-test-event';
const OBSERVATION_ACTOR = `0x${'33'.repeat(20)}`;
const OBSERVATION_HASH = `0x${'cd'.repeat(32)}`;
const OBSERVATION_EVENT_ID = 'alchemy-webhook-observation-test-event';

async function cleanup() {
  const receipts = await prisma.alchemyWebhookReceipt.findMany({ where: { webhookEventId: { in: [EVENT_ID, OBSERVATION_EVENT_ID] } }, select: { trackerRunId: true } });
  await prisma.alchemyWebhookReceipt.deleteMany({ where: { webhookEventId: { in: [EVENT_ID, OBSERVATION_EVENT_ID] } } });
  await prisma.massTrackerRun.deleteMany({ where: { id: { in: receipts.flatMap((receipt) => receipt.trackerRunId ? [receipt.trackerRunId] : []) } } });
  await prisma.massTransactionEvent.deleteMany({ where: { eventId: { startsWith: `alchemy:ETHEREUM:${HASH}:` } } });
  await prisma.massTransactionEvent.deleteMany({ where: { eventId: { startsWith: `alchemy:ETHEREUM:${OBSERVATION_HASH}:` } } });
  await prisma.operatorWatch.deleteMany({ where: { userId: USER } });
  await prisma.lineageRoot.deleteMany({ where: { wallet: { address: { in: [ACTOR, RECEIVER] } } } });
  await prisma.wallet.deleteMany({ where: { address: { in: [ACTOR, RECEIVER, OBSERVATION_ACTOR] } } });
}

beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

describe('Alchemy webhook persistence', () => {
  it('persists a signed-boundary event once and audits an ordinary transfer as silent', async () => {
    await new OperatorService(prisma).addCoreWallet(USER, USER, ACTOR);
    const envelope = {
      webhookId: 'webhook-test', id: EVENT_ID, createdAt: '2026-07-15T12:00:00.000Z', type: 'ADDRESS_ACTIVITY',
      event: { network: 'ETH_MAINNET', activity: [{
        blockNum: '0x20', hash: HASH, fromAddress: ACTOR, toAddress: RECEIVER,
        value: 0.1, asset: 'ETH', category: 'external', rawContract: { decimal: '0x12' }
      }] }
    };
    const first = await ingestAlchemyWebhook(prisma, { chain: 'ETHEREUM', envelope, payloadHash: 'body-hash-test' });
    const replay = await ingestAlchemyWebhook(prisma, { chain: 'ETHEREUM', envelope, payloadHash: 'body-hash-test' });

    expect(first).toMatchObject({ duplicate: false, normalizedEvents: 1, persistedEvents: 1, eligibilityStatus: 'rejected', rejectionReason: 'silent_transfer_policy' });
    expect(replay).toMatchObject({ duplicate: true, normalizedEvents: 1, persistedEvents: 1 });
    expect(await prisma.massTransactionEvent.count({ where: { eventId: `alchemy:ETHEREUM:${HASH}:0` } })).toBe(1);
    expect(await prisma.alchemyWebhookReceipt.count({ where: { webhookEventId: EVENT_ID } })).toBe(1);
  });

  it('accepts an observation-only actor when its background monitoring subscription is active', async () => {
    const wallet = await prisma.wallet.create({ data: {
      chain: 'ETHEREUM', address: OBSERVATION_ACTOR, status: 'observation_only', isWatched: true,
      firstSeenAt: new Date('2026-07-15T00:00:00Z'), lastActiveAt: new Date('2026-07-15T00:00:00Z')
    } });
    await prisma.monitoringSubscription.create({ data: {
      walletId: wallet.id, priority: 'standard', active: true, tierPriority: 4, reason: 'alchemy_webhook_observation_test'
    } });
    const envelope = {
      webhookId: 'webhook-test', id: OBSERVATION_EVENT_ID, createdAt: '2026-07-15T12:00:00.000Z', type: 'ADDRESS_ACTIVITY',
      event: { network: 'ETH_MAINNET', activity: [{
        blockNum: '0x21', hash: OBSERVATION_HASH, fromAddress: OBSERVATION_ACTOR, toAddress: RECEIVER,
        value: 0.2, asset: 'ETH', category: 'external', rawContract: { decimal: '0x12' }
      }] }
    };
    const result = await ingestAlchemyWebhook(prisma, { chain: 'ETHEREUM', envelope, payloadHash: 'observation-body-hash' });
    expect(result).toMatchObject({ duplicate: false, normalizedEvents: 1, eligibilityStatus: 'rejected', rejectionReason: 'silent_transfer_policy' });
  });
});
