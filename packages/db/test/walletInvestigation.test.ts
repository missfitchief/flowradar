import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MassTransactionEvent } from '@flowradar/core';
import type { WalletBridgeScanProvider, WalletCapitalScanProvider } from '@flowradar/providers';
import { prisma } from '../src/client';
import { WalletInvestigationService } from '../src/investigation/walletInvestigation';

const PREFIX = 'WALLETINVESTIGATIONTEST';
const ROOT = `0x${'11'.repeat(20)}`;
const DIRECT = `0x${'22'.repeat(20)}`;
const MULTIHOP = `0x${'33'.repeat(20)}`;
const BRIDGE_DESTINATION = `0x${'44'.repeat(20)}`;
const BRIDGE_CONTRACT = `0x${'55'.repeat(20)}`;
const TOKENS = [`0x${'66'.repeat(20)}`, `0x${'77'.repeat(20)}`, `0x${'88'.repeat(20)}`];
const WALLETS = [ROOT, DIRECT, MULTIHOP, BRIDGE_DESTINATION, BRIDGE_CONTRACT];
const BASE = new Date('2036-01-01T00:00:00.000Z');

async function cleanup() {
  await prisma.walletIntelligenceEvent.deleteMany({ where: { walletAddress: { in: WALLETS } } });
  await prisma.walletIntelligenceObservation.deleteMany({ where: { profile: { address: { in: WALLETS } } } });
  const intelligenceProfiles = await prisma.walletIntelligenceProfile.findMany({ where: { address: { in: WALLETS } }, select: { id: true, clusterId: true } });
  const intelligenceClusterIds = intelligenceProfiles.map((row) => row.clusterId);
  const intelligenceEntityIds = (await prisma.intelligenceEntityMembership.findMany({ where: { profileId: { in: intelligenceProfiles.map((row) => row.id) } }, select: { entityId: true } })).map((row) => row.entityId);
  await prisma.intelligenceEntityMembership.deleteMany({ where: { profileId: { in: intelligenceProfiles.map((row) => row.id) } } });
  await prisma.walletIntelligenceProfile.deleteMany({ where: { address: { in: WALLETS } } });
  if (intelligenceClusterIds.length) {
    await prisma.intelligenceClusterMerge.deleteMany({ where: { OR: [{ fromClusterId: { in: intelligenceClusterIds } }, { intoClusterId: { in: intelligenceClusterIds } }] } });
    await prisma.intelligenceClusterObservation.deleteMany({ where: { clusterId: { in: intelligenceClusterIds } } });
    await prisma.intelligenceCluster.deleteMany({ where: { id: { in: intelligenceClusterIds } } });
  }
  if (intelligenceEntityIds.length) {
    await prisma.intelligenceEntityAction.deleteMany({ where: { OR: [{ sourceEntityIds: { hasSome: intelligenceEntityIds } }, { targetEntityIds: { hasSome: intelligenceEntityIds } }] } });
    await prisma.intelligenceEntityDecaySnapshot.deleteMany({ where: { entityId: { in: intelligenceEntityIds } } });
    await prisma.intelligenceEntityVersion.deleteMany({ where: { entityId: { in: intelligenceEntityIds } } });
    await prisma.intelligenceEntity.deleteMany({ where: { id: { in: intelligenceEntityIds }, memberships: { none: {} } } });
  }
  const investigations = await prisma.walletInvestigation.findMany({ where: { rootAddress: ROOT }, select: { id: true } });
  for (const investigation of investigations) {
    await prisma.massTrackerRun.deleteMany({ where: { metadataJson: { path: ['investigationId'], equals: investigation.id } } });
  }
  await prisma.walletInvestigation.deleteMany({ where: { rootAddress: ROOT } });
  await prisma.walletFlowRelationship.deleteMany({ where: { OR: [{ sourceWallet: { in: WALLETS } }, { relatedWallet: { in: WALLETS } }] } });
  await prisma.massBridgeCorrelation.deleteMany({ where: { correlationId: { startsWith: PREFIX } } });
  await prisma.massTransactionEvent.deleteMany({ where: { eventId: { startsWith: PREFIX } } });
  await prisma.walletRoleAssignment.deleteMany({ where: { walletAddress: { in: WALLETS } } });
  await prisma.unifiedEntity.deleteMany({ where: { addresses: { some: { address: { in: WALLETS } } } } });
  await prisma.monitoringSubscription.deleteMany({ where: { wallet: { address: { in: WALLETS } } } });
  await prisma.wallet.deleteMany({ where: { address: { in: WALLETS } } });
  await prisma.token.deleteMany({ where: { address: { in: TOKENS } } });
}

beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

describe('WalletInvestigationService', () => {
  it('persists one reusable EVM investigation with direct, multi-hop, verified bridge and funded token buys', async () => {
    const walletScanner = scanner();
    const bridgeScanner: WalletBridgeScanProvider = {
      async scanWallets() {
        return {
          provider: 'official-bridge-test', pagesFetched: 1, complete: true, warnings: [],
          events: [
            event('bridge-source', 'BASE', ROOT, BRIDGE_CONTRACT, 4, 'bridge_source', null, ROOT, bridge('BASE', 'ARBITRUM', ROOT, BRIDGE_DESTINATION, 'source')),
            event('bridge-destination', 'ARBITRUM', BRIDGE_CONTRACT, BRIDGE_DESTINATION, 5, 'bridge_destination', null, BRIDGE_DESTINATION, bridge('BASE', 'ARBITRUM', ROOT, BRIDGE_DESTINATION, 'destination'))
          ]
        };
      }
    };
    const service = new WalletInvestigationService(prisma, { walletScanner, bridgeScanner });

    const result = await service.investigate(ROOT, { refresh: true, maxDepth: 4 });
    const loaded = await service.getOrInvestigate(ROOT, { maxDepth: 4 });

    expect(result).toMatchObject({ addressKind: 'evm', maxDepth: 4, status: 'completed' });
    expect(new Set(result.coverage.map((row) => row.chain))).toEqual(new Set(['ARBITRUM', 'BASE', 'BSC', 'ETHEREUM']));
    expect(result.paths.some((path) => path.routeType === 'direct' && path.destinationAddress === DIRECT)).toBe(true);
    expect(result.paths.some((path) => path.routeType === 'multi_hop' && path.destinationAddress === MULTIHOP && path.hops.length === 2)).toBe(true);
    expect(result.paths.some((path) => path.routeType === 'bridge' && path.destinationAddress === BRIDGE_DESTINATION && path.evidenceTier === 'exact_bridge_protocol_match')).toBe(true);
    expect(result.deployments.map((row) => row.tokenAddress)).toEqual(expect.arrayContaining(TOKENS));
    expect(result.deployments.every((row) => row.capitalRoute.length >= 2)).toBe(true);
    expect(result.members.filter((row) => row.address !== ROOT).every((row) => row.observationOnly)).toBe(true);
    expect(result.members.every((row) => row.intelligence && Number.isFinite(row.intelligence.evidenceScore) && Number.isFinite(row.intelligence.historicalAlphaScore) && Number.isFinite(row.intelligence.wakeUpPotential))).toBe(true);
    expect(result.members.filter((row) => row.intelligence?.tier === 'S' || row.intelligence?.tier === 'A').every((row) => (row.intelligence?.independentSignalCount ?? 0) >= 2 || row.role === 'root_main')).toBe(true);
    expect(result.deployments.every((row) => row.intelligence && row.intelligence.importanceScore >= 0)).toBe(true);
    expect(result.members).toContainEqual(expect.objectContaining({ address: BRIDGE_CONTRACT, role: 'service_router_node', relationshipConfidence: 0 }));
    expect(result.counts).toMatchObject({ directReceivers: 1, multiHopWallets: 1, bridgeDestinations: 1, tokenDeployments: 3, possibleLinks: 0 });
    expect(loaded.id).toBe(result.id);
    expect(loaded.completedAt).toBe(result.completedAt);
    expect(walletScanner.scanAddress).toHaveBeenCalled();
    expect(await prisma.walletInvestigationPath.count({ where: { investigationId: result.id } })).toBe(result.paths.length);
    expect(await prisma.walletInvestigationDeployment.count({ where: { investigationId: result.id } })).toBe(3);
  }, 60_000);
});

