import { Prisma, type AddressCategory, type ChainId, type OperatorSession, type PrismaClient } from '@prisma/client';
import type { MassTransactionEvent } from '@flowradar/core';
import type { WalletBridgeScanProvider, WalletCapitalScanProvider } from '@flowradar/providers';
import { normalizeAddress, runUnifiedProfitableWalletDiscovery, validAddress, type HistoricalTraderProvider } from '../discovery/unified';
import { WalletInvestigationService } from '../investigation/walletInvestigation';
import type { WalletInvestigationResult } from '../investigation/types';
import { analyzeTokenWalletIntelligence } from '../intelligence/token';
import { expandWalletCapitalGraph } from '../intelligence/walletFlows';
import { enrollObservationWallet } from '../intelligence/monitoring';
import { createMassTrackerSession } from '../tracker/massTracker';
import { toCsv, toJsonDocument } from './export';
import type {
  BridgeRow, CapitalFlowRow, OperatorPage, OperatorSessionState, OperatorWorkflow, ProfitableSort, ProfitableWalletRow, TokenTraderSort, WalletCapitalRelation, WalletCapitalSummary, WalletSummary
} from './types';

const ALL_CHAINS: ChainId[] = ['SOLANA', 'ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'];
const EVM_CHAINS: ChainId[] = ['ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'];
const DEFAULT_ALERTS = ['funded_new_wallet', 'bridge_transfer', 'dormant_wallet_reactivated', 'receiver_bought_token', 'profit_rotated', 'high_priority_transfer', 'probable_side_wallet_discovered'];
const PENDING_WORKFLOWS: OperatorWorkflow[] = ['wallet', 'token', 'entity', 'flow', 'bridges'];
const pendingWorkflowKey = (workflow: OperatorWorkflow) => `pending:${workflow}`;

export interface OperatorServiceOptions {
  tokenTopTraderProviders?: Partial<Record<ChainId, HistoricalTraderProvider>>;
  walletCapitalScanner?: WalletCapitalScanProvider;
  walletBridgeScanner?: WalletBridgeScanProvider;
}

export class OperatorService {
  private readonly investigations: WalletInvestigationService;
  constructor(private readonly prisma: PrismaClient, private readonly options: OperatorServiceOptions = {}) {
    this.investigations = new WalletInvestigationService(prisma, { walletScanner: options.walletCapitalScanner, bridgeScanner: options.walletBridgeScanner });
  }

  investigateWallet(addressInput: string, options: { refresh?: boolean; maxDepth?: number } = {}) {
    return this.investigations.getOrInvestigate(addressInput, options);
  }

  loadWalletInvestigation(targetInput: string) { return this.investigations.load(targetInput); }

  async scanWalletCapital(addressInput: string) { return this.investigations.investigate(addressInput, { refresh: true, maxDepth: 4 }); }

  async walletInvestigationView(targetInput: string, options: { refresh?: boolean; maxDepth?: number } = {}): Promise<WalletInvestigationResult> {
    return this.investigations.getOrInvestigate(targetInput, options);
  }

