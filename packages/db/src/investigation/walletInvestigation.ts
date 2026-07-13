import { Prisma, type AddressCategory, type ChainId, type PrismaClient } from '@prisma/client';
import type { InfrastructureCategory, MassTransactionEvent } from '@flowradar/core';
import type { WalletBridgeScanProvider, WalletCapitalScanProvider } from '@flowradar/providers';
import { normalizeAddress, validAddress } from '../discovery/unified';
import { expandWalletCapitalGraph } from '../intelligence/walletFlows';
import { enrollObservationWallet } from '../intelligence/monitoring';
import { createMassTrackerSession } from '../tracker/massTracker';
import type {
  InvestigationChainCoverage, InvestigationCoverageStatus, InvestigationDeployment, InvestigationHop,
  InvestigationMember, InvestigationPath, InvestigationRouteType, WalletInvestigationResult
} from './types';

export const WALLET_INVESTIGATION_ENGINE_VERSION = 1;
const EVM_CHAINS: ChainId[] = ['ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'];
const ALL_CHAINS: ChainId[] = ['SOLANA', ...EVM_CHAINS];

export interface WalletInvestigationServiceOptions {
  walletScanner?: WalletCapitalScanProvider;
  bridgeScanner?: WalletBridgeScanProvider;
}

interface ScanReceipt {
  chain: ChainId;
  address: string;
  depth: number;
  provider: string;
  pages: number;
  complete: boolean;
  events: number;
  warnings: string[];
}

interface InfrastructureReceipt {
  chain: ChainId;
  address: string;
  parentChain: ChainId;
  parentAddress: string;
  category: string;
  label: string;
}

export class WalletInvestigationService {
  constructor(private readonly prisma: PrismaClient, private readonly options: WalletInvestigationServiceOptions = {}) {}

