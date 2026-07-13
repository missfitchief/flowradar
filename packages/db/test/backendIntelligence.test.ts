import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/client';
import { analyzeTokenWalletIntelligence } from '../src/intelligence/token';
import { expandWalletCapitalGraph } from '../src/intelligence/walletFlows';
import { enrollObservationWallet } from '../src/intelligence/monitoring';
import { scanTrackedTokenActivations } from '../src/intelligence/activation';

const PREFIX = 'BACKENDINTELLIGENCE';
const BASE_SOURCE = `0x${'a1'.repeat(20)}`;
const BASE_DIRECT = `0x${'b2'.repeat(20)}`;
const BASE_MULTIHOP = `0x${'c3'.repeat(20)}`;
const BASE_CEX = `0x${'d4'.repeat(20)}`;
const ARB_BRIDGE = `0x${'e5'.repeat(20)}`;
const ACTIVATION_WALLETS = ['11', '22', '33', '44', '55'].map((byte) => `0x${byte.repeat(20)}`);
const TOKEN_CA = `0x${'91'.repeat(20)}`;
const TOKENS = ['61', '62', '63', '64', '65', '66'].map((byte) => `0x${byte.repeat(20)}`);
const ALL_WALLETS = [BASE_SOURCE, BASE_DIRECT, BASE_MULTIHOP, BASE_CEX, ARB_BRIDGE, ...ACTIVATION_WALLETS];

async function cleanup() {
  await prisma.trackedTokenActivationAlert.deleteMany({ where: { OR: [{ dedupeKey: { startsWith: PREFIX } }, { tokenAddress: { in: [TOKEN_CA, ...TOKENS] } }] } });
  await prisma.trackedActivationScanRun.deleteMany({ where: { startedAt: { gte: new Date('2034-12-01T00:00:00Z') } } });
  await prisma.profitableWalletDiscoveryRun.deleteMany({ where: { startedAt: { gte: new Date('2034-12-01T00:00:00Z') } } });
  await prisma.massTrackerTrace.deleteMany({ where: { traceId: { startsWith: PREFIX } } });
  await prisma.walletFlowRelationship.deleteMany({ where: { OR: [{ sourceWallet: { in: ALL_WALLETS } }, { relatedWallet: { in: ALL_WALLETS } }] } });
  await prisma.massBridgeCorrelation.deleteMany({ where: { correlationId: { startsWith: PREFIX } } });
  await prisma.massTransactionEvent.deleteMany({ where: { eventId: { startsWith: PREFIX } } });
  await prisma.walletRoleAssignment.deleteMany({ where: { walletAddress: { in: ALL_WALLETS } } });
  await prisma.tokenWalletIntelligence.deleteMany({ where: { tokenAddress: TOKEN_CA } });
  await prisma.topPnlExtractionStatus.deleteMany({ where: { mint: TOKEN_CA } });
  await prisma.tokenTopPnlCandidate.deleteMany({ where: { mint: TOKEN_CA } });
  await prisma.historicalTokenUniverse.deleteMany({ where: { tokenAddress: { in: [TOKEN_CA, ...TOKENS] } } });
  await prisma.addressRegistry.deleteMany({ where: { address: BASE_CEX } });
  await prisma.unifiedEntity.deleteMany({ where: { addresses: { some: { address: { in: ALL_WALLETS } } } } });
  await prisma.unifiedEntityAddress.deleteMany({ where: { address: { in: ALL_WALLETS } } });
  await prisma.monitoringSubscription.deleteMany({ where: { wallet: { address: { in: ALL_WALLETS } } } });
  await prisma.wallet.deleteMany({ where: { address: { in: ALL_WALLETS } } });
  await prisma.token.deleteMany({ where: { address: { in: [TOKEN_CA, ...TOKENS] } } });
}

