import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestAlchemyWebhook } from '../src/alchemy/webhook';
import { OperatorService } from '../src/operator/service';
import { prisma } from '../src/client';

const USER = 'ALCHEMYWEBHOOKTEST';
const ACTOR = `0x${'11'.repeat(20)}`;
const RECEIVER = `0x${'22'.repeat(20)}`;
const HASH = `0x${'ab'.repeat(32)}`;
const EVENT_ID = 'alchemy-webhook-test-event';

async function cleanup() {
  const receipts = await prisma.alchemyWebhookReceipt.findMany({ where: { webhookEventId: EVENT_ID }, select: { trackerRunId: true } });
  await prisma.alchemyWebhookReceipt.deleteMany({ where: { webhookEventId: EVENT_ID } });
  await prisma.massTrackerRun.deleteMany({ where: { id: { in: receipts.flatMap((receipt) => receipt.trackerRunId ? [receipt.trackerRunId] : []) } } });
  await prisma.massTransactionEvent.deleteMany({ where: { eventId: { startsWith: `alchemy:ETHEREUM:${HASH}:` } } });
  await prisma.operatorWatch.deleteMany({ where: { userId: USER } });
  await prisma.lineageRoot.deleteMany({ where: { wallet: { address: { in: [ACTOR, RECEIVER] } } } });
  await prisma.wallet.deleteMany({ where: { address: { in: [ACTOR, RECEIVER] } } });
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
});