  async investigate(addressInput: string, options: { refresh?: boolean; maxDepth?: number } = {}): Promise<WalletInvestigationResult> {
    const refs = detectAddressRefs(addressInput);
    if (!refs.length) throw new Error('Wallet adresa nije validna');
    const rootAddress = refs[0].address;
    const addressKind = refs[0].chain === 'SOLANA' ? 'solana' : 'evm';
    const investigationKey = `${addressKind}:${rootAddress}`;
    const maxDepth = Math.max(1, Math.min(Math.trunc(options.maxDepth ?? 4), 4));
    const existing = await this.loadRecord({ investigationKey });
    if (existing && !options.refresh && existing.status === 'completed' && existing.maxDepth >= maxDepth) return mapRecord(existing);
    if (!this.options.walletScanner) throw new Error('Real wallet investigation scanner nije konfigurisan');

    const startedAt = new Date();
    const investigation = await this.prisma.walletInvestigation.upsert({
      where: { investigationKey },
      create: {
        investigationKey, rootAddress, addressKind, maxDepth, status: 'running', coverageStatus: 'unavailable',
        summaryJson: json({}), providerReceiptsJson: json({}), startedAt, lastRefreshAt: options.refresh ? startedAt : null,
        engineVersion: WALLET_INVESTIGATION_ENGINE_VERSION
      },
      update: {
        rootAddress, addressKind, maxDepth, status: 'running', startedAt, completedAt: null, lastError: null,
        ...(options.refresh ? { lastRefreshAt: startedAt } : {}), engineVersion: WALLET_INVESTIGATION_ENGINE_VERSION
      }
    });

    try {
      const scan = await this.scanAndBackfill(refs, maxDepth, investigation.id, startedAt);
      const projected = await this.project(refs, maxDepth, scan.receipts, scan.infrastructure, scan.bridgeReceipt, startedAt);
      const completedAt = new Date();
      const coverageStatus = aggregateCoverage(projected.coverage);
      const summary = buildSummary(projected.paths, projected.members, projected.deployments);
      const providerReceipts = {
        wallet: scan.receipts,
        bridge: scan.bridgeReceipt,
        tracker: { ...scan.metrics, peakHeapBytes: String(scan.metrics.peakHeapBytes) },
        expansions: scan.expansions
      };
      await this.prisma.$transaction(async (tx) => {
        await Promise.all([
          tx.walletInvestigationChainCoverage.deleteMany({ where: { investigationId: investigation.id } }),
          tx.walletInvestigationPath.deleteMany({ where: { investigationId: investigation.id } }),
          tx.walletInvestigationMember.deleteMany({ where: { investigationId: investigation.id } }),
          tx.walletInvestigationDeployment.deleteMany({ where: { investigationId: investigation.id } })
        ]);
        if (projected.coverage.length) await tx.walletInvestigationChainCoverage.createMany({ data: projected.coverage.map((row) => ({
          investigationId: investigation.id, chain: row.chain, activityFound: row.activityFound,
          firstActivityAt: row.firstActivityAt ? new Date(row.firstActivityAt) : null,
          lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt) : null,
          eventsScanned: row.eventsScanned, coverageStatus: row.coverageStatus, provider: row.provider,
          warnings: row.warnings, receiptsJson: json(scan.receipts.filter((receipt) => receipt.chain === row.chain))
        })) });
        if (projected.paths.length) await tx.walletInvestigationPath.createMany({ data: projected.paths.map((row) => ({
          investigationId: investigation.id, pathKey: row.id, routeType: row.routeType,
          sourceChain: row.sourceChain, sourceAddress: row.sourceAddress, destinationChain: row.destinationChain,
          destinationAddress: row.destinationAddress, assetAddress: row.assetAddress, assetSymbol: row.assetSymbol,
          amountToken: row.amountToken, amountUsd: row.amountUsd, valueStatus: row.valueStatus,
          eventTs: new Date(row.eventTs), txHash: row.txHash, protocol: row.protocol, evidenceTier: row.evidenceTier,
          confidence: row.confidence, hopCount: row.hops.length, hopsJson: json(row.hops),
          supportingEvidenceJson: json(row.supportingEvidence), contradictingEvidenceJson: json(row.contradictingEvidence)
        })) });
        if (projected.members.length) await tx.walletInvestigationMember.createMany({ data: projected.members.map((row) => ({
          investigationId: investigation.id, chain: row.chain, address: row.address, role: row.role,
          parentChain: row.parentChain, parentAddress: row.parentAddress, entityKey: row.entityKey,
          relationshipConfidence: row.relationshipConfidence, evidenceTier: row.evidenceTier,
          supportingEvidenceJson: json({ source: 'wallet_investigation_projection' }), contradictingEvidenceJson: json({}),
          firstLinkedAt: new Date(row.firstLinkedAt), lastLinkedAt: new Date(row.lastLinkedAt), observationOnly: true
        })) });
        if (projected.deployments.length) await tx.walletInvestigationDeployment.createMany({ data: projected.deployments.map((row) => ({
          investigationId: investigation.id, deploymentKey: row.id, chain: row.chain, buyerAddress: row.buyerAddress,
          tokenAddress: row.tokenAddress, tokenSymbol: row.tokenSymbol, buyTs: new Date(row.buyTs), buyTxHash: row.buyTxHash,
          amountToken: row.amountToken, amountUsd: row.amountUsd, entryMarketCapUsd: row.entryMarketCapUsd,
          fundingToBuyDelaySec: row.fundingToBuyDelaySec, sourceEntityKey: row.sourceEntityKey,
          capitalRouteJson: json(row.capitalRoute), holdingStatus: row.holdingStatus, evidenceTier: row.evidenceTier
        })) });
        await tx.walletInvestigation.update({
          where: { id: investigation.id },
          data: {
            status: 'completed', entityKey: projected.entityKey, coverageStatus, summaryJson: json(summary),
            providerReceiptsJson: json(providerReceipts), completedAt, lastError: null,
            engineVersion: WALLET_INVESTIGATION_ENGINE_VERSION
          }
        });
      }, { timeout: 120_000 });
      return (await this.loadById(investigation.id))!;
    } catch (error) {
      await this.prisma.walletInvestigation.update({
        where: { id: investigation.id }, data: { status: 'failed', completedAt: new Date(), lastError: errorMessage(error) }
      });
      throw error;
    }
  }

  async load(targetInput: string): Promise<WalletInvestigationResult | null> {
    const refs = detectAddressRefs(targetInput);
    if (refs.length) return this.loadByKey(`${refs[0].chain === 'SOLANA' ? 'solana' : 'evm'}:${refs[0].address}`);
    const trimmed = targetInput.trim();
    const record = await this.loadRecord({ OR: [{ id: trimmed }, { entityKey: trimmed }, { investigationKey: trimmed }] });
    return record ? mapRecord(record) : null;
  }

  async getOrInvestigate(targetInput: string, options: { refresh?: boolean; maxDepth?: number } = {}) {
    const loaded = !options.refresh ? await this.load(targetInput) : null;
    if (loaded?.status === 'completed') return loaded;
    return this.investigate(targetInput, options);
  }

  private async loadByKey(investigationKey: string) {
    const record = await this.loadRecord({ investigationKey });
    return record ? mapRecord(record) : null;
  }

  private async loadById(id: string) {
    const record = await this.loadRecord({ id });
    return record ? mapRecord(record) : null;
  }

  private loadRecord(where: Prisma.WalletInvestigationWhereInput) {
    return this.prisma.walletInvestigation.findFirst({
      where,
      include: {
        chains: { orderBy: { chain: 'asc' } },
        paths: { orderBy: [{ eventTs: 'asc' }, { pathKey: 'asc' }] },
        members: { orderBy: [{ relationshipConfidence: 'desc' }, { chain: 'asc' }, { address: 'asc' }] },
        deployments: { orderBy: [{ buyTs: 'asc' }, { deploymentKey: 'asc' }] }
      }
    });
  }

  private async scanAndBackfill(refs: Array<{ chain: ChainId; address: string }>, maxDepth: number, investigationId: string, now: Date) {
    const scanner = this.options.walletScanner!;
    for (const ref of refs) await enrollObservationWallet(this.prisma, { chain: ref.chain, address: ref.address, role: 'root_main', reason: `wallet_investigation:${investigationId}`, now });
    const tracker = await createMassTrackerSession(this.prisma, { enrollReceivers: false, metadata: { workflow: 'wallet_investigation', investigationId, maxDepth } });
    const queue = refs.map((ref) => ({ ...ref, depth: 0, since: undefined as Date | undefined }));
    const visited = new Set(queue.map((node) => `${node.chain}:${node.address}`));
    const infrastructure = new Map<string, InfrastructureReceipt>();
    const receipts: ScanReceipt[] = [];
    let bridgeReceipt: { provider: string; pages: number; complete: boolean; events: number; warnings: string[] } | null = null;
    try {
      let explored = 0;
      while (queue.length && explored < 16) {
        const node = queue.shift()!;
        explored += 1;
        let scan;
        try {
          scan = await scanner.scanAddress(node.chain, node.address, { root: node.depth === 0, maxPages: node.depth === 0 ? 30 : 3, since: node.since });
        } catch (error) {
          tracker.recordProviderError();
          receipts.push({ chain: node.chain, address: node.address, depth: node.depth, provider: 'unavailable', pages: 0, complete: false, events: 0, warnings: [errorMessage(error)] });
          continue;
        }
        for (const item of scan.infrastructure) {
          infrastructure.set(`${item.chain}:${item.address}`, { chain: item.chain as ChainId, address: item.address, parentChain: node.chain, parentAddress: node.address, category: item.category, label: item.label });
          await this.prisma.addressRegistry.upsert({
            where: { chain_address: { chain: item.chain as ChainId, address: item.address } },
            create: { chain: item.chain as ChainId, address: item.address, category: registryCategory(item.category), label: item.label, source: scan.provider, doNotExpand: true },
            update: { category: registryCategory(item.category), label: item.label, source: scan.provider, doNotExpand: true }
          });
        }
        const events = scan.events.map((event) => ({ ...event, observedAt: event.ts, metadata: { ...event.metadata, walletInvestigationHistoricalBackfill: investigationId } }));
        await persistObservedTokens(this.prisma, events);
        for (const batch of chunks(events, 500)) await tracker.ingest(batch);
        receipts.push({ chain: node.chain, address: node.address, depth: node.depth, provider: scan.provider, pages: scan.pagesFetched, complete: scan.complete, events: events.length, warnings: scan.warnings });
        if (node.depth + 1 >= maxDepth) continue;
        const candidates = new Map<string, { chain: ChainId; address: string; score: number; transfers: number; lastTs: number }>();
        for (const event of events) {
          if (event.from !== node.address || event.kind !== 'native_transfer' || event.to === node.address || !validAddress(node.chain, event.to)) continue;
          if (infrastructure.has(`${node.chain}:${event.to}`)) continue;
          const key = `${node.chain}:${event.to}`;
          const current = candidates.get(key) ?? { chain: node.chain, address: event.to, score: 0, transfers: 0, lastTs: 0 };
          current.score += Math.log10(1 + (event.asset.amountUsd ?? Math.max(0, Number(event.asset.amount)))) + 1;
          current.transfers += 1;
          current.lastTs = Math.max(current.lastTs, event.ts.getTime());
          candidates.set(key, current);
        }
        for (const candidate of [...candidates.values()].sort((a, b) => b.transfers - a.transfers || b.lastTs - a.lastTs || b.score - a.score || a.address.localeCompare(b.address)).slice(0, 4)) {
          const key = `${candidate.chain}:${candidate.address}`;
          if (visited.has(key)) continue;
          visited.add(key);
          queue.push({ chain: candidate.chain, address: candidate.address, depth: node.depth + 1, since: undefined });
        }
      }

      if (this.options.bridgeScanner) {
        try {
          const bridge = await this.options.bridgeScanner.scanWallets([...visited].map(parseRefKey), { maxPages: 3, observedAt: now });
          const events = bridge.events.map((event) => ({ ...event, observedAt: event.ts, metadata: { ...event.metadata, walletInvestigationHistoricalBackfill: investigationId } }));
          for (const batch of chunks(events, 500)) await tracker.ingest(batch);
          bridgeReceipt = { provider: bridge.provider, pages: bridge.pagesFetched, complete: bridge.complete, events: events.length, warnings: bridge.warnings };

          if (events.length) {
            const sourceIds = events.filter((event) => event.kind === 'bridge_source' && visited.has(`${event.chain}:${event.actor ?? event.from}`)).map((event) => event.eventId);
            const correlations = sourceIds.length ? await this.prisma.massBridgeCorrelation.findMany({ where: { sourceEventId: { in: sourceIds }, status: 'verified' }, take: 100 }) : [];
            const destinations = correlations.length ? await this.prisma.massTransactionEvent.findMany({ where: { eventId: { in: correlations.map((row) => row.destinationEventId) } } }) : [];
            for (const destination of destinations.slice(0, 8)) {
              const recipient = destination.actorAddress ?? destination.toAddress;
              if (!validAddress(destination.chain, recipient) || visited.has(`${destination.chain}:${recipient}`)) continue;
              visited.add(`${destination.chain}:${recipient}`);
              try {
                const continued = await scanner.scanAddress(destination.chain, recipient, { root: false, maxPages: 4, since: destination.ts });
                const continuationEvents = continued.events.map((event) => ({ ...event, observedAt: event.ts, metadata: { ...event.metadata, bridgeDestinationContinuation: destination.eventId, walletInvestigationHistoricalBackfill: investigationId } }));
                await persistObservedTokens(this.prisma, continuationEvents);
                for (const batch of chunks(continuationEvents, 500)) await tracker.ingest(batch);
                receipts.push({ chain: destination.chain, address: recipient, depth: 1, provider: continued.provider, pages: continued.pagesFetched, complete: continued.complete, events: continuationEvents.length, warnings: continued.warnings });
              } catch (error) {
                tracker.recordProviderError();
                receipts.push({ chain: destination.chain, address: recipient, depth: 1, provider: 'unavailable', pages: 0, complete: false, events: 0, warnings: [`bridge destination continuation: ${errorMessage(error)}`] });
              }
            }
          }
        } catch (error) {
          tracker.recordProviderError();
          bridgeReceipt = { provider: 'WormholeScan', pages: 0, complete: false, events: 0, warnings: [errorMessage(error)] };
        }
      }

      const metrics = await tracker.complete();
      const expansions = [];
      for (const ref of refs) expansions.push(await expandWalletCapitalGraph(this.prisma, { chain: ref.chain, walletAddress: ref.address, maxDepth, maxNodes: 500, maxEventsPerNode: 2_000, now }));
      return { receipts, infrastructure: [...infrastructure.values()], bridgeReceipt, metrics, expansions };
    } catch (error) {
      await tracker.fail(error);
      throw error;
    }
  }

  private async project(refs: Array<{ chain: ChainId; address: string }>, maxDepth: number, receipts: ScanReceipt[], infrastructure: InfrastructureReceipt[], bridgeReceipt: unknown, now: Date) {
    void maxDepth; void bridgeReceipt;
    const relationships = await this.prisma.walletFlowRelationship.findMany({
      where: { OR: refs.map((ref) => ({ sourceChain: ref.chain, sourceWallet: ref.address })) },
      orderBy: [{ relationshipConfidence: 'desc' }, { firstTransferTs: 'asc' }], take: 500
    });
    const receiptIds = unique(relationships.flatMap((row) => row.transferReceiptIds));
    const receiptEvents = receiptIds.length ? await this.prisma.massTransactionEvent.findMany({ where: { eventId: { in: receiptIds } }, orderBy: [{ ts: 'asc' }, { eventId: 'asc' }] }) : [];
    const eventById = new Map(receiptEvents.map((event) => [event.eventId, event]));
    const sourceEntity = await this.prisma.unifiedEntityAddress.findFirst({ where: { OR: refs.map((ref) => ({ chain: ref.chain, address: ref.address })) }, include: { entity: { select: { entityKey: true } } } });
    const entityRows = await this.prisma.unifiedEntityAddress.findMany({
      where: { OR: uniqueRefs([...refs, ...relationships.map((row) => ({ chain: row.relatedChain, address: row.relatedWallet }))]).map((ref) => ({ chain: ref.chain, address: ref.address })) },
      include: { entity: { select: { entityKey: true } } }, take: 2_000
    });
    const entityOf = new Map(entityRows.map((row) => [`${row.chain}:${row.address}`, row.entity.entityKey]));
    const members = new Map<string, InvestigationMember>();
    for (const ref of refs) members.set(`${ref.chain}:${ref.address}`, {
      chain: ref.chain, address: ref.address, role: 'root_main', parentChain: null, parentAddress: null,
      entityKey: entityOf.get(`${ref.chain}:${ref.address}`) ?? null, relationshipConfidence: 1,
      evidenceTier: 'investigation_root', firstLinkedAt: now.toISOString(), lastLinkedAt: now.toISOString(), observationOnly: true
    });
    for (const row of relationships) {
      const support = objectJson(row.supportingEvidenceJson);
      const representative = stringArray(support?.representativePathEventIds).map((id) => eventById.get(id)).filter(nonNull);
      const lastHop = representative.at(-1);
      const member: InvestigationMember = {
        chain: row.relatedChain, address: row.relatedWallet, role: investigationRole(row.role, row.route),
        parentChain: lastHop?.chain ?? row.sourceChain, parentAddress: lastHop?.fromAddress ?? row.sourceWallet,
        entityKey: entityOf.get(`${row.relatedChain}:${row.relatedWallet}`) ?? row.relatedEntityKey,
        relationshipConfidence: normalizeConfidence(row.relationshipConfidence), evidenceTier: relationshipEvidence(row.route, row.safeEntityLink),
        firstLinkedAt: row.firstTransferTs.toISOString(), lastLinkedAt: row.lastTransferTs.toISOString(), observationOnly: true
      };
      mergeMember(members, member);
    }
    for (const item of infrastructure) mergeMember(members, {
      chain: item.chain, address: item.address, role: item.category === 'CEX' ? 'possible_cex_linked' : 'service_router_node',
      parentChain: item.parentChain, parentAddress: item.parentAddress, entityKey: null, relationshipConfidence: 0,
      evidenceTier: 'infrastructure_terminal_no_merge', firstLinkedAt: now.toISOString(), lastLinkedAt: now.toISOString(), observationOnly: true
    });

    const paths: InvestigationPath[] = [];
    for (const row of relationships) {
      const support = objectJson(row.supportingEvidenceJson);
      const representative = stringArray(support?.representativePathEventIds).map((id) => eventById.get(id)).filter(nonNull);
      if (row.route === 'direct_transfer') {
        const directEvents = row.transferReceiptIds.map((id) => eventById.get(id)).filter(nonNull).filter((event) => event.chain === row.sourceChain && event.fromAddress === row.sourceWallet && event.toAddress === row.relatedWallet);
        for (const event of directEvents) paths.push(pathFromEvents(`direct:${event.eventId}`, 'direct', [event], relationshipEvidence(row.route, row.safeEntityLink), normalizeConfidence(row.relationshipConfidence), row.supportingEvidenceJson, row.contradictingEvidenceJson));
      } else if (representative.length) {
        const routeType: InvestigationRouteType = row.route === 'cex_correlation' ? 'possible_cex' : row.route === 'exact_bridge' || row.route === 'bridge_inference' ? 'bridge' : 'multi_hop';
        paths.push(pathFromEvents(`${routeType}:${row.id}`, routeType, representative, relationshipEvidence(row.route, row.safeEntityLink), normalizeConfidence(row.relationshipConfidence), row.supportingEvidenceJson, row.contradictingEvidenceJson));
      }
    }

    const memberRows = [...members.values()];
    const relatedRefs = memberRows.filter((member) => member.role !== 'root_main' && member.role !== 'service_router_node' && member.role !== 'possible_cex_linked').map((member) => ({ chain: member.chain, address: member.address }));
    const buys = relatedRefs.length ? await this.prisma.massTransactionEvent.findMany({
      where: { kind: 'token_buy', assetAddress: { not: null }, OR: relatedRefs.flatMap((ref) => [{ chain: ref.chain, actorAddress: ref.address }, { chain: ref.chain, fromAddress: ref.address }]) },
      orderBy: [{ ts: 'asc' }, { eventId: 'asc' }], take: 10_000
    }) : [];
    const relationByMember = new Map(relationships.map((row) => [`${row.relatedChain}:${row.relatedWallet}`, row]));
    const validBuys = buys.filter((buy) => {
      const buyer = buy.actorAddress ?? buy.fromAddress;
      const relation = relationByMember.get(`${buy.chain}:${buyer}`);
      return Boolean(relation && buy.ts >= relation.firstTransferTs && buy.txHash && buy.assetAddress);
    });
    const tradeRows = validBuys.length ? await this.prisma.walletTokenTrade.findMany({ where: { chain: { in: unique(validBuys.map((buy) => buy.chain)) }, txHash: { in: unique(validBuys.map((buy) => buy.txHash)) } }, select: { chain: true, txHash: true, marketCapAtTrade: true } }) : [];
    const marketCapByTx = new Map(tradeRows.map((trade) => [`${trade.chain}:${trade.txHash}`, decimal(trade.marketCapAtTrade)]));
    const laterEvents = validBuys.length ? await this.prisma.massTransactionEvent.findMany({
      where: { kind: { in: ['token_sell', 'token_transfer'] }, assetAddress: { in: unique(validBuys.map((buy) => buy.assetAddress!).filter(Boolean)) }, fromAddress: { in: unique(validBuys.map((buy) => buy.actorAddress ?? buy.fromAddress)) } },
      orderBy: { ts: 'asc' }, take: 20_000
    }) : [];
    const deployments: InvestigationDeployment[] = [];
    for (const buy of validBuys) {
      const buyer = buy.actorAddress ?? buy.fromAddress;
      const relation = relationByMember.get(`${buy.chain}:${buyer}`)!;
      const support = objectJson(relation.supportingEvidenceJson);
      const capitalEvents = stringArray(support?.representativePathEventIds).map((id) => eventById.get(id)).filter(nonNull).filter((event) => event.ts <= buy.ts);
      const funding = capitalEvents.slice().sort((a, b) => b.ts.getTime() - a.ts.getTime())[0];
      const holdingStatus = laterEvents.some((event) => event.chain === buy.chain && event.fromAddress === buyer && event.assetAddress === buy.assetAddress && event.ts > buy.ts) ? 'sold_or_transferred' : 'holding_or_unresolved';
      const capitalRoute = capitalEvents.map((event) => hopFromEvent(event, event.kind.startsWith('bridge_') ? 'bridge' : capitalEvents.length === 1 ? 'direct' : 'multi_hop', relationshipEvidence(relation.route, relation.safeEntityLink), normalizeConfidence(relation.relationshipConfidence)));
      capitalRoute.push(hopFromEvent(buy, 'token_deployment', 'transaction_verified_buy_after_funding', 0.9));
      const deployment: InvestigationDeployment = {
        id: `deployment:${buy.eventId}`, chain: buy.chain, buyerAddress: buyer, tokenAddress: buy.assetAddress!,
        tokenSymbol: buy.assetSymbol, buyTs: buy.ts.toISOString(), buyTxHash: buy.txHash,
        amountToken: buy.amountToken, amountUsd: decimal(buy.amountUsd), entryMarketCapUsd: marketCapByTx.get(`${buy.chain}:${buy.txHash}`) ?? null,
        fundingToBuyDelaySec: funding ? Math.max(0, Math.round((buy.ts.getTime() - funding.ts.getTime()) / 1_000)) : null,
        sourceEntityKey: sourceEntity?.entity.entityKey ?? relation.sourceEntityKey, capitalRoute,
        holdingStatus, evidenceTier: 'transaction_verified_buy_after_funding'
      };
      deployments.push(deployment);
      paths.push(pathFromDeployment(deployment));
    }

    const profitCollectors = relationships.filter((row) => row.role === 'profit_collection_wallet');
    if (profitCollectors.length) {
      const profitEvents = await this.prisma.massTransactionEvent.findMany({
        where: { OR: profitCollectors.flatMap((row) => refs.filter((ref) => ref.chain === row.relatedChain).map((root) => ({ chain: row.relatedChain, fromAddress: row.relatedWallet, toAddress: root.address, ts: { gte: row.firstTransferTs } }))), kind: { in: ['native_transfer', 'token_transfer'] } },
        orderBy: [{ ts: 'asc' }, { eventId: 'asc' }], take: 5_000
      });
      for (const event of profitEvents) paths.push(pathFromEvents(`profit:${event.eventId}`, 'profit_return', [event], 'exact_profit_return_transfer', 0.85, { role: 'profit_collection_wallet' }, {}));
    }

    const coverage: InvestigationChainCoverage[] = [];
    for (const ref of refs) {
      const rootReceipts = receipts.filter((receipt) => receipt.chain === ref.chain && receipt.address === ref.address && receipt.depth === 0);
      const bounds = await this.prisma.massTransactionEvent.aggregate({
        where: { chain: ref.chain, OR: [{ fromAddress: ref.address }, { toAddress: ref.address }, { actorAddress: ref.address }] },
        _min: { ts: true }, _max: { ts: true }, _count: { _all: true }
      });
      const unavailable = rootReceipts.some((receipt) => receipt.provider === 'unavailable');
      const complete = rootReceipts.length > 0 && rootReceipts.every((receipt) => receipt.complete);
      coverage.push({
        chain: ref.chain, activityFound: bounds._count._all > 0,
        firstActivityAt: bounds._min.ts?.toISOString() ?? null, lastActivityAt: bounds._max.ts?.toISOString() ?? null,
        eventsScanned: rootReceipts.reduce((sum, receipt) => sum + receipt.events, 0),
        coverageStatus: unavailable ? 'retryable' : complete ? 'complete' : rootReceipts.length ? 'partial' : 'unavailable',
        provider: rootReceipts.map((receipt) => receipt.provider).filter((value, index, all) => all.indexOf(value) === index).join('+') || null,
        warnings: unique(rootReceipts.flatMap((receipt) => receipt.warnings))
      });
    }
    return { coverage, paths: dedupeBy(paths, (path) => path.id), members: memberRows, deployments: dedupeBy(deployments, (row) => row.id), entityKey: sourceEntity?.entity.entityKey ?? null };
  }
}