function massEvent(input: {
  id: string;
  chain?: 'BASE' | 'ARBITRUM';
  from: string;
  to: string;
  ts: Date;
  kind?: string;
  actor?: string | null;
  asset?: string | null;
  safe?: boolean;
  category?: string;
  sourceEntityKey?: string | null;
  bridgeJson?: Record<string, unknown> | null;
  observedAt?: Date;
}) {
  return {
    eventId: `${PREFIX}:${input.id}`,
    chain: input.chain ?? 'BASE' as const,
    txHash: `${PREFIX}:${input.id}:tx`,
    eventIndex: 0,
    blockOrSlot: BigInt(input.id.replace(/\D/g, '') || 1),
    ts: input.ts,
    kind: input.kind ?? 'native_transfer',
    status: 'succeeded',
    fromAddress: input.from,
    toAddress: input.to,
    actorAddress: input.actor === undefined ? input.from : input.actor,
    assetAddress: input.asset ?? null,
    amountToken: '1',
    amountUsd: 100,
    provider: 'backend-intelligence-test',
    observedAt: input.observedAt ?? input.ts,
    bridgeJson: input.bridgeJson ?? undefined,
    relevanceCategory: input.category ?? 'capital_transfer',
    relevanceScore: 90,
    reasonCodes: ['backend_intelligence_test'],
    safeEntityLink: input.safe ?? false,
    enrollmentCandidate: true,
    sourceEntityKey: input.sourceEntityKey ?? null,
    metadataJson: { testPrefix: PREFIX }
  };
}

beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

