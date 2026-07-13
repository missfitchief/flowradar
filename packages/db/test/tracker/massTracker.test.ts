import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { MassTransactionEvent } from '@flowradar/core';
import { prisma } from '../../src/client';
import { runMassTransactionTracker, type MassTrackerSourceItem } from '../../src/tracker/massTracker';
import { buildStoredMassTrackerTraces } from '../../src/tracker/traceStore';

const PREFIX = 'MASSTRACKERTEST';
const NOW = new Date('2026-07-13T12:00:00Z');

async function cleanup() {
  await prisma.massTrackerTrace.deleteMany({ where: { sourceWallet: { startsWith: PREFIX } } });
  await prisma.massBridgeCorrelation.deleteMany({ where: { OR: [{ sourceEventId: { startsWith: PREFIX } }, { destinationEventId: { startsWith: PREFIX } }] } });
  await prisma.massTransactionEvent.deleteMany({ where: { eventId: { startsWith: PREFIX } } });
  await prisma.massTrackerRun.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.monitoringSubscription.deleteMany({ where: { reason: { startsWith: 'mass_tracker_receiver:' + PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

function transfer(i: number, root: string): MassTransactionEvent {
  return {
    eventId: `${PREFIX}:SOLANA:tx-${i}:0`, chain: 'SOLANA', txHash: `${PREFIX}-tx-${i}`, eventIndex: 0,
    blockOrSlot: BigInt(i + 1), ts: new Date(NOW.getTime() + i * 1000), kind: 'native_transfer', status: 'succeeded',
    from: root, to: `${PREFIX}-receiver-${i}`, actor: root, asset: { address: null, symbol: 'SOL', decimals: 9, amount: '2', amountUsd: 250 },
    programOrContract: null, provider: 'integration-fixture', observedAt: NOW, bridge: null, metadata: { fixture: true }
  };
}

async function* source(events: MassTransactionEvent[]): AsyncIterable<MassTrackerSourceItem> {
  for (const event of events) yield { event };
}

describe('runMassTransactionTracker', () => {
  it('streams batches idempotently and enrolls receivers observation-only', async () => {
    const rootWallet = await prisma.wallet.create({ data: { address: `${PREFIX}-root`, chain: 'SOLANA', status: 'observation_only', firstSeenAt: NOW, lastActiveAt: NOW } });
    await prisma.lineageRoot.create({ data: { walletId: rootWallet.id, source: 'operator_file', permanent: true, firstImportedAt: NOW, lastSeenInImportAt: NOW } });
    const events = Array.from({ length: 25 }, (_, i) => transfer(i, rootWallet.address));
    const first = await runMassTransactionTracker(prisma, source(events), { runId: `${PREFIX}-run-1`, batchSize: 7, retryBaseMs: 0 });
    expect(first).toMatchObject({ inputEvents: 25, persistedEvents: 25, duplicateEvents: 0, relevantEvents: 25, receiversEnrolled: 25, batches: 4 });
    const second = await runMassTransactionTracker(prisma, source(events), { runId: `${PREFIX}-run-2`, batchSize: 10, retryBaseMs: 0 });
    expect(second).toMatchObject({ inputEvents: 25, persistedEvents: 0, duplicateEvents: 25, receiversEnrolled: 0 });
    const receivers = await prisma.wallet.findMany({ where: { address: { startsWith: `${PREFIX}-receiver-` } } });
    expect(receivers).toHaveLength(25);
    expect(new Set(receivers.map((w) => w.status))).toEqual(new Set(['observation_only']));
  });

  it('persists a real root -> side -> execution -> token-buy proof from the store', async () => {
    const rootWallet = await prisma.wallet.create({ data: { address: `${PREFIX}-trace-root`, chain: 'SOLANA', status: 'observation_only', firstSeenAt: NOW, lastActiveAt: NOW } });
    await prisma.lineageRoot.create({ data: { walletId: rootWallet.id, source: 'operator_file', permanent: true, firstImportedAt: NOW, lastSeenInImportAt: NOW } });
    const side = `${PREFIX}-trace-side`;
    const execution = `${PREFIX}-trace-execution`;
    const first = transfer(100, rootWallet.address);
    first.to = side; first.eventId = `${PREFIX}:trace:fund-side`; first.txHash = `${PREFIX}-trace-fund-side`;
    await runMassTransactionTracker(prisma, source([first]), { runId: `${PREFIX}-trace-run-1`, retryBaseMs: 0 });
    const second = transfer(101, side);
    second.to = execution; second.eventId = `${PREFIX}:trace:fund-execution`; second.txHash = `${PREFIX}-trace-fund-execution`;
    await runMassTransactionTracker(prisma, source([second]), { runId: `${PREFIX}-trace-run-2`, retryBaseMs: 0 });
    const buy: MassTransactionEvent = {
      ...transfer(102, `${PREFIX}-router`), eventId: `${PREFIX}:trace:buy`, txHash: `${PREFIX}-trace-buy`,
      from: `${PREFIX}-router`, to: execution, actor: execution, kind: 'token_buy',
      asset: { address: `${PREFIX}-mint`, symbol: 'NEW', decimals: 6, amount: '5000', amountUsd: 200 }
    };
    await runMassTransactionTracker(prisma, source([buy]), { runId: `${PREFIX}-trace-run-3`, retryBaseMs: 0 });
    const result = await buildStoredMassTrackerTraces(prisma, { from: NOW, to: new Date(NOW.getTime() + 200_000), computedAt: NOW });
    expect(result.tracesPersisted).toBeGreaterThanOrEqual(1);
    const trace = await prisma.massTrackerTrace.findFirst({ where: { sourceWallet: rootWallet.address, tokenBought: `${PREFIX}-mint` } });
    expect(trace).toMatchObject({ terminalWallet: execution, route: 'multi_hop_transfer', grantsEligibility: false });
    expect(trace?.eventIds).toEqual([first.eventId, second.eventId, buy.eventId]);
  });
});
