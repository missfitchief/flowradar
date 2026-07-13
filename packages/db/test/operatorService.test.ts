import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/client';
import { OperatorService } from '../src/operator/service';

const PREFIX = 'OPSERVICETEST';
const ADDRESS = `0x${'ab'.repeat(20)}`;
const ROOT_ADDRESS = `0x${'ef'.repeat(20)}`;

async function cleanup() {
  await prisma.massBridgeCorrelation.deleteMany({ where: { correlationId: { startsWith: PREFIX } } });
  await prisma.massTransactionEvent.deleteMany({ where: { eventId: { startsWith: PREFIX } } });
  await prisma.operatorWatchAlert.deleteMany({ where: { watch: { targetKey: { startsWith: PREFIX } } } });
  await prisma.operatorWatch.deleteMany({ where: { OR: [{ targetKey: { startsWith: PREFIX } }, { userId: PREFIX }] } });
  await prisma.operatorSession.deleteMany({ where: { userId: PREFIX } });
  await prisma.telegramBotCursor.deleteMany({ where: { botKey: { startsWith: PREFIX } } });
  await prisma.tokenTopPnlCandidate.deleteMany({ where: { walletAddress: ADDRESS } });
  await prisma.tokenTopPnlCandidate.deleteMany({ where: { walletAddress: ROOT_ADDRESS } });
  await prisma.lineageRoot.deleteMany({ where: { wallet: { address: ROOT_ADDRESS } } });
  await prisma.wallet.deleteMany({ where: { address: ROOT_ADDRESS } });
}

beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

describe('OperatorService', () => {
  it('persists watchlist and restart-safe session/cursor state', async () => {
    const service = new OperatorService(prisma);
    const watch = await service.watch(PREFIX, PREFIX, ADDRESS);
    expect(watch).toMatchObject({ userId: PREFIX, active: true, targetType: 'wallet' });
    const again = await service.watch(PREFIX, PREFIX, ADDRESS);
    expect(again.id).toBe(watch.id);
    expect(await service.listWatches(PREFIX, PREFIX)).toHaveLength(1);

    const session = await service.createSession(PREFIX, PREFIX, 'recent', { page: 1, pageSize: 10 });
    expect(await service.getSession(session.id, PREFIX, PREFIX)).not.toBeNull();
    expect(await service.getSession(session.id, 'other-user', PREFIX)).toBeNull();
    expect(await service.updateSession(session.id, PREFIX, PREFIX, { page: 2, pageSize: 10 })).toBe(true);

    await service.setCursor(`${PREFIX}:bot`, 123n);
    expect(await service.getCursor(`${PREFIX}:bot`)).toBe(123n);
  });

  it('returns automatic candidates through bounded profitable pagination', async () => {
    await prisma.tokenTopPnlCandidate.create({
      data: {
        chain: 'BASE', mint: `0x${'cd'.repeat(20)}`, walletAddress: ADDRESS, source: 'local_reconstruction', providerRank: 1,
        localBuyCount: 1, localSellCount: 1, localBoughtUsd: 100, localSoldUsd: 500, localRealizedProxyUsd: 400,
        localUnpricedTrades: 0, validation: 'locally_verified', coverage: 'local_full', confidence: 80, reasonCodes: ['test'],
        receiptsJson: {}, caveats: ['observation_only'], engineVersion: 1
      }
    });
    const result = await new OperatorService(prisma).profitable({ chain: 'BASE', page: 1, pageSize: 1 });
    expect(result.pageSize).toBe(1);
    expect(result.items[0]).toMatchObject({ chain: 'BASE', address: ADDRESS, validation: 'locally_verified', localRealizedPnlUsd: 400 });
  });

  it('never presents an operator root as a trader', async () => {
    const wallet = await prisma.wallet.create({ data: { chain: 'BASE', address: ROOT_ADDRESS, firstSeenAt: new Date(), lastActiveAt: new Date(), status: 'observation_only' } });
    await prisma.lineageRoot.create({ data: { walletId: wallet.id, source: 'operator_file', permanent: true, firstImportedAt: new Date(), lastSeenInImportAt: new Date() } });
    await prisma.tokenTopPnlCandidate.create({ data: { chain: 'BASE', mint: `0x${'de'.repeat(20)}`, walletAddress: ROOT_ADDRESS, source: 'local_reconstruction', providerRank: 1, localBuyCount: 1, localSellCount: 1, localBoughtUsd: 10, localSoldUsd: 100, localRealizedProxyUsd: 90, localUnpricedTrades: 0, validation: 'locally_verified', coverage: 'local_full', confidence: 90, reasonCodes: ['test'], receiptsJson: {}, caveats: ['observation_only'], engineVersion: 1 } });
    const result = await new OperatorService(prisma).profitable({ chain: 'BASE', pageSize: 100 });
    expect(result.items.some((x) => x.address === ROOT_ADDRESS)).toBe(false);
  });

  it('normalizes legacy 0-100 bridge confidence for operator output', async () => {
    const destination = `0x${'45'.repeat(20)}`;
    await prisma.massTransactionEvent.createMany({ data: [
      { eventId: `${PREFIX}:bridge-source`, chain: 'BASE', txHash: `${PREFIX}-source`, eventIndex: 0, blockOrSlot: 1n, ts: new Date(), kind: 'bridge_source', status: 'succeeded', fromAddress: ADDRESS, toAddress: destination, actorAddress: ADDRESS, amountToken: '1', amountUsd: 100, provider: 'test', observedAt: new Date(), relevanceCategory: 'bridge_verified', relevanceScore: 100, reasonCodes: ['test'], metadataJson: {} },
      { eventId: `${PREFIX}:bridge-destination`, chain: 'ARBITRUM', txHash: `${PREFIX}-destination`, eventIndex: 0, blockOrSlot: 2n, ts: new Date(), kind: 'bridge_destination', status: 'succeeded', fromAddress: ADDRESS, toAddress: destination, actorAddress: destination, amountToken: '1', amountUsd: 100, provider: 'test', observedAt: new Date(), relevanceCategory: 'bridge_verified', relevanceScore: 100, reasonCodes: ['test'], metadataJson: {} }
    ] });
    await prisma.massBridgeCorrelation.create({ data: { correlationId: `${PREFIX}:bridge`, protocol: 'test', sourceEventId: `${PREFIX}:bridge-source`, destinationEventId: `${PREFIX}:bridge-destination`, status: 'verified', confidence: 100, reasonCodes: ['test'] } });
    const result = await new OperatorService(prisma).bridges(ADDRESS);
    expect(result.items[0]?.confidence).toBe(1);
  });
});