describe('backend wallet intelligence', () => {
  it('keeps a CA historical-only while ranking and monitoring discovered wallets', async () => {
    await prisma.tokenTopPnlCandidate.create({
      data: {
        chain: 'BASE', mint: TOKEN_CA, walletAddress: BASE_SOURCE, source: 'provider_test', providerRank: 1,
        claimedRealizedPnlUsd: 12_500, localBuyCount: 0, localSellCount: 0, localUnpricedTrades: 0,
        validation: 'provider_only', coverage: 'none', confidence: 65, reasonCodes: ['provider_claim_only'],
        receiptsJson: { source: 'test' }, caveats: ['not locally verified'], engineVersion: 1
      }
    });

    const report = await analyzeTokenWalletIntelligence(prisma, { chain: 'BASE', tokenAddress: TOKEN_CA, topLimit: 5, now: new Date('2035-01-01T00:00:00Z') });
    const [universe, intelligence, wallet, subscription] = await Promise.all([
      prisma.historicalTokenUniverse.findUnique({ where: { chain_tokenAddress: { chain: 'BASE', tokenAddress: TOKEN_CA } } }),
      prisma.tokenWalletIntelligence.findUnique({ where: { chain_tokenAddress_walletAddress: { chain: 'BASE', tokenAddress: TOKEN_CA, walletAddress: BASE_SOURCE } } }),
      prisma.wallet.findUnique({ where: { address_chain: { address: BASE_SOURCE, chain: 'BASE' } } }),
      prisma.monitoringSubscription.findFirst({ where: { wallet: { chain: 'BASE', address: BASE_SOURCE }, active: true } })
    ]);

    expect(report).toMatchObject({ sourceTokenLiveOpportunity: false, intelligenceRows: 1, monitoringEnrolled: 1 });
    expect(universe).toMatchObject({ historicalWinnerStatus: 'candidate' });
    expect(intelligence).toMatchObject({ status: 'observation_only', monitoringEnrolled: true, walletAddress: BASE_SOURCE });
    expect(wallet).toMatchObject({ status: 'observation_only', isWatched: true });
    expect(subscription).not.toBeNull();
    expect(await prisma.trackedTokenActivationAlert.count({ where: { tokenAddress: TOKEN_CA } })).toBe(0);
  }, 30_000);

  it('persists direct, multi-hop and exact-bridge paths without merging through a CEX', async () => {
    const base = new Date('2035-01-01T00:00:00Z');
    await prisma.addressRegistry.create({ data: { chain: 'BASE', address: BASE_CEX, category: 'CEX', label: 'test cex', source: 'test' } });
    await prisma.massTransactionEvent.createMany({ data: [
      massEvent({ id: '101', from: BASE_SOURCE, to: BASE_DIRECT, ts: base, safe: true }),
      massEvent({ id: '101-repeat', from: BASE_SOURCE, to: BASE_DIRECT, ts: new Date(base.getTime() + 500), safe: true }),
      massEvent({ id: '102', from: BASE_DIRECT, to: BASE_MULTIHOP, ts: new Date(base.getTime() + 1_000), safe: true }),
      massEvent({ id: '103', from: BASE_SOURCE, to: BASE_CEX, ts: new Date(base.getTime() + 2_000), safe: true }),
      massEvent({ id: '104', from: BASE_SOURCE, to: BASE_CEX, ts: new Date(base.getTime() + 3_000), kind: 'bridge_source', safe: false, bridgeJson: { recipient: ARB_BRIDGE, destinationChain: 'ARBITRUM' } }),
      massEvent({ id: '105', chain: 'ARBITRUM', from: BASE_CEX, to: ARB_BRIDGE, actor: ARB_BRIDGE, ts: new Date(base.getTime() + 4_000), kind: 'bridge_destination', safe: true }),
      massEvent({ id: '106', from: BASE_DIRECT, to: TOKENS[0], actor: BASE_DIRECT, ts: new Date(base.getTime() + 5_000), kind: 'token_buy', asset: TOKENS[0], safe: false, category: 'token_trade' }),
      massEvent({ id: '107', from: BASE_CEX, to: BASE_SOURCE, actor: BASE_CEX, ts: new Date(base.getTime() + 6_000), kind: 'bridge_source', safe: true }),
      massEvent({ id: '108', chain: 'ARBITRUM', from: BASE_CEX, to: ARB_BRIDGE, actor: ARB_BRIDGE, ts: new Date(base.getTime() + 7_000), kind: 'bridge_destination', safe: true })
    ] });
    await prisma.massBridgeCorrelation.createMany({ data: [
      { correlationId: `${PREFIX}:bridge:1`, protocol: 'test-bridge', sourceEventId: `${PREFIX}:104`, destinationEventId: `${PREFIX}:105`, status: 'verified', confidence: 0.99, reasonCodes: ['official_message_match'] },
      { correlationId: `${PREFIX}:bridge:service-terminal`, protocol: 'test-bridge', sourceEventId: `${PREFIX}:107`, destinationEventId: `${PREFIX}:108`, status: 'verified', confidence: 0.99, reasonCodes: ['official_message_match'] }
    ] });

    const report = await expandWalletCapitalGraph(prisma, { chain: 'BASE', walletAddress: BASE_SOURCE, maxDepth: 3, now: new Date(base.getTime() + 10_000) });
    const rows = await prisma.walletFlowRelationship.findMany({ where: { sourceChain: 'BASE', sourceWallet: BASE_SOURCE } });
    const cex = rows.find((row) => row.relatedWallet === BASE_CEX && row.route === 'cex_correlation');
    const bridge = rows.find((row) => row.relatedWallet === ARB_BRIDGE && row.route === 'exact_bridge');
    const sourceEntity = await prisma.unifiedEntityAddress.findUnique({ where: { chain_address: { chain: 'BASE', address: BASE_SOURCE } } });
    const cexEntity = await prisma.unifiedEntityAddress.findUnique({ where: { chain_address: { chain: 'BASE', address: BASE_CEX } } });

    expect(report).toMatchObject({ direct: 1, multiHop: 1, exactBridge: 1, cexInference: 1, tokenBuysObserved: 1 });
    expect(rows.find((row) => row.relatedWallet === BASE_MULTIHOP && row.route === 'multi_hop_transfer')?.safeEntityLink).toBe(true);
    expect(rows.find((row) => row.relatedWallet === BASE_MULTIHOP && row.route === 'multi_hop_transfer')?.transferReceiptIds).toHaveLength(2);
    expect(bridge).toMatchObject({ safeEntityLink: true, role: 'bridge_linked_receiver' });
    expect(cex).toMatchObject({ safeEntityLink: false, role: 'service_router_cex_node' });
    expect(sourceEntity?.entityId).not.toBe(cexEntity?.entityId);
  }, 30_000);

  it('creates activation alerts only from new tracked buys and records an honest empty scan', async () => {
    const now = new Date('2035-01-15T12:00:00Z');
    const since = new Date(now.getTime() - 2 * 86_400_000);
    for (const address of ACTIVATION_WALLETS) {
      await enrollObservationWallet(prisma, { chain: 'BASE', address, role: 'execution_wallet', reason: `${PREFIX}:activation`, now: since });
    }
    const shared = await prisma.unifiedEntity.create({
      data: {
        entityKey: `${PREFIX}:shared`, chains: ['BASE'], memberCount: 2, confidence: 0.9, evidenceJson: {}, caveats: ['test'], engineVersion: 1, computedAt: now,
        addresses: { create: ACTIVATION_WALLETS.slice(0, 2).map((address) => ({ chain: 'BASE' as const, address, role: 'execution_wallet', evidenceTier: 'test', confidence: 0.9, evidenceJson: {}, observationOnly: true })) }
      }
    });
    void shared;
    for (let index = 2; index < ACTIVATION_WALLETS.length; index += 1) {
      await prisma.unifiedEntity.create({
        data: {
          entityKey: `${PREFIX}:independent:${index}`, chains: ['BASE'], memberCount: 1, confidence: 0.8, evidenceJson: {}, caveats: ['test'], engineVersion: 1, computedAt: now,
          addresses: { create: { chain: 'BASE', address: ACTIVATION_WALLETS[index], role: 'execution_wallet', evidenceTier: 'test', confidence: 0.8, evidenceJson: {}, observationOnly: true } }
        }
      });
    }
    await prisma.token.createMany({ data: TOKENS.map((address, index) => ({
      chain: 'BASE', address, symbol: `T${index}`, name: `Token ${index}`, decimals: 18,
      firstSeenAt: new Date(now.getTime() - (index === 4 ? 100 : 1) * 86_400_000), riskFlags: []
    })) });
    await prisma.token.create({ data: { chain: 'BASE', address: TOKEN_CA, symbol: 'LATE', name: 'Late observed token', decimals: 18, firstSeenAt: new Date(now.getTime() - 4 * 86_400_000), riskFlags: [] } });
    await prisma.historicalTokenUniverse.createMany({ data: [
      { chain: 'BASE', tokenAddress: TOKENS[4], sources: ['test'], historicalWinnerStatus: 'verified_above_10m', coverage: 'covered', processingStatus: 'processed', evidenceJson: {} },
      { chain: 'BASE', tokenAddress: TOKENS[5], sources: ['test'], historicalWinnerStatus: 'verified_above_10m', coverage: 'covered', processingStatus: 'processed', evidenceJson: {} }
    ] });
    await prisma.massTransactionEvent.createMany({ data: [
      massEvent({ id: '201', from: ACTIVATION_WALLETS[0], to: TOKENS[0], actor: ACTIVATION_WALLETS[0], ts: new Date(now.getTime() - 3_600_000), kind: 'token_buy', asset: TOKENS[0], category: 'token_trade' }),
      massEvent({ id: '202', from: ACTIVATION_WALLETS[1], to: TOKENS[0], actor: ACTIVATION_WALLETS[1], ts: new Date(now.getTime() - 3_500_000), kind: 'token_buy', asset: TOKENS[0], category: 'token_trade' }),
      massEvent({ id: '203', from: BASE_SOURCE, to: ACTIVATION_WALLETS[2], ts: new Date(now.getTime() - 7_200_000), sourceEntityKey: `${PREFIX}:funder` }),
      massEvent({ id: '204', from: ACTIVATION_WALLETS[2], to: TOKENS[1], actor: ACTIVATION_WALLETS[2], ts: new Date(now.getTime() - 3_000_000), kind: 'token_buy', asset: TOKENS[1], category: 'token_trade' }),
      massEvent({ id: '205', from: ACTIVATION_WALLETS[3], to: TOKENS[2], actor: ACTIVATION_WALLETS[3], ts: new Date(now.getTime() - 2_500_000), kind: 'token_buy', asset: TOKENS[2], category: 'token_trade' }),
      massEvent({ id: '206', from: ACTIVATION_WALLETS[3], to: TOKENS[3], actor: ACTIVATION_WALLETS[3], ts: new Date(now.getTime() - 2_000_000), kind: 'token_buy', asset: TOKENS[3], category: 'token_trade' }),
      massEvent({ id: '207', from: ACTIVATION_WALLETS[4], to: TOKENS[3], actor: ACTIVATION_WALLETS[4], ts: new Date(now.getTime() - 1_900_000), kind: 'token_buy', asset: TOKENS[3], category: 'token_trade' }),
      massEvent({ id: '208', from: ACTIVATION_WALLETS[3], to: TOKENS[4], actor: ACTIVATION_WALLETS[3], ts: new Date(now.getTime() - 1_500_000), kind: 'token_buy', asset: TOKENS[4], category: 'token_trade' }),
      massEvent({ id: '209', from: ACTIVATION_WALLETS[4], to: TOKENS[4], actor: ACTIVATION_WALLETS[4], ts: new Date(now.getTime() - 1_400_000), kind: 'token_buy', asset: TOKENS[4], category: 'token_trade' }),
      massEvent({ id: '210', from: ACTIVATION_WALLETS[3], to: TOKEN_CA, actor: ACTIVATION_WALLETS[3], ts: new Date(now.getTime() - 3 * 86_400_000), observedAt: new Date(now.getTime() - 3_600_000), kind: 'token_buy', asset: TOKEN_CA, category: 'token_trade' }),
      massEvent({ id: '211', from: ACTIVATION_WALLETS[4], to: TOKEN_CA, actor: ACTIVATION_WALLETS[4], ts: new Date(now.getTime() - 3 * 86_400_000 + 1_000), observedAt: new Date(now.getTime() - 3_500_000), kind: 'token_buy', asset: TOKEN_CA, category: 'token_trade' })
    ] });
    await prisma.trackedTokenActivationAlert.create({ data: {
      dedupeKey: `${PREFIX}:mature-false-positive`, chain: 'BASE', tokenAddress: TOKENS[4], alertType: 'independent_entity_confluence',
      activatedAt: new Date(now.getTime() - 1_400_000), trackedWallets: ACTIVATION_WALLETS.slice(3),
      entityKeys: [`${PREFIX}:independent:3`, `${PREFIX}:independent:4`], trackedWalletCount: 2, independentEntityCount: 2,
      sourceEventIds: [`${PREFIX}:208`, `${PREFIX}:209`], confidence: 0.9, historicalToken: true,
      evidenceJson: { legacy: true }, caveats: ['test legacy false positive'], status: 'active', engineVersion: 1, computedAt: now
    } });
    await prisma.massTrackerTrace.create({ data: {
      traceId: `${PREFIX}:trace:1`, sourceEntityKey: `${PREFIX}:origin`, sourceRole: 'root_main', sourceWallet: BASE_SOURCE,
      terminalWallet: ACTIVATION_WALLETS[3], tokenBought: TOKENS[2], route: 'direct_transfer', eventIds: [`${PREFIX}:205`], bridgeCorrelationIds: [],
      fundingToBuyDelaySec: 60, confidence: 0.9, reasonCodes: ['test'], grantsEligibility: false, computedAt: new Date(now.getTime() - 2_000_000)
    } });

    const report = await scanTrackedTokenActivations(prisma, { since, now });
    const alertTypes = new Set((await prisma.trackedTokenActivationAlert.findMany({ where: { tokenAddress: { in: TOKENS } } })).map((row) => row.alertType));
    for (const expectedType of ['same_cluster_multi_wallet_buy', 'independent_entity_confluence']) expect(alertTypes.has(expectedType)).toBe(true);
    expect(alertTypes.has('dormant_funded_wallet_buy')).toBe(false);
    expect(alertTypes.has('tracked_entity_receiver_buy')).toBe(false);
    expect(report.newBuyEvents).toBe(10);
    expect(await prisma.trackedTokenActivationAlert.count({ where: { tokenAddress: TOKEN_CA, status: 'active' } })).toBeGreaterThanOrEqual(1);
    expect(report.historicalWithoutNewActivitySkipped).toBeGreaterThanOrEqual(1);
    expect(await prisma.trackedTokenActivationAlert.count({ where: { tokenAddress: TOKENS[4], status: 'active' } })).toBe(0);
    expect(await prisma.trackedTokenActivationAlert.findUnique({ where: { dedupeKey: `${PREFIX}:mature-false-positive` } })).toMatchObject({ status: 'invalidated' });

    const empty = await scanTrackedTokenActivations(prisma, { since: now, now: new Date(now.getTime() + 1_000) });
    expect(empty).toMatchObject({ honestEmpty: true, newBuyEvents: 0, alertsCreated: 0 });
    const receipt = await prisma.trackedActivationScanRun.findUnique({ where: { id: empty.runId } });
    expect(receipt?.status).toBe('empty');
  }, 30_000);
});