function scanner() {
  const scans = new Map<string, MassTransactionEvent[]>([
    [`BASE:${ROOT}`, [
      event('direct-1', 'BASE', ROOT, DIRECT, 1),
      event('direct-2', 'BASE', ROOT, DIRECT, 2)
    ]],
    [`BASE:${DIRECT}`, [
      event('multi-hop', 'BASE', DIRECT, MULTIHOP, 3),
      event('direct-buy', 'BASE', DIRECT, TOKENS[0], 6, 'token_buy', TOKENS[0], DIRECT)
    ]],
    [`BASE:${MULTIHOP}`, [event('multi-hop-buy', 'BASE', MULTIHOP, TOKENS[1], 7, 'token_buy', TOKENS[1], MULTIHOP)]],
    [`ARBITRUM:${BRIDGE_DESTINATION}`, [event('bridge-buy', 'ARBITRUM', BRIDGE_DESTINATION, TOKENS[2], 8, 'token_buy', TOKENS[2], BRIDGE_DESTINATION)]]
  ]);
  const scanAddress = vi.fn(async (chain: MassTransactionEvent['chain'], address: string) => ({
    events: scans.get(`${chain}:${address}`) ?? [],
    infrastructure: chain === 'BASE' && address === ROOT ? [{ chain: 'BASE' as const, address: BRIDGE_CONTRACT, category: 'BRIDGE' as const, label: 'test bridge router' }] : [],
    provider: 'wallet-investigation-test',
    pagesFetched: 1, complete: true, warnings: []
  }));
  return { scanAddress } satisfies WalletCapitalScanProvider;
}

function bridge(sourceChain: 'BASE', destinationChain: 'ARBITRUM', sender: string, recipient: string, leg: 'source' | 'destination') {
  return {
    protocol: 'test-official-bridge', officialMessageId: `${PREFIX}:official-message`, sourceChain, destinationChain,
    sourceTxHash: `${PREFIX}:bridge-source:tx`, destinationTxHash: `${PREFIX}:bridge-destination:tx`, sender, recipient,
    verifiedBy: 'protocol_message' as const, protocolCompleted: true, sourceFinality: 'finalized' as const,
    leg
  };
}

function event(
  id: string,
  chain: MassTransactionEvent['chain'],
  from: string,
  to: string,
  seconds: number,
  kind: MassTransactionEvent['kind'] = 'native_transfer',
  assetAddress: string | null = null,
  actor: string | null = from,
  bridgeMessage: MassTransactionEvent['bridge'] = null
): MassTransactionEvent {
  return {
    eventId: `${PREFIX}:${id}`, chain, txHash: `${PREFIX}:${id}:tx`, eventIndex: 0, blockOrSlot: BigInt(seconds),
    ts: new Date(BASE.getTime() + seconds * 1_000), kind, status: 'succeeded', from, to, actor,
    asset: { address: assetAddress, symbol: assetAddress ? `T${seconds}` : chain === 'ARBITRUM' ? 'ETH' : 'ETH', decimals: 18, amount: '1', amountUsd: 1_000 },
    programOrContract: kind.startsWith('bridge_') ? BRIDGE_CONTRACT : null, provider: 'wallet-investigation-test',
    observedAt: new Date(BASE.getTime() + seconds * 1_000), bridge: bridgeMessage, metadata: { testPrefix: PREFIX }
  };
}
