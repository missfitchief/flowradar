import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/client';
import { OperatorService } from '../src/operator/service';

const PREFIX = 'OPSERVICETEST';
const ADDRESS = `0x${'ab'.repeat(20)}`;
const ROOT_ADDRESS = `0x${'ef'.repeat(20)}`;
const ALERT_WALLETS = [`0x${'12'.repeat(20)}`, `0x${'34'.repeat(20)}`];
const ALERT_TOKEN = `0x${'56'.repeat(20)}`;
const CORE_ADDRESS = `0x${'78'.repeat(20)}`;
const CORE_CONNECTED = `0x${'89'.repeat(20)}`;
const CORE_BRIDGE_CONNECTED = `0x${'bc'.repeat(20)}`;
const CORE_TOKEN = `0x${'9a'.repeat(20)}`;

async function cleanup() {
  await prisma.operatorWatchAlert.deleteMany({ where: { watch: { targetKey: CORE_ADDRESS } } });
  await prisma.operatorWatch.deleteMany({ where: { targetKey: CORE_ADDRESS } });
  await prisma.walletFlowRelationship.deleteMany({ where: { OR: [{ sourceWallet: CORE_ADDRESS }, { relatedWallet: { in: [CORE_CONNECTED, CORE_BRIDGE_CONNECTED] } }] } });
  await prisma.massTransactionEvent.deleteMany({ where: { eventId: { startsWith: `${PREFIX}:core:` } } });
  await prisma.lineageRoot.deleteMany({ where: { wallet: { address: { in: [CORE_ADDRESS, CORE_CONNECTED, CORE_BRIDGE_CONNECTED] } } } });
  await prisma.wallet.deleteMany({ where: { address: { in: [CORE_ADDRESS, CORE_CONNECTED, CORE_BRIDGE_CONNECTED] } } });
  await prisma.token.deleteMany({ where: { address: CORE_TOKEN } });
  await prisma.massBridgeCorrelation.deleteMany({ where: { correlationId: { startsWith: PREFIX } } });
  await prisma.massTransactionEvent.deleteMany({ where: { eventId: { startsWith: PREFIX } } });
  await prisma.trackedTokenActivationAlert.deleteMany({ where: { tokenAddress: ALERT_TOKEN } });
  await prisma.operatorWatchAlert.deleteMany({ where: { watch: { targetKey: { startsWith: PREFIX } } } });
  await prisma.operatorWatch.deleteMany({ where: { OR: [{ targetKey: { startsWith: PREFIX } }, { userId: PREFIX }] } });
  await prisma.operatorSession.deleteMany({ where: { userId: PREFIX } });
  await prisma.telegramBotCursor.deleteMany({ where: { botKey: { startsWith: PREFIX } } });
  await prisma.tokenTopPnlCandidate.deleteMany({ where: { walletAddress: ADDRESS } });
  await prisma.tokenTopPnlCandidate.deleteMany({ where: { walletAddress: ROOT_ADDRESS } });
  await prisma.lineageRoot.deleteMany({ where: { wallet: { address: ROOT_ADDRESS } } });
  await prisma.wallet.deleteMany({ where: { address: ROOT_ADDRESS } });
  await prisma.unifiedEntity.deleteMany({ where: { entityKey: `${PREFIX}:activation-entity` } });
  await prisma.token.deleteMany({ where: { address: ALERT_TOKEN } });
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

    const pending = await service.setPendingSession(PREFIX, PREFIX, 'wallet', 10);
    const pendingState = await service.getPendingSession(PREFIX, PREFIX);
    expect(pendingState).toMatchObject({ workflow: 'wallet', session: { id: pending.id, userId: PREFIX, chatId: PREFIX } });
    expect(pending.expiresAt.getTime() - pending.createdAt.getTime()).toBeGreaterThanOrEqual(9 * 60_000);
    expect(await service.clearPendingSession(PREFIX, PREFIX)).toBe(1);
    expect(await service.getPendingSession(PREFIX, PREFIX)).toBeNull();

    await service.setCursor(`${PREFIX}:bot`, 123n);
    expect(await service.getCursor(`${PREFIX}:bot`)).toBe(123n);
  });

  it('adds, lists and removes a restart-safe cross-chain Core wallet without deleting history', async () => {
    const service = new OperatorService(prisma);
    const added = await service.addCoreWallet(PREFIX, PREFIX, CORE_ADDRESS);
    expect(added.watch).toMatchObject({ targetType: 'core_wallet', targetKey: CORE_ADDRESS, active: true });
    expect(added.refs.map((ref) => ref.chain).sort()).toEqual(['ARBITRUM', 'BASE', 'BSC', 'ETHEREUM']);
    const roots = await prisma.lineageRoot.findMany({ where: { wallet: { address: CORE_ADDRESS } }, include: { subscriptions: true } });
    expect(roots).toHaveLength(4);
    expect(roots.every((root) => root.subscriptions.some((subscription) => subscription.priority === 'root_permanent' && subscription.active && subscription.lineageRootId === root.id && subscription.tierPriority === -1))).toBe(true);

    await prisma.massTransactionEvent.create({ data: {
      eventId: `${PREFIX}:core:history`, chain: 'BASE', txHash: `${PREFIX}:core:history`, eventIndex: 0, blockOrSlot: 1n,
      ts: new Date(), kind: 'native_transfer', status: 'succeeded', fromAddress: CORE_ADDRESS, toAddress: CORE_CONNECTED,
      actorAddress: CORE_ADDRESS, amountToken: '1', amountUsd: 100, provider: 'test', observedAt: new Date(),
      relevanceCategory: 'capital_transfer', relevanceScore: 90, reasonCodes: ['direct_transfer'], safeEntityLink: true,
      enrollmentCandidate: true, metadataJson: {}
    } });
    const list = await service.listCoreWallets(PREFIX, PREFIX);
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ address: CORE_ADDRESS, eventCount: 1, monitoringPriority: 'root_permanent' });

    expect(await service.removeCoreWallet(PREFIX, PREFIX, CORE_ADDRESS)).toBe(1);
    expect((await service.listCoreWallets(PREFIX, PREFIX)).total).toBe(0);
    expect(await prisma.massTransactionEvent.count({ where: { eventId: `${PREFIX}:core:history` } })).toBe(1);
    expect(await prisma.monitoringSubscription.count({ where: { lineageRoot: { source: 'telegram_core' }, active: true } })).toBe(0);
  });

  it('stores transfers silently but alerts on Core and directly funded receiver token buys', async () => {
    const service = new OperatorService(prisma);
    const added = await service.addCoreWallet(PREFIX, PREFIX, CORE_ADDRESS);
    const now = new Date();
    await prisma.token.create({ data: { chain: 'BASE', address: CORE_TOKEN, symbol: 'CORE', name: 'Core Signal Token', decimals: 18, firstSeenAt: now, riskFlags: [] } });
    await prisma.walletFlowRelationship.create({ data: {
      sourceChain: 'BASE', sourceWallet: CORE_ADDRESS, relatedChain: 'BASE', relatedWallet: CORE_CONNECTED,
      role: 'execution_wallet', route: 'direct_transfer', hops: 1, transferCount: 1,
      firstTransferTs: new Date(now.getTime() - 5_000), lastTransferTs: new Date(now.getTime() - 5_000), relationshipConfidence: 0.82,
      safeEntityLink: false, transferReceiptIds: [`${PREFIX}:core:funding`], bridgeCorrelationIds: [],
      supportingEvidenceJson: { knownAmountUsd: 500 }, contradictingEvidenceJson: {}, tradedTokensJson: [], pnlMetricsJson: {},
      status: 'observation_only', engineVersion: 1, computedAt: now
    } });
    await prisma.walletFlowRelationship.create({ data: {
      sourceChain: 'BASE', sourceWallet: CORE_ADDRESS, relatedChain: 'ARBITRUM', relatedWallet: CORE_BRIDGE_CONNECTED,
      role: 'bridge_linked_receiver', route: 'exact_bridge', hops: 1, transferCount: 1,
      firstTransferTs: new Date(now.getTime() - 4_000), lastTransferTs: new Date(now.getTime() - 4_000), relationshipConfidence: 0.96,
      safeEntityLink: true, transferReceiptIds: [`${PREFIX}:core:bridge-funding`], bridgeCorrelationIds: [`${PREFIX}:core:bridge-correlation`],
      supportingEvidenceJson: { knownAmountUsd: 750 }, contradictingEvidenceJson: {}, tradedTokensJson: [], pnlMetricsJson: {},
      status: 'observation_only', engineVersion: 1, computedAt: now
    } });
    await prisma.massTransactionEvent.createMany({ data: [
      { eventId: `${PREFIX}:core:funding`, chain: 'BASE', txHash: `${PREFIX}:core:funding`, eventIndex: 0, blockOrSlot: 1n, ts: new Date(now.getTime() - 5_000), kind: 'native_transfer', status: 'succeeded', fromAddress: CORE_ADDRESS, toAddress: CORE_CONNECTED, actorAddress: CORE_ADDRESS, amountToken: '0.2', amountUsd: 500, provider: 'test', observedAt: new Date(now.getTime() - 5_000), relevanceCategory: 'capital_transfer', relevanceScore: 90, reasonCodes: ['direct_transfer'], safeEntityLink: true, enrollmentCandidate: true, metadataJson: {} },
      { eventId: `${PREFIX}:core:root-buy`, chain: 'BASE', txHash: `${PREFIX}:core:root-buy`, eventIndex: 0, blockOrSlot: 2n, ts: new Date(now.getTime() - 3_000), kind: 'token_buy', status: 'succeeded', fromAddress: CORE_ADDRESS, toAddress: CORE_ADDRESS, actorAddress: CORE_ADDRESS, assetAddress: CORE_TOKEN, assetSymbol: 'CORE', amountToken: '100', amountUsd: 250, provider: 'test', observedAt: new Date(now.getTime() - 3_000), relevanceCategory: 'token_deployment', relevanceScore: 90, reasonCodes: ['buy'], metadataJson: {} },
      { eventId: `${PREFIX}:core:receiver-buy`, chain: 'BASE', txHash: `${PREFIX}:core:receiver-buy`, eventIndex: 0, blockOrSlot: 3n, ts: new Date(now.getTime() - 1_000), kind: 'token_buy', status: 'succeeded', fromAddress: CORE_CONNECTED, toAddress: CORE_CONNECTED, actorAddress: CORE_CONNECTED, assetAddress: CORE_TOKEN, assetSymbol: 'CORE', amountToken: '50', amountUsd: 125, provider: 'test', observedAt: new Date(now.getTime() - 1_000), relevanceCategory: 'token_deployment', relevanceScore: 90, reasonCodes: ['buy'], metadataJson: {} }
      ,{ eventId: `${PREFIX}:core:bridge-receiver-buy`, chain: 'ARBITRUM', txHash: `${PREFIX}:core:bridge-receiver-buy`, eventIndex: 0, blockOrSlot: 4n, ts: new Date(now.getTime() - 500), kind: 'token_buy', status: 'succeeded', fromAddress: CORE_BRIDGE_CONNECTED, toAddress: CORE_BRIDGE_CONNECTED, actorAddress: CORE_BRIDGE_CONNECTED, assetAddress: CORE_TOKEN, assetSymbol: 'CORE', amountToken: '25', amountUsd: 60, provider: 'test', observedAt: new Date(now.getTime() - 500), relevanceCategory: 'token_deployment', relevanceScore: 90, reasonCodes: ['buy'], metadataJson: {} }
    ] });

    expect(await service.materializeWatchAlerts(new Date(now.getTime() - 10_000))).toBe(3);
    const alerts = await prisma.operatorWatchAlert.findMany({ where: { watchId: added.watch.id }, orderBy: { alertType: 'asc' } });
    expect(alerts.map((alert) => alert.alertType)).toEqual(['connected_core_receiver_buy', 'connected_core_receiver_buy', 'core_wallet_token_buy']);
    expect(alerts.some((alert) => alert.eventKey.includes('funding'))).toBe(false);
    expect(alerts.find((alert) => alert.alertType === 'connected_core_receiver_buy')?.payloadJson).toMatchObject({ coreWallet: CORE_ADDRESS, wallet: CORE_CONNECTED, connection: 'direct_transfer', ca: CORE_TOKEN });
    expect(alerts.some((alert) => alert.alertType === 'connected_core_receiver_buy' && JSON.stringify(alert.payloadJson).includes('exact_bridge'))).toBe(true);
    expect(await service.materializeWatchAlerts(new Date(now.getTime() - 10_000))).toBe(0);

    const delivered = alerts.find((alert) => alert.alertType === 'core_wallet_token_buy')!;
    await service.recordWatchAlertDispatchAttempt(delivered.id);
    await service.markWatchAlert(delivered.id, undefined, { telegramMessageId: 456, telegramChatId: 123 });
    expect((await prisma.operatorWatchAlert.findUniqueOrThrow({ where: { id: delivered.id } })).payloadJson).toMatchObject({
      pipeline: { persisted: true, eligibility: 'eligible' },
      deliveryReceipt: { attempts: 1, status: 'delivered', telegramMessageId: 456, telegramChatId: 123 }
    });
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

  it('materializes only same-cluster multi-wallet new-token activation for a wallet watch', async () => {
    const now = new Date();
    const entity = await prisma.unifiedEntity.create({
      data: {
        entityKey: `${PREFIX}:activation-entity`, chains: ['BASE'], memberCount: 3, confidence: 0.9,
        evidenceJson: {}, caveats: ['test'], engineVersion: 1, computedAt: now,
        addresses: { create: [ADDRESS, ...ALERT_WALLETS].map((address) => ({ chain: 'BASE' as const, address, role: 'execution_wallet', evidenceTier: 'test', confidence: 0.9, evidenceJson: {}, observationOnly: true })) }
      }
    });
    await prisma.token.create({ data: { chain: 'BASE', address: ALERT_TOKEN, symbol: 'NEW', name: 'New Cluster Token', decimals: 18, firstSeenAt: now, riskFlags: [] } });
    const service = new OperatorService(prisma);
    const watch = await service.watch(PREFIX, PREFIX, ADDRESS);
    await prisma.trackedTokenActivationAlert.create({
      data: {
        dedupeKey: `${PREFIX}:activation`, chain: 'BASE', tokenAddress: ALERT_TOKEN, alertType: 'same_cluster_multi_wallet_buy', activatedAt: now,
        trackedWallets: ALERT_WALLETS, entityKeys: [entity.entityKey], trackedWalletCount: 2, independentEntityCount: 1,
        sourceEventIds: [`${PREFIX}:buy:1`, `${PREFIX}:buy:2`], confidence: 0.85, historicalToken: false,
        evidenceJson: { newToken: true }, caveats: ['test'], status: 'active', engineVersion: 1, computedAt: now
      }
    });
    expect(await service.materializeWatchAlerts(new Date(now.getTime() - 60_000))).toBe(1);
    const alert = await prisma.operatorWatchAlert.findFirst({ where: { watchId: watch.id, alertType: 'receiver_bought_token' } });
    expect(alert?.eventKey).toBe(`tracked-activation:${PREFIX}:activation`);
    expect(alert?.payloadJson).toMatchObject({ token: 'New Cluster Token', symbol: 'NEW', ca: ALERT_TOKEN, wallets: ALERT_WALLETS, clusters: [entity.entityKey] });
  });
});