  async walletSummary(addressInput: string): Promise<WalletSummary> {
    const target = await this.resolveTarget(addressInput);
    const normalizedInput = normalizeMaybe(addressInput.trim());
    const entityAddressMatches = target.addresses.filter((ref) => ref.address === normalizedInput);
    const addresses = entityAddressMatches.length ? entityAddressMatches : inferredAddressRefs(addressInput);
    const byChain = uniqueRefs(addresses);
    const or = eventAddressWhere(byChain);
    const [walletRows, dnaRows, roleRows, eventCounts, eventChains, highPriority, recentEvents, fundingPaths, dormancyRows, behaviorRows, outflows, chains] = await Promise.all([
      this.prisma.wallet.findMany({ where: { OR: byChain.map((x) => ({ chain: x.chain, address: x.address })) }, take: 25 }),
      this.prisma.walletDnaProfile.findMany({ where: { OR: byChain.map((x) => ({ chain: x.chain, walletAddress: x.address })) }, take: 25 }),
      this.prisma.walletRoleAssignment.findMany({ where: { OR: byChain.map((x) => ({ chain: x.chain, walletAddress: x.address })) }, orderBy: { confidence: 'desc' }, take: 100 }),
      or.length ? this.prisma.massTransactionEvent.groupBy({ by: ['relevanceCategory'], where: { OR: or }, _count: { _all: true } }) : Promise.resolve([]),
      or.length ? this.prisma.massTransactionEvent.findMany({ where: { OR: or }, distinct: ['chain'], select: { chain: true }, take: ALL_CHAINS.length }) : Promise.resolve([]),
      or.length ? this.prisma.massTransactionEvent.count({ where: { OR: or, relevanceScore: { gte: 80 } } }) : Promise.resolve(0),
      or.length ? this.prisma.massTransactionEvent.findMany({ where: { OR: or, relevanceCategory: { in: ['capital_transfer', 'gas_funding', 'token_deployment', 'bridge_verified', 'bridge_unverified'] } }, orderBy: [{ ts: 'desc' }, { eventId: 'desc' }], take: 100 }) : Promise.resolve([]),
      this.prisma.fundingReactivationPath.findMany({ where: { OR: byChain.map((x) => ({ chain: x.chain, walletAddress: x.address })) }, orderBy: { eventTs: 'desc' }, take: 100 }),
      this.prisma.addressDormancyObservation.findMany({ where: { OR: byChain.map((x) => ({ chain: x.chain, walletAddress: x.address })) }, orderBy: { eventTs: 'desc' }, take: 100 }),
      this.prisma.walletBehaviorProfile.findMany({ where: { OR: byChain.map((x) => ({ chain: x.chain, walletAddress: x.address })) }, orderBy: { computedAt: 'desc' }, take: 25 }),
      this.prisma.capitalOutflowPath.findMany({ where: { OR: byChain.map((x) => ({ chain: x.chain, OR: [{ sourceWallet: x.address }, { destinationAddress: x.address }] })) }, take: 1_000 }),
      this.prisma.chain.findMany()
    ]);
    const count = (category: string) => eventCounts.find((x) => x.relevanceCategory === category)?._count._all ?? 0;
    const relevant = ['capital_transfer', 'gas_funding', 'token_deployment', 'bridge_verified', 'bridge_unverified'].reduce((sum, category) => sum + count(category), 0);
    const latestDna = [...dnaRows].sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime())[0];
    const bestRole = target.entity?.addresses.find((x) => x.address === normalizeMaybe(addressInput)) ?? roleRows[0];
    const positions = behaviorRows.flatMap((row) => extractPositions(row.profileJson)).slice(0, 500);
    const latestDormancy = dormancyRows[0];
    const windows = dormancyFlags(latestDormancy?.windowsJson);
    const funders = [
      ...recentEvents.filter((x) => byChain.some((ref) => ref.chain === x.chain && ref.address === x.toAddress)).map((event) => ({
        chain: event.chain, address: event.fromAddress, amountUsd: decimal(event.amountUsd), ts: event.ts.toISOString(), txHash: event.txHash, evidenceTier: event.safeEntityLink ? 'direct_transfer' : 'observed_transfer'
      })),
      ...fundingPaths.filter((x) => x.directFunderAddress).map((path) => ({
        chain: path.chain, address: path.directFunderAddress!, amountUsd: decimal(path.directFundingValuedUsd), ts: (path.directFundingTs ?? path.eventTs).toISOString(), txHash: path.directFundingTxHash ?? '', evidenceTier: 'funding_reactivation_path'
      }))
    ].filter(uniqueFunder).slice(0, 25);
    const undeployed = outflows.filter((x) => x.receiverClassAtReceipt !== 'service').reduce((sum, x) => sum + (decimal(x.knownValueUsd) ?? 0), 0);
    const warnings: string[] = [];
    if (!walletRows.length && !recentEvents.length) warnings.push('Nema lokalno pokrivene aktivnosti za ovu adresu.');
    if (!dnaRows.length) warnings.push('Wallet DNA nije izgrađen ili je coverage nedovoljan.');
    if (dnaRows.some((x) => x.coverage !== 'full')) warnings.push('Profitabilnost je zasnovana na delimičnoj lokalnoj pokrivenosti.');
    if (target.entity && target.entity.chains.length > 1) warnings.push('Cross-chain entity je probabilistička on-chain veza, ne tvrdnja o identitetu.');
    const explorer = new Map(chains.map((x) => [x.id, x.explorerAddressUrl]));
    void explorer;
    const detectedChains = [...new Set([
      ...walletRows.map((x) => x.chain), ...dnaRows.map((x) => x.chain), ...roleRows.map((x) => x.chain), ...eventChains.map((x) => x.chain)
    ])];
    return {
      address: addressInput.trim(), detectedChains,
      role: bestRole?.role ?? 'unknown_related_wallet', relationshipConfidence: bestRole ? normalizeConfidence(bestRole.confidence) : null,
      entityKey: target.entity?.entityKey ?? roleRows.find((x) => x.entityKey)?.entityKey ?? null,
      eventCounts: { raw: eventCounts.reduce((sum, x) => sum + x._count._all, 0), relevant, highPriority }, funders,
      routes: {
        direct: outflows.filter((x) => x.evidenceTier === 'direct_transfer').length,
        multiHop: outflows.filter((x) => x.evidenceTier === 'multi_hop_transfer').length,
        bridges: outflows.filter((x) => x.evidenceTier.includes('bridge')).length + count('bridge_verified'),
        possibleCex: outflows.filter((x) => x.evidenceTier === 'cex_correlation').length
      },
      dormancy: { ...windows, latestClass: latestDormancy?.overallClass ?? null, evidence: latestDormancy?.receiptsJson ?? null },
      positions, completedPositions: dnaRows.reduce((sum, x) => sum + x.completedPositions, 0), winCount: dnaRows.reduce((sum, x) => sum + x.winCount, 0),
      lossCount: dnaRows.reduce((sum, x) => sum + x.lossCount, 0), unresolvedPositions: dnaRows.reduce((sum, x) => sum + x.openPositions + x.unpricedPositions, 0),
      winRate: latestDna?.winRate ?? null, evUsd: latestDna?.evUsdPerCompletedPosition ?? null, repeatRunnerCount: latestDna?.repeatRunnerCount ?? null,
      oneWinnerDependence: latestDna?.oneWinnerDependence ?? null, undeployedCapitalUsd: undeployed > 0 ? undeployed : null,
      lastRelevantActivity: recentEvents[0]?.ts.toISOString() ?? walletRows.sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime())[0]?.lastActiveAt.toISOString() ?? null,
      coverageWarnings: warnings
    };
  }

  private async scanWalletCapitalLegacy(addressInput: string) {
    const refs = uniqueRefs(inferredAddressRefs(addressInput));
    if (!refs.length) throw new Error('Wallet adresa nije validna');
    const scanner = this.options.walletCapitalScanner;
    if (!scanner) throw new Error('Real wallet capital scanner nije konfigurisan');
    const now = new Date();
    for (const ref of refs) await enrollObservationWallet(this.prisma, { chain: ref.chain, address: ref.address, role: 'execution_wallet', reason: 'telegram_wallet_capital_source', now });
    const tracker = await createMassTrackerSession(this.prisma, { enrollReceivers: false, metadata: { workflow: 'telegram_wallet_capital', address: addressInput.trim(), maxHops: 4 } });
    const queue = refs.map((ref) => ({ ...ref, depth: 0 }));
    const visited = new Set(queue.map((node) => `${node.chain}:${node.address}`));
    const infrastructure = new Set<string>();
    const receipts: Array<{ chain: ChainId; address: string; provider: string; pages: number; complete: boolean; events: number; warnings: string[] }> = [];
    let providerErrors = 0;
    let explored = 0;
    try {
      while (queue.length && explored < 16) {
        const node = queue.shift()!;
        explored += 1;
        let scan;
        try {
          scan = await scanner.scanAddress(node.chain, node.address, { root: node.depth === 0, maxPages: node.depth === 0 ? 30 : 3 });
        } catch (error) {
          tracker.recordProviderError(); providerErrors += 1;
          receipts.push({ chain: node.chain, address: node.address, provider: 'unavailable', pages: 0, complete: false, events: 0, warnings: [error instanceof Error ? error.message : String(error)] });
          continue;
        }
        for (const item of scan.infrastructure) {
          infrastructure.add(`${item.chain}:${item.address}`);
          await this.prisma.addressRegistry.upsert({
            where: { chain_address: { chain: item.chain as ChainId, address: item.address } },
            create: { chain: item.chain as ChainId, address: item.address, category: registryCategory(item.category), label: item.label, source: scan.provider, doNotExpand: true },
            update: { category: registryCategory(item.category), label: item.label, source: scan.provider, doNotExpand: true }
          });
        }
        const events = scan.events.map((event) => ({ ...event, observedAt: event.ts, metadata: { ...event.metadata, operatorWalletHistoricalBackfill: true } }));
        await persistObservedTokens(this.prisma, events, now);
        for (const batch of chunks(events, 500)) await tracker.ingest(batch);
        receipts.push({ chain: node.chain, address: node.address, provider: scan.provider, pages: scan.pagesFetched, complete: scan.complete, events: events.length, warnings: scan.warnings });
        if (node.depth >= 3) continue;
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
        const expansionLimit = 4;
        for (const candidate of [...candidates.values()].sort((a, b) => b.transfers - a.transfers || b.lastTs - a.lastTs || b.score - a.score || a.address.localeCompare(b.address)).slice(0, expansionLimit)) {
          const key = `${candidate.chain}:${candidate.address}`;
          if (visited.has(key)) continue;
          visited.add(key); queue.push({ chain: candidate.chain, address: candidate.address, depth: node.depth + 1 });
        }
      }
      const metrics = await tracker.complete();
      const expansions = [];
      for (const ref of refs) expansions.push(await expandWalletCapitalGraph(this.prisma, { chain: ref.chain, walletAddress: ref.address, maxDepth: 4, maxNodes: 500, maxEventsPerNode: 2_000, now }));
      return { chains: refs.map((ref) => ref.chain), nodesScanned: explored, providerErrors, receipts, metrics, relationshipsPersisted: expansions.reduce((sum, row) => sum + row.relationshipsPersisted, 0) };
    } catch (error) {
      await tracker.fail(error);
      throw error;
    }
  }

  private async walletCapitalSummaryLegacy(addressInput: string): Promise<WalletCapitalSummary> {
    const refs = uniqueRefs(inferredAddressRefs(addressInput));
    if (!refs.length) throw new Error('Wallet adresa nije validna');
    const relationships = await this.prisma.walletFlowRelationship.findMany({
      where: { OR: refs.map((ref) => ({ sourceChain: ref.chain, sourceWallet: ref.address })) },
      orderBy: [{ relationshipConfidence: 'desc' }, { firstTransferTs: 'asc' }, { relatedChain: 'asc' }, { relatedWallet: 'asc' }], take: 500
    });
    const receiptIds = uniqueStrings(relationships.flatMap((row) => row.transferReceiptIds));
    const transferEvents = receiptIds.length ? await this.prisma.massTransactionEvent.findMany({ where: { eventId: { in: receiptIds } }, orderBy: [{ ts: 'asc' }, { eventId: 'asc' }] }) : [];
    const eventById = new Map(transferEvents.map((event) => [event.eventId, event]));
    const relatedRefs = uniqueRefs(relationships.map((row) => ({ chain: row.relatedChain, address: row.relatedWallet })));
    const outgoing = relatedRefs.length ? await this.prisma.massTransactionEvent.findMany({
      where: { OR: relatedRefs.map((ref) => ({ chain: ref.chain, fromAddress: ref.address })), kind: { in: ['native_transfer', 'token_transfer', 'token_buy'] } },
      orderBy: [{ ts: 'asc' }, { eventId: 'asc' }], take: 20_000
    }) : [];
    const tokens = uniqueRefs(relationships.flatMap((row) => parsedTradedTokens(row.tradedTokensJson).map((token) => ({ chain: row.relatedChain, address: token.address }))));
    const tokenRows = tokens.length ? await this.prisma.token.findMany({ where: { OR: tokens.map((token) => ({ chain: token.chain, address: token.address })) }, select: { chain: true, address: true, symbol: true } }) : [];
    const tokenSymbol = new Map(tokenRows.map((token) => [`${token.chain}:${token.address}`, token.symbol]));
    for (const event of outgoing) if (event.assetAddress && event.assetSymbol && !tokenSymbol.has(`${event.chain}:${event.assetAddress}`)) tokenSymbol.set(`${event.chain}:${event.assetAddress}`, event.assetSymbol);
    const rows: WalletCapitalRelation[] = relationships.map((row) => {
      const receipts = row.transferReceiptIds.map((id) => eventById.get(id)).filter(nonNull).sort((a, b) => a.ts.getTime() - b.ts.getTime());
      const knownAmounts = receipts.map((event) => decimal(event.amountUsd)).filter((value): value is number => value !== null && value >= 0);
      const support = objectJson(row.supportingEvidenceJson);
      const relationTokens = parsedTradedTokens(row.tradedTokensJson).map((token) => ({ ...token, symbol: tokenSymbol.get(`${row.relatedChain}:${token.address}`) ?? null }));
      const firstBuy = relationTokens.map((token) => new Date(token.firstBuyTs)).filter((date) => !Number.isNaN(date.getTime())).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
      const rotations = outgoing.filter((event) => event.chain === row.relatedChain && event.fromAddress === row.relatedWallet && event.ts >= row.firstTransferTs && (!firstBuy || event.ts >= firstBuy)).flatMap((event) => event.kind === 'token_buy' && event.assetAddress
        ? [`reinvested:${tokenSymbol.get(`${event.chain}:${event.assetAddress}`) ?? event.assetAddress}`]
        : event.toAddress !== row.relatedWallet ? [`${event.chain}:${event.toAddress}`] : []).filter((value, index, all) => all.indexOf(value) === index).slice(0, 5);
      const source = receipts[0] ?? null;
      return {
        sourceChain: row.sourceChain, chain: row.relatedChain, address: row.relatedWallet, role: row.role,
        route: row.route as WalletCapitalRelation['route'], hops: row.hops,
        amount: source?.amountToken ?? null, amountSymbol: source?.assetSymbol ?? null,
        amountUsd: knownAmounts.length ? Math.min(...knownAmounts) : finiteJsonNumber(support?.knownAmountUsd),
        sourceTxHash: source?.txHash ?? null, sourceTxUrl: source ? transactionExplorer(row.sourceChain, source.txHash) : null,
        firstTransferTs: row.firstTransferTs.toISOString(), lastTransferTs: row.lastTransferTs.toISOString(),
        tokens: relationTokens, rotations, confidence: normalizeConfidence(row.relationshipConfidence),
        fresh: support?.freshAtReceipt === true, dormant: support?.dormantAtReceipt === true,
        safeEntityLink: row.safeEntityLink, entityKey: row.relatedEntityKey
      };
    });
    const sourceEntity = await this.prisma.unifiedEntityAddress.findFirst({ where: { OR: refs.map((ref) => ({ chain: ref.chain, address: ref.address })) }, include: { entity: { select: { entityKey: true } } } });
    return { address: addressInput.trim(), scannedChains: refs.map((ref) => ref.chain), entityKey: sourceEntity?.entity.entityKey ?? null, relations: rows };
  }

  async scanTokenTopPnl(addressInput: string) {
    const inferred = inferredAddressRefs(addressInput);
    if (!inferred.length) throw new Error('Token CA nije validan');
    const normalized = inferred.map((ref) => ref.address);
    const [tokens, universe, candidates] = await Promise.all([
      this.prisma.token.findMany({ where: { address: { in: normalized } }, select: { chain: true, address: true } }),
      this.prisma.historicalTokenUniverse.findMany({ where: { tokenAddress: { in: normalized } } }),
      this.prisma.tokenTopPnlCandidate.findMany({ where: { mint: { in: normalized } }, distinct: ['chain'], select: { chain: true, mint: true } })
    ]);
    const knownChains = new Set<ChainId>([...tokens.map((row) => row.chain), ...universe.map((row) => row.chain), ...candidates.map((row) => row.chain)]);
    let refs = knownChains.size ? inferred.filter((ref) => knownChains.has(ref.chain)) : inferred;
    if (!knownChains.size && /^0x/i.test(addressInput.trim()) && this.options.tokenTopTraderProviders?.BSC) {
      refs = inferred.filter((ref) => ref.chain === 'BSC');
    }
    refs = uniqueRefs(refs);
    const now = new Date();
    const universeBy = new Map(universe.map((row) => [`${row.chain}:${row.tokenAddress}`, row]));
    for (const ref of refs) {
      const existing = universeBy.get(`${ref.chain}:${ref.address}`);
      const data = {
        sources: [...new Set([...(existing?.sources ?? []), 'telegram_token_scan'])].sort(),
        historicalWinnerStatus: existing?.historicalWinnerStatus ?? 'candidate',
        coverage: existing?.coverage ?? 'unavailable',
        processingStatus: 'pending',
        evidenceJson: json({ priorEvidence: existing?.evidenceJson ?? null, telegramTokenScan: { requestedAt: now.toISOString() } }),
        lastError: null,
        nextRetryAt: null
      };
      await this.prisma.historicalTokenUniverse.upsert({
        where: { chain_tokenAddress: { chain: ref.chain, tokenAddress: ref.address } },
        create: { chain: ref.chain, tokenAddress: ref.address, ...data },
        update: data
      });
    }
    const providers = Object.fromEntries(refs.flatMap((ref) => {
      const provider = this.options.tokenTopTraderProviders?.[ref.chain];
      return provider ? [[ref.chain, provider]] : [];
    })) as Partial<Record<ChainId, HistoricalTraderProvider>>;
    await runUnifiedProfitableWalletDiscovery(this.prisma, {
      chains: refs.map((ref) => ref.chain),
      tokenAddresses: [...new Set(refs.map((ref) => ref.address))],
      limit: refs.length,
      perTokenLocalCap: 10,
      perTokenProviderCap: 10,
      maxTradesPerToken: 100_000,
      requestBudget: Object.keys(providers).length,
      retryUnavailable: true,
      providers,
      buildDna: false,
      forceProviderRefresh: true,
      now
    });
    let candidateCount = 0;
    for (const ref of refs) {
      const count = await this.prisma.tokenTopPnlCandidate.count({ where: { chain: ref.chain, mint: ref.address, validation: { not: 'invalid' } } });
      candidateCount += count;
      if (count > 0) await analyzeTokenWalletIntelligence(this.prisma, { chain: ref.chain, tokenAddress: ref.address, topLimit: 10, now });
    }
    return { chains: refs.map((ref) => ref.chain), candidateCount };
  }

  async tokenSummary(addressInput: string, page = 1, pageSize = 10, sort: TokenTraderSort = 'pnl') {
    const refs = inferredAddressRefs(addressInput);
    const normalized = refs.map((x) => x.address);
    const [tokens, metadata, universe, candidates] = await Promise.all([
      this.prisma.token.findMany({ where: { address: { in: normalized } }, take: 10, include: { marketSnapshots: { orderBy: { ts: 'desc' }, take: 1 } } }),
      this.prisma.tokenMetadata.findMany({ where: { mint: { in: normalized } }, take: 10 }),
      this.prisma.historicalTokenUniverse.findMany({ where: { tokenAddress: { in: normalized } }, take: 10 }),
      this.prisma.tokenTopPnlCandidate.findMany({ where: { mint: { in: normalized } }, orderBy: [{ chain: 'asc' }, { walletAddress: 'asc' }, { localRealizedProxyUsd: 'desc' }, { claimedRealizedPnlUsd: 'desc' }, { confidence: 'desc' }], take: 5_000, distinct: ['chain', 'walletAddress'] })
    ]);
    const walletRefs = candidates.map((x) => ({ chain: x.chain, address: x.walletAddress }));
    const [entityAddresses, rootRows, dnaRows, dormancyRows, intelligenceRows] = walletRefs.length ? await Promise.all([
      this.prisma.unifiedEntityAddress.findMany({ where: { OR: walletRefs.map((x) => ({ chain: x.chain, address: x.address })) }, include: { entity: { select: { entityKey: true } } }, take: 100 }),
      this.prisma.lineageRoot.findMany({ where: { wallet: { OR: walletRefs.map((x) => ({ chain: x.chain, address: x.address })) } }, select: { wallet: { select: { chain: true, address: true } } }, take: 5_000 }),
      this.prisma.walletDnaProfile.findMany({ where: { OR: walletRefs.map((x) => ({ chain: x.chain, walletAddress: x.address })) }, take: 5_000 }),
      this.prisma.addressDormancyObservation.groupBy({ by: ['chain', 'walletAddress'], where: { OR: walletRefs.map((x) => ({ chain: x.chain, walletAddress: x.address })), overallClass: { in: ['covered_dormant', 'apparently_dormant_incomplete_history'] } }, _count: { _all: true } }),
      this.prisma.tokenWalletIntelligence.findMany({ where: { tokenAddress: { in: normalized }, OR: walletRefs.map((x) => ({ chain: x.chain, walletAddress: x.address })) }, orderBy: { computedAt: 'desc' }, take: 5_000 })
    ]) : [[], [], [], [], []];
    const entityBy = new Map(entityAddresses.map((x) => [`${x.chain}:${x.address}`, { entityKey: x.entity.entityKey, role: x.role }]));
    const roots = new Set(rootRows.map((x) => `${x.wallet.chain}:${x.wallet.address}`));
    const dnaBy = new Map(dnaRows.map((x) => [`${x.chain}:${x.walletAddress}`, x]));
    const dormancyBy = new Map(dormancyRows.map((x) => [`${x.chain}:${x.walletAddress}`, x._count._all]));
    const intelligenceBy = new Map<string, typeof intelligenceRows[number]>();
    for (const row of intelligenceRows) if (!intelligenceBy.has(`${row.chain}:${row.walletAddress}`)) intelligenceBy.set(`${row.chain}:${row.walletAddress}`, row);
    const traderCandidates = candidates
      .filter((x) => !roots.has(`${x.chain}:${x.walletAddress}`) && entityBy.get(`${x.chain}:${x.walletAddress}`)?.role !== 'root_main')
      .map((x) => {
        const key = `${x.chain}:${x.walletAddress}`;
        const localPnl = decimal(x.localRealizedProxyUsd);
        const bought = decimal(x.localBoughtUsd);
        const roi = localPnl != null && bought != null && bought > 0 ? localPnl / bought : x.claimedRoi;
        const dna = dnaBy.get(key);
        return { candidate: x, pnl: localPnl ?? decimal(x.claimedRealizedPnlUsd) ?? decimal(x.claimedTotalPnlUsd), roi, entryMcap: decimal(dna?.medianEntryMcapUsd), repeatRunners: dna?.repeatRunnerCount ?? null, dormancy: dormancyBy.get(key) ?? 0, entity: entityBy.get(key) };
      })
      .sort(tokenTraderComparator(sort));
    const start = offset(page, pageSize);
    const pageCandidates = traderCandidates.slice(start, start + boundedPageSize(pageSize));
    const warnings: string[] = [];
    if (!tokens.length) warnings.push('Canonical Token red ne postoji; prikazani su samo discovery/universe dokazi ako postoje.');
    if (!pageCandidates.length) warnings.push('Nema non-empty top-PnL/trader rezultata u lokalnoj bazi za ovu stranicu.');
    if (traderCandidates.length !== candidates.length) warnings.push('Operator root walleti su izostavljeni iz trader rezultata.');
    if (universe.some((x) => x.processingStatus === 'unavailable' || x.processingStatus === 'retryable')) warnings.push('Discovery coverage je unavailable/retryable; rezultat nije izmišljen.');
    return {
      tokens: tokens.map((token) => ({ chain: token.chain, address: token.address, name: token.name, symbol: token.symbol, decimals: token.decimals, latestMcapUsd: decimal(token.marketSnapshots[0]?.marketCapUsd), latestMcapTs: token.marketSnapshots[0]?.ts.toISOString() ?? null })),
      metadata: metadata.map((x) => ({ chain: x.chain, name: x.name, symbol: x.symbol, source: x.source, availability: x.availability })),
      universe: universe.map((x) => ({ chain: x.chain, sources: x.sources, historicalWinnerStatus: x.historicalWinnerStatus, athMcapUsd: decimal(x.athMcapUsd), coverage: x.coverage, processingStatus: x.processingStatus })),
      topPnl: pageResult(pageCandidates.map(({ candidate: x, roi, entryMcap, repeatRunners, dormancy, entity }) => ({
        chain: x.chain, walletAddress: x.walletAddress, providerRank: x.providerRank, source: x.source, validation: x.validation,
        realizedPnlUsd: decimal(x.localRealizedProxyUsd) ?? decimal(x.claimedRealizedPnlUsd) ?? decimal(x.claimedTotalPnlUsd),
        boughtUsd: decimal(x.localBoughtUsd) ?? decimal(x.claimedBoughtUsd), soldUsd: decimal(x.localSoldUsd) ?? decimal(x.claimedSoldUsd),
        remainingPositionUsd: decimal(x.claimedRemainingUsd), claimedRealizedPnlUsd: decimal(x.claimedRealizedPnlUsd), roi,
        entryMcapUsd: entryMcap, repeatRunnerCount: repeatRunners, dormancyReactivations: dormancy,
        firstBuyTs: x.localFirstBuyTs?.toISOString() ?? providerEntryTime(x.providerJson), firstSellTs: x.localFirstSellTs?.toISOString() ?? null,
        dormancy: (() => { const row = intelligenceBy.get(`${x.chain}:${x.walletAddress}`); return row ? { days7: row.dormant7d, days14: row.dormant14d, days30: row.dormant30d, days90: row.dormant90d } : null; })(),
        confidence: normalizeConfidence(x.confidence), coverage: x.coverage,
        entityKey: entity?.entityKey ?? null, role: entity?.role ?? 'unknown_related_wallet'
      })), page, pageSize, traderCandidates.length, warnings),
      coverageWarnings: warnings
    };
  }

  async profitable(options: { chain?: ChainId | 'ALL'; sort?: ProfitableSort; page?: number; pageSize?: number } = {}): Promise<OperatorPage<ProfitableWalletRow>> {
    const chain = options.chain && options.chain !== 'ALL' ? options.chain : null;
    const sort = options.sort ?? 'pnl';
    const page = positive(options.page ?? 1);
    const pageSize = boundedPageSize(options.pageSize ?? 10);
    const order = profitableOrder(sort);
    type Row = {
      chain: ChainId; address: string; validation: string; local_pnl: Prisma.Decimal | null; provider_pnl: Prisma.Decimal | null;
      win_rate: number | null; ev_usd: number | null; repeat_runners: number | null; entry_mcap: Prisma.Decimal | null;
      one_winner: number | null; dormancy_count: bigint | number; confidence: number; coverage: string; entity_key: string | null; role: string | null; total_count: bigint | number;
    };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      WITH candidate AS (
        SELECT DISTINCT ON (c.chain, c."walletAddress") c.chain, c."walletAddress" AS address, c.validation,
          c."localRealizedProxyUsd" AS local_pnl, COALESCE(c."claimedRealizedPnlUsd", c."claimedTotalPnlUsd") AS provider_pnl,
          c.confidence, c.coverage
        FROM "token_top_pnl_candidates" c
        WHERE (${chain}::text IS NULL OR c.chain::text = ${chain})
        ORDER BY c.chain, c."walletAddress", c."localRealizedProxyUsd" DESC NULLS LAST, c."claimedRealizedPnlUsd" DESC NULLS LAST, c.confidence DESC
      ), ranked AS (
        SELECT c.chain, c.address,
          CASE WHEN c.local_pnl IS NULL AND provider_stats.pnl_usd IS NOT NULL THEN 'provider_only' ELSE c.validation END AS validation,
          c.local_pnl, COALESCE(c.provider_pnl, provider_stats.pnl_usd) AS provider_pnl,
          c.confidence, CASE WHEN c.local_pnl IS NULL AND provider_stats.pnl_usd IS NOT NULL THEN 'provider_only' ELSE c.coverage END AS coverage,
          COALESCE(d."winRate", provider_stats.win_rate) AS win_rate, d."evUsdPerCompletedPosition" AS ev_usd, d."repeatRunnerCount" AS repeat_runners,
          d."medianEntryMcapUsd" AS entry_mcap, d."oneWinnerDependence" AS one_winner,
          COALESCE((SELECT COUNT(*) FROM "entity_dormancy_observations" e WHERE e.chain = c.chain AND e."walletAddress" = c.address AND e."entityClass" LIKE '%reactivation%'), 0) AS dormancy_count,
          ue."entityKey" AS entity_key, uea.role,
          COUNT(*) OVER() AS total_count
        FROM candidate c
        LEFT JOIN "wallet_dna_profiles" d ON d.chain = c.chain AND d."walletAddress" = c.address
        LEFT JOIN "unified_entity_addresses" uea ON uea.chain = c.chain AND uea.address = c.address
        LEFT JOIN "unified_entities" ue ON ue.id = uea."entityId"
        LEFT JOIN "wallets" w ON w.chain = c.chain AND w.address = c.address
        LEFT JOIN "lineage_roots" lr ON lr."walletId" = w.id
        LEFT JOIN LATERAL (
          SELECT ops."pnlUsd" AS pnl_usd, ops."winRate" AS win_rate
          FROM "observation_provider_snapshot" ops
          WHERE ops."walletId" = w.id AND ops."pnlUsd" > 0
          ORDER BY ops."observedAt" DESC, ops.id ASC
          LIMIT 1
        ) provider_stats ON true
        WHERE COALESCE(c.local_pnl, c.provider_pnl, provider_stats.pnl_usd) > 0
          AND lr.id IS NULL
          AND COALESCE(uea.role, '') <> 'root_main'
      )
      SELECT * FROM ranked ORDER BY ${Prisma.raw(order)} LIMIT ${pageSize} OFFSET ${offset(page, pageSize)}
    `);
    const total = Number(rows[0]?.total_count ?? 0);
    const warnings = ['Provider-claimed PnL je discovery evidence; lokalni realized PnL ima prednost.', 'Svi automatski pronađeni walleti ostaju observation_only.'];
    return pageResult(rows.map((row) => ({
      chain: row.chain, address: row.address, entityKey: row.entity_key, role: row.role ?? 'unknown_related_wallet', validation: row.validation,
      localRealizedPnlUsd: decimal(row.local_pnl), providerClaimedPnlUsd: decimal(row.provider_pnl), winRate: row.win_rate, evUsd: row.ev_usd,
      repeatRunnerCount: row.repeat_runners, medianEntryMcapUsd: decimal(row.entry_mcap), oneWinnerDependence: row.one_winner,
      dormancyReactivations: Number(row.dormancy_count), confidence: normalizeConfidence(row.confidence), coverage: row.coverage
    })), page, pageSize, total, warnings);
  }

  async entity(targetInput: string) {
    const target = await this.resolveTarget(targetInput);
    if (!target.entity) return { entityKey: null, addresses: [], coverageWarnings: ['Unified entity nije pronađen za zadati ključ/adresu.'] };
    const refs = target.entity.addresses.map((x) => ({ chain: x.chain, address: x.address }));
    const [dna, chains, capital, recent] = await Promise.all([
      this.prisma.walletDnaProfile.findMany({ where: { OR: refs.map((x) => ({ chain: x.chain, walletAddress: x.address })) }, take: 1_000 }),
      this.prisma.capitalChain.findMany({ where: { OR: [{ sourceEntityKey: target.entity.entityKey }, { sourceWallet: { in: refs.map((x) => x.address) } }, { receiverWallet: { in: refs.map((x) => x.address) } }] }, orderBy: { computedAt: 'desc' }, take: 1_000 }),
      this.prisma.chain.findMany(),
      this.prisma.massTransactionEvent.findMany({ where: { OR: eventAddressWhere(refs), relevanceScore: { gte: 50 } }, orderBy: { ts: 'desc' }, take: 25 })
    ]).then(([dnaRows, capitalRows, chainRows, recentRows]) => [dnaRows, chainRows, capitalRows, recentRows] as const);
    const completed = dna.reduce((sum, x) => sum + x.completedPositions, 0);
    const wins = dna.reduce((sum, x) => sum + x.winCount, 0);
    const losses = dna.reduce((sum, x) => sum + x.lossCount, 0);
    const pnl = dna.reduce((sum, x) => sum + (decimal(x.totalRealizedPnlUsd) ?? 0), 0);
    const explorer = new Map(chains.map((x) => [x.id, x.explorerAddressUrl]));
    return {
      entityKey: target.entity.entityKey, confidence: target.entity.confidence,
      caveats: target.entity.caveats,
      addresses: target.entity.addresses.map((x) => ({ chain: x.chain, address: x.address, role: x.role, confidence: x.confidence, evidenceTier: x.evidenceTier, explorerUrl: explorerUrl(explorer.get(x.chain), x.address) })),
      metrics: { completedPositions: completed, winCount: wins, lossCount: losses, unresolvedPositions: dna.reduce((sum, x) => sum + x.openPositions + x.unpricedPositions, 0), winRate: completed ? wins / completed : null, evUsd: completed ? pnl / completed : null, totalRealizedPnlUsd: completed ? pnl : null },
      historicalTokens: uniqueStrings(dna.flatMap((x) => extractDiscoveryMints(x.discoveryJson))).slice(0, 500),
      capital: { staging: capital.filter((x) => x.kind === 'staging').length, deployments: capital.filter((x) => x.kind === 'deployment').length, rotations: capital.filter((x) => x.kind === 'profit_rotation').length, stagedCapitalUsd: sumDecimal(capital.map((x) => x.knownValueUsd)) },
      lastActivities: recent.map((x) => ({ chain: x.chain, kind: x.kind, ts: x.ts.toISOString(), txHash: x.txHash })),
      coverageWarnings: ['Entity veze su evidence-backed i probabilističke; ne označavaju stvarnu osobu.']
    };
  }

  async flows(targetInput: string, page = 1, pageSize = 10): Promise<OperatorPage<CapitalFlowRow>> {
    const target = await this.resolveTarget(targetInput);
    const refs = target.addresses.length ? target.addresses : inferredAddressRefs(targetInput);
    const [events, paths, chains] = await Promise.all([
      this.prisma.massTransactionEvent.findMany({ where: { OR: [...eventAddressWhere(refs), ...(target.entity ? [{ sourceEntityKey: target.entity.entityKey }] : [])], relevanceCategory: { in: ['capital_transfer', 'gas_funding', 'bridge_verified', 'bridge_unverified', 'token_deployment'] } }, orderBy: { ts: 'desc' }, take: 5_000 }),
      this.prisma.capitalOutflowPath.findMany({ where: { OR: [{ sourceEntityKey: target.entity?.entityKey ?? targetInput }, { sourceWallet: { in: refs.map((x) => x.address) } }, { destinationAddress: { in: refs.map((x) => x.address) } }] }, orderBy: { lastTransferTs: 'desc' }, take: 5_000 }),
      this.prisma.chain.findMany()
    ]);
    const explorer = new Map(chains.map((x) => [x.id, x.explorerTxUrl]));
    const rows: CapitalFlowRow[] = [
      ...events.map((x) => ({ id: x.eventId, source: x.fromAddress, destination: x.toAddress, sourceChain: x.chain, destinationChain: bridgeDestinationChain(x.bridgeJson) ?? x.chain, route: x.kind, protocol: x.bridgeProtocol, asset: x.assetAddress ?? x.assetSymbol, amountToken: x.amountToken, amountUsd: decimal(x.amountUsd), ts: x.ts.toISOString(), evidenceTier: x.relevanceCategory, txHash: x.txHash, explorerUrl: explorerUrl(explorer.get(x.chain), x.txHash) })),
      ...paths.map((x) => ({ id: x.id, source: x.sourceWallet, destination: x.destinationAddress, sourceChain: x.chain, destinationChain: x.chain, route: x.evidenceTier, protocol: x.bridgeProtocol, asset: null, amountToken: null, amountUsd: decimal(x.knownValueUsd), ts: x.lastTransferTs.toISOString(), evidenceTier: x.evidenceTier, txHash: firstPathTx(x.pathJson), explorerUrl: explorerUrl(explorer.get(x.chain), firstPathTx(x.pathJson)) }))
    ].sort((a, b) => b.ts.localeCompare(a.ts) || a.id.localeCompare(b.id));
    const start = offset(page, pageSize);
    return pageResult(rows.slice(start, start + boundedPageSize(pageSize)), page, pageSize, rows.length, ['CEX putanje su samo possible_cex_mediated; CEX nikada ne pripisuje downstream receiver bez dodatnog dokaza.']);
  }

  async bridges(targetInput: string, page = 1, pageSize = 10): Promise<OperatorPage<BridgeRow>> {
    const target = await this.resolveTarget(targetInput);
    const refs = target.addresses.length ? target.addresses : inferredAddressRefs(targetInput);
    const relevantEvents = await this.prisma.massTransactionEvent.findMany({ where: { OR: eventAddressWhere(refs), kind: { in: ['bridge_source', 'bridge_destination'] } }, select: { eventId: true }, take: 10_000 });
    const ids = relevantEvents.map((x) => x.eventId);
    const total = ids.length ? await this.prisma.massBridgeCorrelation.count({ where: { OR: [{ sourceEventId: { in: ids } }, { destinationEventId: { in: ids } }] } }) : 0;
    const correlations = ids.length ? await this.prisma.massBridgeCorrelation.findMany({ where: { OR: [{ sourceEventId: { in: ids } }, { destinationEventId: { in: ids } }] }, orderBy: { correlatedAt: 'desc' }, skip: offset(page, pageSize), take: boundedPageSize(pageSize) }) : [];
    const pairIds = [...new Set(correlations.flatMap((x) => [x.sourceEventId, x.destinationEventId]))];
    const events = await this.prisma.massTransactionEvent.findMany({ where: { eventId: { in: pairIds } } });
    const byId = new Map(events.map((x) => [x.eventId, x]));
    const rows: BridgeRow[] = [];
    for (const correlation of correlations) {
      const source = byId.get(correlation.sourceEventId);
      const destination = byId.get(correlation.destinationEventId);
      if (!source || !destination) continue;
      const [later, trace] = await Promise.all([
        this.prisma.massTransactionEvent.findFirst({ where: { chain: destination.chain, OR: [{ fromAddress: destination.toAddress }, { actorAddress: destination.toAddress }], ts: { gt: destination.ts } }, orderBy: { ts: 'asc' } }),
        this.prisma.massTrackerTrace.findFirst({ where: { bridgeCorrelationIds: { has: correlation.correlationId } }, orderBy: { computedAt: 'desc' } })
      ]);
      rows.push({ correlationId: correlation.correlationId, protocol: correlation.protocol, status: correlation.status, evidenceTier: correlation.status === 'verified' ? 'exact' : 'inferred', confidence: normalizeConfidence(correlation.confidence), sourceChain: source.chain, destinationChain: destination.chain, sourceTx: source.txHash, destinationTx: destination.txHash, recipient: destination.toAddress, amountToken: destination.amountToken, amountUsd: decimal(destination.amountUsd), destinationActivity: later?.ts.toISOString() ?? null, tokenBuy: trace?.tokenBought ?? null });
    }
    return pageResult(rows, page, pageSize, total, ['Samo verified official bridge parovi mogu preneti entity vezu preko chainova.']);
  }

  async recent(page = 1, pageSize = 10) {
    const where = { relevanceCategory: { in: ['capital_transfer', 'gas_funding', 'token_deployment', 'bridge_verified', 'bridge_unverified'] } };
    const [total, events] = await Promise.all([
      this.prisma.massTransactionEvent.count({ where }),
      this.prisma.massTransactionEvent.findMany({ where, orderBy: [{ ts: 'desc' }, { eventId: 'desc' }], skip: offset(page, pageSize), take: boundedPageSize(pageSize) })
    ]);
    return pageResult(events.map((x) => ({ eventId: x.eventId, chain: x.chain, kind: x.kind, source: x.fromAddress, destination: x.toAddress, amountUsd: decimal(x.amountUsd), category: x.relevanceCategory, score: x.relevanceScore, ts: x.ts.toISOString(), txHash: x.txHash })), page, pageSize, total, []);
  }

  async watch(userId: string, chatId: string, targetInput: string, alertTypes = DEFAULT_ALERTS) {
    const target = await this.resolveTarget(targetInput);
    if (!target.entity && inferredAddressRefs(targetInput).length === 0) throw new Error('Watch target must be a valid Solana/EVM address or an existing entity key');
    const targetType = target.entity ? 'entity' : 'wallet';
    const targetKey = target.entity?.entityKey ?? normalizeMaybe(targetInput.trim());
    return this.prisma.operatorWatch.upsert({
      where: { userId_chatId_targetType_targetKey: { userId, chatId, targetType, targetKey } },
      create: { userId, chatId, targetType, targetKey, chain: target.entity ? null : inferredAddressRefs(targetInput)[0]?.chain ?? null, alertTypes: [...new Set(alertTypes.filter((x) => DEFAULT_ALERTS.includes(x)))], active: true },
      update: { alertTypes: [...new Set(alertTypes.filter((x) => DEFAULT_ALERTS.includes(x)))], active: true }
    });
  }

  async listWatches(userId: string, chatId: string) { return this.prisma.operatorWatch.findMany({ where: { userId, chatId, active: true }, orderBy: { updatedAt: 'desc' }, take: 100 }); }

  async setPendingSession(userId: string, chatId: string, workflow: OperatorWorkflow, ttlMinutes = 10) {
    if (!PENDING_WORKFLOWS.includes(workflow)) throw new Error('Workflow does not accept a pending target');
    await this.clearPendingSession(userId, chatId);
    return this.prisma.operatorSession.create({
      data: {
        userId,
        chatId,
        workflow: pendingWorkflowKey(workflow),
        stateJson: json({ page: 1, pageSize: 10 }),
        expiresAt: new Date(Date.now() + Math.max(1, Math.min(ttlMinutes, 60)) * 60_000)
      }
    });
  }

  async getPendingSession(userId: string, chatId: string) {
    const session = await this.prisma.operatorSession.findFirst({
      where: { userId, chatId, workflow: { in: PENDING_WORKFLOWS.map(pendingWorkflowKey) }, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' }
    });
    if (!session) return null;
    const workflow = session.workflow.slice('pending:'.length) as OperatorWorkflow;
    return PENDING_WORKFLOWS.includes(workflow) ? { session, workflow } : null;
  }

  async clearPendingSession(userId: string, chatId: string) {
    const result = await this.prisma.operatorSession.deleteMany({
      where: { userId, chatId, workflow: { in: PENDING_WORKFLOWS.map(pendingWorkflowKey) } }
    });
    return result.count;
  }

  async validateWorkflowTarget(workflow: OperatorWorkflow, input: string) {
    if (inferredAddressRefs(input).length) return true;
    if (!['entity', 'flow', 'bridges'].includes(workflow)) return false;
    return Boolean(await this.prisma.unifiedEntity.findUnique({ where: { entityKey: input.trim() }, select: { id: true } }));
  }

  async classifyAddressInput(input: string): Promise<'wallet' | 'token' | 'ambiguous' | 'invalid'> {
    const refs = inferredAddressRefs(input);
    if (!refs.length) return 'invalid';
    const tokenRefs = refs.map((ref) => ({ chain: ref.chain, address: ref.address }));
    const mintRefs = refs.map((ref) => ({ chain: ref.chain, mint: ref.address }));
    const universeRefs = refs.map((ref) => ({ chain: ref.chain, tokenAddress: ref.address }));
    const walletRefs = refs.map((ref) => ({ chain: ref.chain, address: ref.address }));
    const candidateWalletRefs = refs.map((ref) => ({ chain: ref.chain, walletAddress: ref.address }));
    const [tokens, metadata, universe, candidateMints, tokenEvents, wallets, entityAddresses, candidateWallets, walletEvents] = await Promise.all([
      this.prisma.token.count({ where: { OR: tokenRefs } }),
      this.prisma.tokenMetadata.count({ where: { OR: mintRefs } }),
      this.prisma.historicalTokenUniverse.count({ where: { OR: universeRefs } }),
      this.prisma.tokenTopPnlCandidate.count({ where: { OR: mintRefs } }),
      this.prisma.massTransactionEvent.count({ where: { OR: refs.map((ref) => ({ chain: ref.chain, tokenAddress: ref.address })) } }),
      this.prisma.wallet.count({ where: { OR: walletRefs } }),
      this.prisma.unifiedEntityAddress.count({ where: { OR: walletRefs } }),
      this.prisma.tokenTopPnlCandidate.count({ where: { OR: candidateWalletRefs } }),
      this.prisma.massTransactionEvent.count({ where: { OR: eventAddressWhere(refs) } })
    ]);
    const hasTokenEvidence = tokens + metadata + universe + candidateMints + tokenEvents > 0;
    const hasWalletEvidence = wallets + entityAddresses + candidateWallets + walletEvents > 0;
    if (hasTokenEvidence !== hasWalletEvidence) return hasTokenEvidence ? 'token' : 'wallet';
    return 'ambiguous';
  }

  async queueDeeperTokenScan(input: string) {
    const refs = inferredAddressRefs(input);
    if (!refs.length) throw new Error('Token CA nije validan');
    const result = await this.prisma.historicalTokenUniverse.updateMany({
      where: { OR: refs.map((ref) => ({ chain: ref.chain, tokenAddress: ref.address })) },
      data: { processingStatus: 'pending', nextRetryAt: null, lastError: null }
    });
    if (!result.count) throw new Error('Token nije u historical discovery univerzumu');
    return result.count;
  }

  async createSession(userId: string, chatId: string, workflow: OperatorWorkflow, state: OperatorSessionState, ttlMinutes = 60) {
    return this.prisma.operatorSession.create({ data: { userId, chatId, workflow, stateJson: json(state), expiresAt: new Date(Date.now() + Math.max(5, Math.min(ttlMinutes, 24 * 60)) * 60_000) } });
  }

  async getSession(id: string, userId: string, chatId: string): Promise<OperatorSession | null> {
    return this.prisma.operatorSession.findFirst({ where: { id, userId, chatId, expiresAt: { gt: new Date() } } });
  }

  async updateSession(id: string, userId: string, chatId: string, state: OperatorSessionState) {
    const result = await this.prisma.operatorSession.updateMany({ where: { id, userId, chatId, expiresAt: { gt: new Date() } }, data: { stateJson: json(state) } });
    return result.count === 1;
  }

  async getCursor(botKey: string) { return (await this.prisma.telegramBotCursor.findUnique({ where: { botKey } }))?.nextUpdateId ?? 0n; }
  async setCursor(botKey: string, nextUpdateId: bigint) { await this.prisma.telegramBotCursor.upsert({ where: { botKey }, create: { botKey, nextUpdateId }, update: { nextUpdateId } }); }

  async exportWorkflow(workflow: OperatorWorkflow, state: OperatorSessionState, format: 'csv' | 'json') {
    let value: unknown;
    if (workflow === 'wallet') value = await this.walletSummary(requiredTarget(state));
    else if (workflow === 'token') value = await this.tokenSummary(requiredTarget(state), 1, 1_000);
    else if (workflow === 'profitable') value = await this.profitable({ chain: state.chain, sort: state.sort, page: 1, pageSize: 1_000 });
    else if (workflow === 'entity') value = await this.entity(requiredTarget(state));
    else if (workflow === 'flow') value = await this.flows(requiredTarget(state), 1, 1_000);
    else if (workflow === 'bridges') value = await this.bridges(requiredTarget(state), 1, 1_000);
    else value = await this.recent(1, 1_000);
    const rows = exportRows(value);
    return { filename: `flowradar-${workflow}-${Date.now()}.${format}`, mimeType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json', content: format === 'csv' ? toCsv(rows) : toJsonDocument(value) };
  }

  /** Materializes only relevant watched events. Unique keys make restarts and
   * retries idempotent; observation_only status is never changed. */
  async materializeWatchAlerts(since = new Date(Date.now() - 24 * 60 * 60_000)) {
    const [watches, activations] = await Promise.all([
      this.prisma.operatorWatch.findMany({ where: { active: true }, take: 10_000 }),
      this.prisma.trackedTokenActivationAlert.findMany({ where: { status: 'active', activatedAt: { gte: since } }, orderBy: { activatedAt: 'asc' }, take: 10_000 })
    ]);
    let created = 0;
    for (const watch of watches) {
      const target = await this.resolveTarget(watch.targetKey);
      const refs = target.addresses.length ? target.addresses : inferredAddressRefs(watch.targetKey);
      const events = await this.prisma.massTransactionEvent.findMany({ where: { ts: { gte: since }, OR: [...eventAddressWhere(refs), ...(target.entity ? [{ sourceEntityKey: target.entity.entityKey }] : [])], relevanceScore: { gte: 50 } }, orderBy: { ts: 'asc' }, take: 1_000 });
      for (const event of events) {
        const alertType = event.kind.startsWith('bridge_') ? 'bridge_transfer'
          : event.kind === 'token_buy' ? null
            : event.reasonCodes.some((x) => x.includes('dormant')) ? 'dormant_wallet_reactivated'
              : event.enrollmentCandidate ? 'funded_new_wallet'
                : event.relevanceScore >= 80 ? 'high_priority_transfer' : null;
        if (!alertType || !watch.alertTypes.includes(alertType)) continue;
        const result = await this.prisma.operatorWatchAlert.createMany({ data: [{ watchId: watch.id, eventKey: event.eventId, alertType, payloadJson: json({ chain: event.chain, kind: event.kind, source: event.fromAddress, destination: event.toAddress, amountUsd: decimal(event.amountUsd), ts: event.ts.toISOString(), txHash: event.txHash }) }], skipDuplicates: true });
        created += result.count;
      }
      if (watch.alertTypes.includes('receiver_bought_token')) {
        for (const activation of activations) {
          if (activation.alertType !== 'same_cluster_multi_wallet_buy' || activation.trackedWalletCount < 2) continue;
          const watchedAddresses = new Set(refs.filter((ref) => ref.chain === activation.chain).map((ref) => ref.address));
          const entityMatch = target.entity ? activation.entityKeys.includes(target.entity.entityKey) : activation.entityKeys.includes(watch.targetKey);
          const walletMatch = activation.trackedWallets.some((wallet) => watchedAddresses.has(wallet));
          if (!entityMatch && !walletMatch) continue;
          const [token, traces, roles] = await Promise.all([
            this.prisma.token.findUnique({ where: { chain_address: { chain: activation.chain, address: activation.tokenAddress } }, select: { name: true, symbol: true } }),
            this.prisma.massTrackerTrace.findMany({ where: { tokenBought: activation.tokenAddress, terminalWallet: { in: activation.trackedWallets } }, orderBy: { computedAt: 'asc' }, take: 100 }),
            this.prisma.walletFlowRelationship.findMany({
              where: { relatedChain: activation.chain, relatedWallet: { in: activation.trackedWallets } },
              orderBy: { relationshipConfidence: 'desc' }, take: 100,
              select: { sourceWallet: true, relatedWallet: true, role: true, route: true, supportingEvidenceJson: true, tradedTokensJson: true }
            })
          ]);
          const traceEventIds = uniqueStrings([...activation.sourceEventIds, ...traces.flatMap((trace) => trace.eventIds)]);
          const traceEvents = traceEventIds.length ? await this.prisma.massTransactionEvent.findMany({ where: { eventId: { in: traceEventIds } }, orderBy: { ts: 'asc' }, take: 1_000 }) : [];
          const fundingEvents = traceEvents.filter((event) => event.kind === 'native_transfer' || event.kind === 'token_transfer' || event.kind === 'bridge_destination');
          const buyEvents = traceEvents.filter((event) => activation.sourceEventIds.includes(event.eventId));
          const receiverStatus = roles.map((role) => {
            const support = objectJson(role.supportingEvidenceJson);
            const status = support?.freshAtReceipt === true ? 'fresh' : support?.dormantAtReceipt === true ? 'dormant' : role.role;
            return `${role.relatedWallet}:${status}`;
          });
          const result = await this.prisma.operatorWatchAlert.createMany({ data: [{
            watchId: watch.id,
            eventKey: `tracked-activation:${activation.dedupeKey}`,
            alertType: 'receiver_bought_token',
            payloadJson: json({
              token: token?.name ?? token?.symbol ?? activation.tokenAddress,
              symbol: token?.symbol ?? 'unknown', ca: activation.tokenAddress, chain: activation.chain,
              wallets: activation.trackedWallets, clusters: activation.entityKeys,
              fundingPaths: traces.length ? traces.map((trace) => `${trace.sourceWallet}->${trace.terminalWallet} (${trace.route})`) : roles.map((role) => `${role.sourceWallet}->${role.relatedWallet} (${role.route})`),
              amounts: (fundingEvents.length ? fundingEvents : buyEvents).map((event) => decimal(event.amountUsd) != null ? `$${decimal(event.amountUsd)}` : `${event.amountToken} ${event.assetSymbol ?? ''}`.trim()),
              receiverStatus,
              fundingToBuy: traces.length ? traces.map((trace) => `${trace.terminalWallet}:${trace.fundingToBuyDelaySec}s`) : roles.flatMap((role) => parsedTradedTokens(role.tradedTokensJson).filter((item) => item.address === activation.tokenAddress && item.fundingToBuyDelaySec !== null).map((item) => `${role.relatedWallet}:${item.fundingToBuyDelaySec}s`)),
              activationType: activation.alertType, activatedAt: activation.activatedAt.toISOString()
            })
          }], skipDuplicates: true });
          created += result.count;
        }
      }
      if (watch.alertTypes.includes('profit_rotated')) {
        const rotations = await this.prisma.capitalChain.findMany({ where: { kind: 'profit_rotation', computedAt: { gte: since }, OR: [{ sourceEntityKey: target.entity?.entityKey ?? watch.targetKey }, { sourceWallet: { in: refs.map((x) => x.address) } }] }, take: 100 });
        for (const row of rotations) {
          const result = await this.prisma.operatorWatchAlert.createMany({ data: [{ watchId: watch.id, eventKey: row.dedupeKey, alertType: 'profit_rotated', payloadJson: json({ source: row.sourceWallet, tokenBought: row.tokenBought, sourceToken: row.sourceToken, amountUsd: decimal(row.knownValueUsd), ts: row.computedAt.toISOString() }) }], skipDuplicates: true });
          created += result.count;
        }
      }
    }
    return created;
  }

  async pendingWatchAlerts(limit = 100) { return this.prisma.operatorWatchAlert.findMany({ where: { status: { in: ['pending', 'retryable'] } }, include: { watch: true }, orderBy: { createdAt: 'asc' }, take: Math.max(1, Math.min(limit, 1_000)) }); }
  async markWatchAlert(id: string, error?: string) { await this.prisma.operatorWatchAlert.update({ where: { id }, data: error ? { status: 'retryable', lastError: error.slice(0, 1_000) } : { status: 'sent', sentAt: new Date(), lastError: null } }); }

  private async resolveTarget(input: string) {
    const trimmed = input.trim();
    const entity = await this.prisma.unifiedEntity.findFirst({
      where: { OR: [{ entityKey: trimmed }, { addresses: { some: { address: normalizeMaybe(trimmed) } } }] },
      include: { addresses: { orderBy: [{ chain: 'asc' }, { address: 'asc' }] } }
    });
    return { entity, addresses: entity?.addresses.map((x) => ({ chain: x.chain, address: x.address })) ?? [] };
  }
}

function profitableOrder(sort: ProfitableSort) {
  const map: Record<ProfitableSort, string> = {
    pnl: 'COALESCE(local_pnl, provider_pnl) DESC NULLS LAST, confidence DESC, chain, address',
    win_rate: 'win_rate DESC NULLS LAST, confidence DESC, chain, address', ev: 'ev_usd DESC NULLS LAST, confidence DESC, chain, address',
    repeat_runners: 'repeat_runners DESC NULLS LAST, confidence DESC, chain, address', entry_mcap: 'entry_mcap ASC NULLS LAST, confidence DESC, chain, address',
    one_winner: 'one_winner ASC NULLS LAST, confidence DESC, chain, address', dormancy: 'dormancy_count DESC, confidence DESC, chain, address',
    confidence: 'confidence DESC, COALESCE(local_pnl, provider_pnl) DESC NULLS LAST, chain, address'
  };
  return map[sort];
}

function tokenTraderComparator(sort: TokenTraderSort) {
  return (a: { pnl: number | null; roi: number | null; entryMcap: number | null; repeatRunners: number | null; dormancy: number; candidate: { confidence: number; walletAddress: string } }, b: typeof a) => {
    const metric = (row: typeof a): number | null => sort === 'pnl' ? row.pnl : sort === 'roi' ? row.roi : sort === 'entry_mcap' ? row.entryMcap : sort === 'repeat_runners' ? row.repeatRunners : sort === 'dormancy' ? row.dormancy : row.candidate.confidence;
    const av = metric(a); const bv = metric(b);
    if (av == null && bv != null) return 1;
    if (av != null && bv == null) return -1;
    if (av !== bv) return sort === 'entry_mcap' ? (av ?? 0) - (bv ?? 0) : (bv ?? 0) - (av ?? 0);
    return b.candidate.confidence - a.candidate.confidence || a.candidate.walletAddress.localeCompare(b.candidate.walletAddress);
  };
}

function inferredAddressRefs(input: string) {
  const value = input.trim();
  const chains = /^0x[0-9a-fA-F]{40}$/.test(value) ? EVM_CHAINS : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? ['SOLANA' as ChainId] : [];
  return chains.filter((chain) => validAddress(chain, value)).map((chain) => ({ chain, address: normalizeAddress(chain, value) }));
}
function eventAddressWhere(refs: Array<{ chain: ChainId; address: string }>) { return refs.flatMap((x) => [{ chain: x.chain, fromAddress: x.address }, { chain: x.chain, toAddress: x.address }, { chain: x.chain, actorAddress: x.address }]); }
function uniqueRefs(refs: Array<{ chain: ChainId; address: string }>) { return [...new Map(refs.map((x) => [`${x.chain}:${x.address}`, x])).values()]; }
function normalizeMaybe(value: string) { return /^0x/i.test(value) ? value.toLowerCase() : value; }
function boundedPageSize(value: number) { return Math.max(1, Math.min(Math.trunc(value), 1_000)); }
function positive(value: number) { return Math.max(1, Math.trunc(value)); }
function offset(page: number, pageSize: number) { return (positive(page) - 1) * boundedPageSize(pageSize); }
function pageResult<T>(items: T[], page: number, pageSize: number, total: number, coverageWarnings: string[]): OperatorPage<T> { const size = boundedPageSize(pageSize); return { items, page: positive(page), pageSize: size, total, hasNext: offset(page, size) + items.length < total, coverageWarnings }; }
function decimal(value: Prisma.Decimal | number | string | null | undefined) { if (value == null) return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function normalizeConfidence(value: number) { return Math.max(0, Math.min(1, value > 1 ? value / 100 : value)); }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
function providerEntryTime(value: Prisma.JsonValue | null): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>).start_holding_at ?? (value as Record<string, unknown>).first_buy_at;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const date = new Date(raw < 10_000_000_000 ? raw * 1_000 : raw);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof raw === 'string' && raw.length > 0) {
    const numeric = Number(raw);
    const date = Number.isFinite(numeric) ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric) : new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}
function extractPositions(value: Prisma.JsonValue): unknown[] { const profile = value as { local?: { tokenPositions?: unknown[] } }; return Array.isArray(profile?.local?.tokenPositions) ? profile.local.tokenPositions : []; }
function extractDiscoveryMints(value: Prisma.JsonValue | null): string[] { if (!value || typeof value !== 'object') return []; const object = value as Record<string, unknown>; const direct = object.mints; if (Array.isArray(direct)) return direct.filter((x): x is string => typeof x === 'string'); return Object.values(object).flatMap((x) => Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []); }
function dormancyFlags(value: Prisma.JsonValue | undefined) { const text = JSON.stringify(value ?? {}).toLowerCase(); const has = (days: number) => text.includes(`"days":${days}`) || text.includes(`"windowdays":${days}`) ? text.includes('covered_dormant') || text.includes('dormant') : null; return { days7: has(7), days14: has(14), days30: has(30), days90: has(90) }; }
function uniqueFunder(value: { chain: ChainId; address: string; txHash: string }, index: number, all: Array<{ chain: ChainId; address: string; txHash: string }>) { return all.findIndex((x) => x.chain === value.chain && x.address === value.address && x.txHash === value.txHash) === index; }
function uniqueStrings(values: string[]) { return [...new Set(values)]; }
function sumDecimal(values: Array<Prisma.Decimal | null>) { const total = values.reduce<number>((sum, x) => sum + (decimal(x) ?? 0), 0); return total || null; }
function explorerUrl(template: string | undefined, value: string | null) { if (!template || !value) return null; return template.includes('{') ? template.replace(/\{(?:tx|address)\}/g, value) : `${template}${value}`; }
function bridgeDestinationChain(value: Prisma.JsonValue | null): ChainId | null { if (!value || typeof value !== 'object' || Array.isArray(value)) return null; const chain = (value as Record<string, unknown>).destinationChain; return typeof chain === 'string' && ALL_CHAINS.includes(chain as ChainId) ? chain as ChainId : null; }
function firstPathTx(value: Prisma.JsonValue) { if (!Array.isArray(value)) return null; const first = value[0]; return first && typeof first === 'object' && !Array.isArray(first) && typeof (first as Record<string, unknown>).txHash === 'string' ? (first as Record<string, unknown>).txHash as string : null; }
function requiredTarget(state: OperatorSessionState) { if (!state.target) throw new Error('Session target is missing'); return state.target; }
function registryCategory(category: string): AddressCategory {
  if (category === 'PROGRAM' || category === 'SYSTEM') return 'ROUTER';
  if (category === 'BURN') return 'TOKEN_CONTRACT';
  return category as AddressCategory;
}
async function persistObservedTokens(prisma: PrismaClient, events: readonly MassTransactionEvent[], now: Date) {
  const buys = new Map<string, MassTransactionEvent>();
  for (const event of events) {
    if (event.kind !== 'token_buy' || !event.asset.address) continue;
    buys.set(`${event.chain}:${event.asset.address}`, event);
  }
  for (const event of buys.values()) {
    const address = event.asset.address!;
    const label = event.asset.symbol?.trim() || `${address.slice(0, 6)}…${address.slice(-4)}`;
    await prisma.token.upsert({
      where: { chain_address: { chain: event.chain as ChainId, address } },
      create: {
        chain: event.chain as ChainId, address, symbol: label, name: label,
        decimals: event.asset.decimals ?? (event.chain === 'SOLANA' ? 9 : 18),
        firstSeenAt: event.ts, riskFlags: json([])
      },
      update: event.asset.symbol?.trim() ? { symbol: event.asset.symbol.trim() } : { firstSeenAt: event.ts < now ? event.ts : now }
    });
  }
}
function parsedTradedTokens(value: Prisma.JsonValue): Array<{ address: string; firstBuyTs: string; fundingToBuyDelaySec: number | null }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.tokenAddress !== 'string' || typeof row.firstBuyTs !== 'string') return [];
    return [{ address: row.tokenAddress, firstBuyTs: row.firstBuyTs, fundingToBuyDelaySec: finiteJsonNumber(row.fundingToBuyDelaySec) }];
  });
}
function objectJson(value: Prisma.JsonValue): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function finiteJsonNumber(value: unknown): number | null {
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}
function transactionExplorer(chain: ChainId, txHash: string) {
  const bases: Record<ChainId, string> = {
    SOLANA: 'https://solscan.io/tx/', ETHEREUM: 'https://etherscan.io/tx/', BASE: 'https://basescan.org/tx/',
    ARBITRUM: 'https://arbiscan.io/tx/', BSC: 'https://bscscan.com/tx/'
  };
  return `${bases[chain]}${txHash}`;
}
function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
function nonNull<T>(value: T | null | undefined): value is T { return value !== null && value !== undefined; }
function exportRows(value: unknown): Record<string, unknown>[] { if (value && typeof value === 'object') { const object = value as Record<string, unknown>; if (Array.isArray(object.items)) return object.items.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object')); if (object.topPnl && typeof object.topPnl === 'object' && Array.isArray((object.topPnl as Record<string, unknown>).items)) return (object.topPnl as { items: Record<string, unknown>[] }).items; return [object]; } return [{ value }]; }