function detectAddressRefs(input: string) {
  const value = input.trim();
  const chains = /^0x[0-9a-fA-F]{40}$/.test(value) ? EVM_CHAINS : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? ['SOLANA' as ChainId] : [];
  return chains.filter((chain) => validAddress(chain, value)).map((chain) => ({ chain, address: normalizeAddress(chain, value) }));
}
function parseRefKey(value: string) { const index = value.indexOf(':'); return { chain: value.slice(0, index) as ChainId, address: value.slice(index + 1) }; }
function registryCategory(category: InfrastructureCategory): AddressCategory { if (category === 'PROGRAM' || category === 'SYSTEM') return 'ROUTER'; if (category === 'BURN') return 'TOKEN_CONTRACT'; return category as AddressCategory; }
function relationshipEvidence(route: string, safe: boolean) { return route === 'exact_bridge' ? 'exact_bridge_protocol_match' : route === 'bridge_inference' ? 'bridge_inference' : route === 'cex_correlation' ? 'possible_cex_mediated' : route === 'direct_transfer' ? safe ? 'repeated_direct_funding' : 'exact_direct_transfer' : safe ? 'repeated_multi_hop_relationship' : 'insufficient_evidence'; }
function investigationRole(role: string, route: string) { if (route === 'cex_correlation') return 'possible_cex_linked'; if (route === 'exact_bridge') return 'bridge_destination'; if (role === 'profit_collection_wallet') return 'profit_collector'; if (role === 'probable_side_wallet' || role === 'probable_linked_wallet') return 'probable_side_alt_wallet'; return role; }
function mergeMember(map: Map<string, InvestigationMember>, incoming: InvestigationMember) { const key = `${incoming.chain}:${incoming.address}`; const current = map.get(key); if (!current || incoming.relationshipConfidence > current.relationshipConfidence) map.set(key, incoming); else { current.firstLinkedAt = current.firstLinkedAt < incoming.firstLinkedAt ? current.firstLinkedAt : incoming.firstLinkedAt; current.lastLinkedAt = current.lastLinkedAt > incoming.lastLinkedAt ? current.lastLinkedAt : incoming.lastLinkedAt; } }
function pathFromEvents(id: string, routeType: InvestigationRouteType, events: Array<ReturnType<typeof persistedEventShape>>, evidenceTier: string, confidence: number, supporting: unknown, contradicting: unknown): InvestigationPath {
  const first = events[0]; const last = events.at(-1)!;
  return { id, routeType, sourceChain: first.chain, sourceAddress: first.fromAddress, destinationChain: last.chain, destinationAddress: last.toAddress, assetAddress: last.assetAddress, assetSymbol: last.assetSymbol, amountToken: last.amountToken, amountUsd: decimal(last.amountUsd), valueStatus: last.amountUsd == null ? 'unpriced' : 'usd_verified', eventTs: first.ts.toISOString(), txHash: first.txHash, protocol: events.find((event) => event.bridgeProtocol)?.bridgeProtocol ?? null, evidenceTier, confidence, hops: events.map((event) => hopFromEvent(event, routeType, evidenceTier, confidence)), supportingEvidence: supporting, contradictingEvidence: contradicting };
}
function persistedEventShape(event: Awaited<ReturnType<PrismaClient['massTransactionEvent']['findFirst']>>) { if (!event) throw new Error('event is required'); return event; }
function hopFromEvent(event: ReturnType<typeof persistedEventShape>, routeType: InvestigationRouteType, evidenceTier: string, confidence: number): InvestigationHop { return { sourceChain: event.chain, sourceAddress: event.fromAddress, destinationChain: bridgeDestinationChain(event.bridgeJson) ?? event.chain, destinationAddress: event.toAddress, assetAddress: event.assetAddress, assetSymbol: event.assetSymbol, amountToken: event.amountToken, amountUsd: decimal(event.amountUsd), valueStatus: event.amountUsd == null ? 'unpriced' : 'usd_verified', timestamp: event.ts.toISOString(), txHash: event.txHash, routeType, protocol: event.bridgeProtocol, evidenceTier, confidence }; }
function pathFromDeployment(row: InvestigationDeployment): InvestigationPath { const buy = row.capitalRoute.at(-1)!; return { id: row.id, routeType: 'token_deployment', sourceChain: row.chain, sourceAddress: row.buyerAddress, destinationChain: row.chain, destinationAddress: row.tokenAddress, assetAddress: row.tokenAddress, assetSymbol: row.tokenSymbol, amountToken: row.amountToken, amountUsd: row.amountUsd, valueStatus: row.amountUsd == null ? 'unpriced' : 'usd_verified', eventTs: row.buyTs, txHash: row.buyTxHash, protocol: null, evidenceTier: row.evidenceTier, confidence: 0.9, hops: row.capitalRoute, supportingEvidence: { fundingToBuyDelaySec: row.fundingToBuyDelaySec, sourceEntityKey: row.sourceEntityKey }, contradictingEvidence: {} }; }
function bridgeDestinationChain(value: Prisma.JsonValue | null): ChainId | null { const object = objectJson(value); const chain = object?.destinationChain; return typeof chain === 'string' && ALL_CHAINS.includes(chain as ChainId) ? chain as ChainId : null; }
async function persistObservedTokens(prisma: PrismaClient, events: readonly MassTransactionEvent[]) { const buys = new Map<string, MassTransactionEvent>(); for (const event of events) if (event.kind === 'token_buy' && event.asset.address) buys.set(`${event.chain}:${event.asset.address}`, event); for (const event of buys.values()) { const address = event.asset.address!; const label = event.asset.symbol?.trim() || `${address.slice(0, 6)}…${address.slice(-4)}`; await prisma.token.upsert({ where: { chain_address: { chain: event.chain as ChainId, address } }, create: { chain: event.chain as ChainId, address, symbol: label, name: label, decimals: event.asset.decimals ?? (event.chain === 'SOLANA' ? 9 : 18), firstSeenAt: event.ts, riskFlags: json([]) }, update: event.asset.symbol?.trim() ? { symbol: event.asset.symbol.trim() } : {} }); } }
function buildSummary(paths: InvestigationPath[], members: InvestigationMember[], deployments: InvestigationDeployment[]) { const addresses = (role: RegExp) => new Set(members.filter((member) => role.test(member.role)).map((member) => `${member.chain}:${member.address}`)).size; const clusterMembers = members.filter((member) => member.role !== 'root_main' && member.role !== 'service_router_node'); return { directReceivers: new Set(paths.filter((path) => path.routeType === 'direct').map((path) => `${path.destinationChain}:${path.destinationAddress}`)).size, multiHopWallets: new Set(paths.filter((path) => path.routeType === 'multi_hop').map((path) => `${path.destinationChain}:${path.destinationAddress}`)).size, bridgeDestinations: new Set(paths.filter((path) => path.routeType === 'bridge').map((path) => `${path.destinationChain}:${path.destinationAddress}`)).size, probableAltExecutionWallets: addresses(/execution|side|alt/), profitCollectors: addresses(/profit_collector/), tokenDeployments: deployments.length, possibleCexLinks: paths.filter((path) => path.routeType === 'possible_cex').length, strongLinks: clusterMembers.filter((member) => member.relationshipConfidence >= 0.85).length, probableLinks: clusterMembers.filter((member) => member.relationshipConfidence >= 0.6 && member.relationshipConfidence < 0.85).length, possibleLinks: clusterMembers.filter((member) => member.relationshipConfidence < 0.6).length }; }
function aggregateCoverage(rows: InvestigationChainCoverage[]): InvestigationCoverageStatus { if (!rows.length || rows.every((row) => row.coverageStatus === 'unavailable')) return 'unavailable'; if (rows.some((row) => row.coverageStatus === 'retryable')) return 'retryable'; if (rows.some((row) => row.coverageStatus === 'partial' || row.coverageStatus === 'unavailable')) return 'partial'; return 'complete'; }
type LoadedRecord = Awaited<ReturnType<WalletInvestigationService['loadRecord']>>;
function mapRecord(record: NonNullable<LoadedRecord>): WalletInvestigationResult { const counts = objectJson(record.summaryJson) as unknown as WalletInvestigationResult['counts']; const chainRows = [...record.chains].sort((a, b) => ALL_CHAINS.indexOf(a.chain) - ALL_CHAINS.indexOf(b.chain)); return { id: record.id, investigationKey: record.investigationKey, rootAddress: record.rootAddress, addressKind: record.addressKind as 'solana' | 'evm', maxDepth: record.maxDepth, status: record.status, entityKey: record.entityKey, coverageStatus: record.coverageStatus as InvestigationCoverageStatus, activityChains: chainRows.filter((row) => row.activityFound).map((row) => row.chain), coverage: chainRows.map((row) => ({ chain: row.chain, activityFound: row.activityFound, firstActivityAt: row.firstActivityAt?.toISOString() ?? null, lastActivityAt: row.lastActivityAt?.toISOString() ?? null, eventsScanned: row.eventsScanned, coverageStatus: row.coverageStatus as InvestigationCoverageStatus, provider: row.provider, warnings: row.warnings })), counts, paths: record.paths.map((row) => ({ id: row.pathKey, routeType: row.routeType as InvestigationRouteType, sourceChain: row.sourceChain, sourceAddress: row.sourceAddress, destinationChain: row.destinationChain, destinationAddress: row.destinationAddress, assetAddress: row.assetAddress, assetSymbol: row.assetSymbol, amountToken: row.amountToken, amountUsd: decimal(row.amountUsd), valueStatus: row.valueStatus, eventTs: row.eventTs.toISOString(), txHash: row.txHash, protocol: row.protocol, evidenceTier: row.evidenceTier, confidence: row.confidence, hops: row.hopsJson as unknown as InvestigationHop[], supportingEvidence: row.supportingEvidenceJson, contradictingEvidence: row.contradictingEvidenceJson })), members: record.members.map((row) => ({ chain: row.chain, address: row.address, role: row.role, parentChain: row.parentChain, parentAddress: row.parentAddress, entityKey: row.entityKey, relationshipConfidence: row.relationshipConfidence, evidenceTier: row.evidenceTier, firstLinkedAt: row.firstLinkedAt.toISOString(), lastLinkedAt: row.lastLinkedAt.toISOString(), observationOnly: row.observationOnly })), deployments: record.deployments.map((row) => ({ id: row.deploymentKey, chain: row.chain, buyerAddress: row.buyerAddress, tokenAddress: row.tokenAddress, tokenSymbol: row.tokenSymbol, buyTs: row.buyTs.toISOString(), buyTxHash: row.buyTxHash, amountToken: row.amountToken, amountUsd: decimal(row.amountUsd), entryMarketCapUsd: decimal(row.entryMarketCapUsd), fundingToBuyDelaySec: row.fundingToBuyDelaySec, sourceEntityKey: row.sourceEntityKey, capitalRoute: row.capitalRouteJson as unknown as InvestigationHop[], holdingStatus: row.holdingStatus, evidenceTier: row.evidenceTier })), providerReceipts: record.providerReceiptsJson, completedAt: record.completedAt?.toISOString() ?? null }; }
function objectJson(value: Prisma.JsonValue | undefined | null): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function decimal(value: Prisma.Decimal | number | string | null | undefined) { if (value == null) return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function normalizeConfidence(value: number) { return Math.max(0, Math.min(1, value > 1 ? value / 100 : value)); }
function unique<T>(values: T[]) { return [...new Set(values)]; }
function uniqueRefs(values: Array<{ chain: ChainId; address: string }>) { return [...new Map(values.map((row) => [`${row.chain}:${row.address}`, row])).values()]; }
function dedupeBy<T>(values: T[], key: (value: T) => string) { return [...new Map(values.map((value) => [key(value), value])).values()]; }
function chunks<T>(values: readonly T[], size: number) { const result: T[][] = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result; }
function nonNull<T>(value: T | null | undefined): value is T { return value !== null && value !== undefined; }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
function errorMessage(error: unknown) { return (error instanceof Error ? error.message : String(error)).slice(0, 2_000); }
