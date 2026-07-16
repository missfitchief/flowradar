import { Prisma, type AddressCategory, type ChainId, type MassTransactionEvent as PersistedMassTransactionEvent, type OperatorSession, type PrismaClient } from '@prisma/client';
import {
  CORE_ALERT_POLICY_VERSION, CORE_CONFLUENCE_WINDOW_MS, MAX_PUSH_EVENT_AGE_MS, MIN_PUSH_ALERT_SCORE,
  MIN_PUSH_CONFIDENCE, MIN_QUALIFYING_BUY_USD, evaluateCoreBuyWindow, evaluateCorePushEligibility,
  validateCorePushPayload, type CoreBuyAuditDecision, type CoreBuyCandidate, type CorePushDecision,
  type MassTransactionEvent
} from '@flowradar/core';
import type { WalletBridgeScanProvider, WalletCapitalScanProvider } from '@flowradar/providers';
import { normalizeAddress, runUnifiedProfitableWalletDiscovery, validAddress, type HistoricalTraderProvider } from '../discovery/unified';
import { WalletInvestigationService } from '../investigation/walletInvestigation';
import type { WalletInvestigationResult } from '../investigation/types';
import { analyzeTokenWalletIntelligence } from '../intelligence/token';
import { expandWalletCapitalGraph } from '../intelligence/walletFlows';
import { enrollObservationWallet } from '../intelligence/monitoring';
import { createMassTrackerSession } from '../tracker/massTracker';
import { recordProviderHealth } from '../operations/production';
import { syncAlchemyCoreWalletChange } from '../alchemy/subscriptions';
import { toCsv, toJsonDocument } from './export';
import { RAW_TOKEN_CANDIDATE_LIMIT, rankingReceiptFromJson, refreshTokenCandidateRanking, reportFromReceipts } from './tokenCandidateRanking';
import type {
  AlertInboxFilter, AlertInboxItem, BridgeRow, CapitalFlowRow, CoreWalletActivityRow, CoreWalletCapitalRow,
  CoreWalletListItem, OperatorPage, OperatorSessionState, OperatorWorkflow, ProfitableSort, ProfitableWalletRow,
  TokenTraderSort, WalletCapitalRelation, WalletCapitalSummary, WalletSummary
} from './types';

const ALL_CHAINS: ChainId[] = ['SOLANA', 'ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'];
const EVM_CHAINS: ChainId[] = ['ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'];
const DEFAULT_ALERTS = ['funded_new_wallet', 'bridge_transfer', 'dormant_wallet_reactivated', 'receiver_bought_token', 'profit_rotated', 'high_priority_transfer', 'probable_side_wallet_discovered'];
const CORE_ALERTS = ['dormant_wallet_reactivated', 'core_multi_wallet_buy', 'independent_entity_confluence'];
const PENDING_WORKFLOWS: OperatorWorkflow[] = ['wallet', 'token', 'entity', 'flow', 'bridges', 'core_add', 'core_remove'];
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

  recordDeliveryHealth(input: { outcome: 'success' | 'error' | 'rate_limited' | 'timeout'; latencyMs: number; scope?: string; error?: unknown }) {
    return recordProviderHealth(this.prisma, {
      provider: 'telegram_api', capability: 'alert_dispatch', ...input
    });
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
    if (!dnaRows.length) warnings.push('Wallet DNA is unavailable or coverage is insufficient.');
    if (dnaRows.some((x) => x.coverage !== 'full')) warnings.push('Profitability is based on partial local coverage.');
    if (target.entity && target.entity.chains.length > 1) warnings.push('Cross-chain entity links are probabilistic on-chain evidence, not identity claims.');
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
    if (!refs.length) throw new Error('Invalid wallet address');
    const scanner = this.options.walletCapitalScanner;
    if (!scanner) throw new Error('Live wallet capital scanner is not configured');
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
    if (!refs.length) throw new Error('Invalid wallet address');
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
    if (!inferred.length) throw new Error('Invalid token contract address');
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
        // Exact operator scans deliberately refresh the candidate window. A
        // previously processed row must not turn the provider top-50 into a
        // permanent cache entry.
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
      perTokenLocalCap: RAW_TOKEN_CANDIDATE_LIMIT,
      perTokenProviderCap: RAW_TOKEN_CANDIDATE_LIMIT,
      maxTradesPerToken: 100_000,
      requestBudget: Object.keys(providers).length,
      retryUnavailable: true,
      providers,
      buildDna: false,
      forceProviderRefresh: true,
      now
    });
    let candidateCount = 0;
    const rankings = [];
    for (const ref of refs) {
      const count = await this.prisma.tokenTopPnlCandidate.count({ where: { chain: ref.chain, mint: ref.address, validation: { not: 'invalid' } } });
      candidateCount += count;
      if (count > 0) await analyzeTokenWalletIntelligence(this.prisma, { chain: ref.chain, tokenAddress: ref.address, topLimit: RAW_TOKEN_CANDIDATE_LIMIT, now });
      rankings.push({ chain: ref.chain, ...(await refreshTokenCandidateRanking(this.prisma, { chain: ref.chain, tokenAddress: ref.address, now })) });
    }
    return { chains: refs.map((ref) => ref.chain), candidateCount, rankings };
  }

  async tokenSummary(addressInput: string, page = 1, pageSize = 10, sort: TokenTraderSort = 'pnl') {
    const refs = inferredAddressRefs(addressInput);
    const normalized = refs.map((x) => x.address);
    const metadataRefs = tokenMetadataAddressWhere(refs);
    const [tokens, metadata, universe, candidates] = await Promise.all([
      this.prisma.token.findMany({ where: { address: { in: normalized } }, take: 10, include: { marketSnapshots: { orderBy: { ts: 'desc' }, take: 1 } } }),
      this.prisma.tokenMetadata.findMany({ where: { OR: metadataRefs }, take: 10 }),
      this.prisma.historicalTokenUniverse.findMany({ where: { tokenAddress: { in: normalized } }, take: 10 }),
      this.prisma.tokenTopPnlCandidate.findMany({ where: { mint: { in: normalized } }, orderBy: [{ updatedAt: 'desc' }, { providerRank: 'asc' }, { walletAddress: 'asc' }], take: 5_000 })
    ]);
    const receiptByWallet = new Map<string, ReturnType<typeof rankingReceiptFromJson>>();
    for (const candidate of candidates) {
      const receipt = rankingReceiptFromJson(candidate.receiptsJson);
      if (!receipt) continue;
      const key = `${candidate.chain}:${candidate.walletAddress}`;
      if (!receiptByWallet.has(key)) receiptByWallet.set(key, receipt);
    }
    const receipts = [...receiptByWallet.values()].filter(nonNull);
    const selection = reportFromReceipts(receipts);
    const traderCandidates = selection.topWallets.map((row) => ({
      chain: row.chain, walletAddress: row.walletAddress, providerRank: row.providerRank,
      source: 'validated_local_intelligence', validation: row.walletClassification,
      realizedPnlUsd: row.realizedPnlUsd, boughtUsd: row.capitalInUsd, soldUsd: row.capitalOutUsd,
      remainingPositionUsd: null, claimedRealizedPnlUsd: null, roi: row.validatedRoi,
      medianRoi: row.medianRoi, entryMcapUsd: null, repeatRunnerCount: null, dormancyReactivations: 0,
      firstBuyTs: row.firstEntryTs, firstSellTs: null, lastActivityTs: row.lastRelevantActivityTs,
      qualityScore: row.sampleAdjustedAlpha, rawAlpha: row.rawAlpha, alphaConfidence: row.alphaConfidence,
      alphaSampleSize: row.sampleSize, winRate: row.winRate, status: row.status,
      intelligenceReason: row.intelligenceReason,
      relatedWalletCount: row.relatedWalletCount, finalRankingScore: row.finalRankingScore,
      dormancy: null, confidence: row.classificationConfidence, coverage: row.pnlConfidence,
      entityKey: row.entityKey, role: row.walletClassification
    }));
    const start = offset(page, pageSize);
    const pageCandidates = traderCandidates.slice(start, start + boundedPageSize(pageSize));
    const warnings: string[] = [];
    if (!tokens.length) warnings.push('No canonical token record exists; only available discovery evidence is shown.');
    if (!pageCandidates.length) warnings.push('No validated trader wallets found.');
    if (universe.some((x) => x.processingStatus === 'unavailable' || x.processingStatus === 'retryable')) warnings.push('Discovery coverage is incomplete or retryable; no result was inferred.');
    return {
      tokens: tokens.map((token) => ({ chain: token.chain, address: token.address, name: token.name, symbol: token.symbol, decimals: token.decimals, latestMcapUsd: decimal(token.marketSnapshots[0]?.marketCapUsd), latestMcapTs: token.marketSnapshots[0]?.ts.toISOString() ?? null })),
      metadata: metadata.map((x) => ({ chain: x.chain, name: x.name, symbol: x.symbol, source: x.source, availability: x.availability })),
      universe: universe.map((x) => ({ chain: x.chain, sources: x.sources, historicalWinnerStatus: x.historicalWinnerStatus, athMcapUsd: decimal(x.athMcapUsd), coverage: x.coverage, processingStatus: x.processingStatus })),
      topPnl: pageResult(pageCandidates, page, pageSize, traderCandidates.length, warnings),
      candidateSelection: selection,
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
    const warnings = ['Provider-reported PnL is discovery evidence; locally verified realized PnL takes precedence.', 'Automatically discovered wallets remain observation-only.'];
    return pageResult(rows.map((row) => ({
      chain: row.chain, address: row.address, entityKey: row.entity_key, role: row.role ?? 'unknown_related_wallet', validation: row.validation,
      localRealizedPnlUsd: decimal(row.local_pnl), providerClaimedPnlUsd: decimal(row.provider_pnl), winRate: row.win_rate, evUsd: row.ev_usd,
      repeatRunnerCount: row.repeat_runners, medianEntryMcapUsd: decimal(row.entry_mcap), oneWinnerDependence: row.one_winner,
      dormancyReactivations: Number(row.dormancy_count), confidence: normalizeConfidence(row.confidence), coverage: row.coverage
    })), page, pageSize, total, warnings);
  }

  async entity(targetInput: string) {
    const target = await this.resolveTarget(targetInput);
    if (!target.entity) return { entityKey: null, addresses: [], coverageWarnings: ['No unified entity was found for this key or address.'] };
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
      coverageWarnings: ['Entity links are evidence-backed and probabilistic; they do not identify a person.']
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
    return pageResult(rows.slice(start, start + boundedPageSize(pageSize)), page, pageSize, rows.length, ['CEX paths remain possible correlations; a CEX never establishes downstream ownership without independent evidence.']);
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
    return pageResult(rows, page, pageSize, total, ['Only verified official bridge pairs can carry an entity link across chains.']);
  }

  async recent(page = 1, pageSize = 10) {
    const where = { relevanceCategory: { in: ['capital_transfer', 'gas_funding', 'token_deployment', 'bridge_verified', 'bridge_unverified'] } };
    const [total, events] = await Promise.all([
      this.prisma.massTransactionEvent.count({ where }),
      this.prisma.massTransactionEvent.findMany({ where, orderBy: [{ ts: 'desc' }, { eventId: 'desc' }], skip: offset(page, pageSize), take: boundedPageSize(pageSize) })
    ]);
    return pageResult(events.map((x) => ({ eventId: x.eventId, chain: x.chain, kind: x.kind, source: x.fromAddress, destination: x.toAddress, amountUsd: decimal(x.amountUsd), category: x.relevanceCategory, score: x.relevanceScore, ts: x.ts.toISOString(), txHash: x.txHash })), page, pageSize, total, []);
  }

  async addCoreWallet(userId: string, chatId: string, addressInput: string, label?: string) {
    const refs = uniqueRefs(inferredAddressRefs(addressInput));
    if (!refs.length) throw new Error('Send a valid Solana or EVM wallet address.');
    const now = new Date();
    const targetKey = refs[0].address;
    const roots: string[] = [];
    for (const ref of refs) {
      const enrollment = await enrollObservationWallet(this.prisma, {
        chain: ref.chain, address: ref.address, role: 'root_main', reason: 'telegram_core_wallet', now
      });
      const existingRoot = await this.prisma.lineageRoot.findUnique({ where: { walletId: enrollment.wallet.id } });
      const root = existingRoot ?? await this.prisma.lineageRoot.create({
        data: {
          walletId: enrollment.wallet.id, source: 'telegram_core', label: label?.trim() || null,
          fileProvenance: 'telegram:/add', permanent: true, firstImportedAt: now, lastSeenInImportAt: now
        }
      });
      if (existingRoot) {
        await this.prisma.lineageRoot.update({
          where: { id: root.id },
          data: { lastSeenInImportAt: now, ...(label?.trim() ? { label: label.trim() } : {}) }
        });
      }
      await this.prisma.monitoringSubscription.update({
        where: { walletId_priority: { walletId: enrollment.wallet.id, priority: 'root_permanent' } },
        data: { active: true, lineageRootId: root.id, nextPollAt: now, consecutiveErrors: 0, tierPriority: -1, reason: 'telegram_core_wallet' }
      });
      if (ref.chain === 'SOLANA') {
        await this.prisma.lineageExpansionNode.upsert({
          where: { lineageRootId_walletAddress: { lineageRootId: root.id, walletAddress: ref.address } },
          create: { lineageRootId: root.id, walletAddress: ref.address, chain: ref.chain, depth: 0, priority: 'first_funder', status: 'pending', discoveredVia: 'telegram_core:/add' },
          update: { status: 'pending', stopReason: null, discoveredVia: 'telegram_core:/add' }
        });
      }
      roots.push(root.id);
    }
    const watch = await this.prisma.operatorWatch.upsert({
      where: { userId_chatId_targetType_targetKey: { userId, chatId, targetType: 'core_wallet', targetKey } },
      create: { userId, chatId, targetType: 'core_wallet', targetKey, chain: refs.length === 1 ? refs[0].chain : null, alertTypes: CORE_ALERTS, active: true },
      update: { alertTypes: CORE_ALERTS, active: true }
    });
    const alchemySubscriptionSync = await syncAlchemyCoreWalletChange(this.prisma, refs, 'add');
    return { watch, roots, refs, alchemySubscriptionSync };
  }

  async queueCoreHistoricalSync(userId: string, chatId: string, target: string) {
    return this.createSession(userId, chatId, 'wallet', {
      target: normalizeMaybe(target), page: 1, pageSize: 5, investigationStatus: 'queued', silentCoreSync: true
    }, 24 * 60);
  }

  async removeCoreWallet(userId: string, chatId: string, addressInput: string) {
    const refs = uniqueRefs(inferredAddressRefs(addressInput));
    if (!refs.length) throw new Error('Send a valid Solana or EVM wallet address.');
    const targetKey = refs[0].address;
    const removed = await this.prisma.operatorWatch.updateMany({
      where: { userId, chatId, targetType: 'core_wallet', targetKey, active: true }, data: { active: false }
    });
    if (!removed.count) throw new Error('This wallet is not in your Core list.');
    const remaining = await this.prisma.operatorWatch.count({ where: { targetType: 'core_wallet', targetKey, active: true } });
    if (!remaining) {
      for (const ref of refs) {
        const wallet = await this.prisma.wallet.findUnique({
          where: { address_chain: { address: ref.address, chain: ref.chain } },
          include: { lineageRoot: true }
        });
        if (!wallet?.lineageRoot) continue;
        await this.prisma.monitoringSubscription.updateMany({
          where: { lineageRootId: wallet.lineageRoot.id }, data: { active: false, claimedAt: null }
        });
        const stillActive = await this.prisma.monitoringSubscription.count({ where: { walletId: wallet.id, active: true } });
        if (!stillActive) await this.prisma.wallet.update({ where: { id: wallet.id }, data: { isWatched: false } });
      }
    }
    await syncAlchemyCoreWalletChange(this.prisma, refs, 'remove');
    return removed.count;
  }

  async ensureCoreWalletWatches(userId: string, chatId: string) {
    const roots = await this.prisma.lineageRoot.findMany({
      where: { permanent: true, subscriptions: { some: { active: true, priority: 'root_permanent' } } },
      select: { id: true, wallet: { select: { address: true, chain: true } } }, orderBy: { firstImportedAt: 'asc' }
    });
    if (roots.length) {
      await this.prisma.monitoringSubscription.updateMany({
        where: { lineageRootId: { in: roots.map((root) => root.id) }, priority: 'root_permanent', active: true },
        // Operator-managed Core roots must not starve behind a large fresh-
        // receiver backlog. Receiver tiers retain their normal rank.
        data: { tierPriority: -1 }
      });
    }
    const byAddress = new Map<string, typeof roots>();
    for (const root of roots) {
      const bucket = byAddress.get(root.wallet.address) ?? [];
      bucket.push(root); byAddress.set(root.wallet.address, bucket);
    }
    let created = 0;
    for (const [targetKey, addressRoots] of byAddress) {
      const existing = await this.prisma.operatorWatch.findUnique({
        where: { userId_chatId_targetType_targetKey: { userId, chatId, targetType: 'core_wallet', targetKey } }, select: { id: true }
      });
      if (existing) continue;
      await this.prisma.operatorWatch.create({ data: {
        userId, chatId, targetType: 'core_wallet', targetKey,
        chain: addressRoots.length === 1 ? addressRoots[0].wallet.chain : null,
        alertTypes: CORE_ALERTS, active: true
      } });
      created += 1;
    }
    return created;
  }

  async listCoreWallets(userId: string, chatId: string, page = 1, pageSize = 5): Promise<OperatorPage<CoreWalletListItem>> {
    await this.ensureCoreWalletWatches(userId, chatId);
    const size = Math.max(1, Math.min(10, boundedPageSize(pageSize)));
    const where = { userId, chatId, targetType: 'core_wallet', active: true };
    const [total, watches] = await Promise.all([
      this.prisma.operatorWatch.count({ where }),
      this.prisma.operatorWatch.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { targetKey: 'asc' }], skip: offset(page, size), take: size })
    ]);
    const items = await Promise.all(watches.map((watch) => this.coreWalletItem(watch.targetKey)));
    return pageResult(items, page, size, total, []);
  }

  async coreWalletAt(userId: string, chatId: string, index: number) {
    const watch = await this.prisma.operatorWatch.findFirst({
      where: { userId, chatId, targetType: 'core_wallet', active: true },
      orderBy: [{ updatedAt: 'desc' }, { targetKey: 'asc' }], skip: Math.max(0, Math.trunc(index)), take: 1
    });
    return watch ? this.coreWalletItem(watch.targetKey) : null;
  }

  async coreWalletDetail(userId: string, chatId: string, addressInput: string) {
    const targetKey = normalizeMaybe(addressInput.trim());
    const watch = await this.prisma.operatorWatch.findUnique({
      where: { userId_chatId_targetType_targetKey: { userId, chatId, targetType: 'core_wallet', targetKey } }
    });
    if (!watch?.active) throw new Error('This wallet is not in your Core list.');
    return this.coreWalletItem(targetKey);
  }

  async coreWalletActivity(addressInput: string, page = 1, pageSize = 8): Promise<OperatorPage<CoreWalletActivityRow>> {
    const refs = uniqueRefs(inferredAddressRefs(addressInput));
    if (!refs.length) throw new Error('Invalid Core wallet address.');
    const where = { OR: eventAddressWhere(refs) };
    const size = Math.max(1, Math.min(10, boundedPageSize(pageSize)));
    const [total, events] = await Promise.all([
      this.prisma.massTransactionEvent.count({ where }),
      this.prisma.massTransactionEvent.findMany({ where, orderBy: [{ ts: 'desc' }, { eventId: 'desc' }], skip: offset(page, size), take: size })
    ]);
    const refSet = new Set(refs.map((ref) => `${ref.chain}:${ref.address}`));
    const items = events.map((event): CoreWalletActivityRow => {
      const actorIsCore = event.actorAddress ? refSet.has(`${event.chain}:${event.actorAddress}`) : false;
      const fromCore = refSet.has(`${event.chain}:${event.fromAddress}`);
      const toCore = refSet.has(`${event.chain}:${event.toAddress}`);
      const direction: CoreWalletActivityRow['direction'] = event.kind === 'token_buy' && actorIsCore ? 'bought'
        : event.kind === 'token_sell' && actorIsCore ? 'sold' : fromCore && !toCore ? 'sent' : toCore && !fromCore ? 'received' : 'activity';
      return {
        eventId: event.eventId, chain: event.chain, kind: event.kind, direction,
        counterparty: direction === 'sent' ? event.toAddress : direction === 'received' ? event.fromAddress : null,
        token: event.assetSymbol ?? event.assetAddress ?? (event.chain === 'SOLANA' ? 'SOL' : event.chain === 'BSC' ? 'BNB' : 'ETH'),
        amount: event.amountToken, amountUsd: decimal(event.amountUsd), ts: event.ts.toISOString(), txHash: event.txHash
      };
    });
    return pageResult(items, page, size, total, []);
  }

  async coreWalletCapital(addressInput: string, page = 1, pageSize = 5): Promise<OperatorPage<CoreWalletCapitalRow>> {
    const refs = uniqueRefs(inferredAddressRefs(addressInput));
    if (!refs.length) throw new Error('Invalid Core wallet address.');
    const where = { OR: refs.map((ref) => ({ sourceChain: ref.chain, sourceWallet: ref.address })) };
    const size = Math.max(1, Math.min(5, boundedPageSize(pageSize)));
    const [total, rows] = await Promise.all([
      this.prisma.walletFlowRelationship.count({ where }),
      this.prisma.walletFlowRelationship.findMany({
        where, orderBy: [{ safeEntityLink: 'desc' }, { relationshipConfidence: 'desc' }, { lastTransferTs: 'desc' }],
        skip: offset(page, size), take: size
      })
    ]);
    const items = rows.map((row): CoreWalletCapitalRow => ({
      sourceChain: row.sourceChain, source: row.sourceWallet, destinationChain: row.relatedChain, destination: row.relatedWallet,
      route: row.route, confidence: normalizeConfidence(row.relationshipConfidence), amountUsd: finiteJsonNumber(objectJson(row.supportingEvidenceJson)?.knownAmountUsd),
      firstTransfer: row.firstTransferTs.toISOString(), lastTransfer: row.lastTransferTs.toISOString(),
      tokenBuys: parsedTradedTokens(row.tradedTokensJson).map((token) => token.address).slice(0, 5)
    }));
    return pageResult(items, page, size, total, []);
  }

  private async coreWalletItem(targetKey: string): Promise<CoreWalletListItem> {
    const refs = uniqueRefs(inferredAddressRefs(targetKey));
    const [wallets, profiles, seed, unified] = await Promise.all([
      this.prisma.wallet.findMany({
        where: { OR: refs.map((ref) => ({ chain: ref.chain, address: ref.address })) },
        include: { lineageRoot: true, monitoringSubscriptions: { where: { active: true }, orderBy: { tierPriority: 'asc' }, take: 1 } }
      }),
      this.prisma.walletIntelligenceProfile.findMany({
        where: { OR: refs.map((ref) => ({ chain: ref.chain, address: ref.address })) },
        include: { entityMemberships: { where: { status: { not: 'rejected' }, entity: { status: 'active' } }, include: { entity: true }, orderBy: { confidence: 'desc' }, take: 1 } }
      }),
      this.prisma.coreWalletSeedRecord.findFirst({ where: { address: targetKey, decision: 'accepted' }, orderBy: { sourceScore: 'desc' } }),
      this.prisma.unifiedEntityAddress.findFirst({ where: { address: targetKey }, include: { entity: true }, orderBy: { confidence: 'desc' } })
    ]);
    const lastActivity = latestIso([
      ...wallets.map((wallet) => wallet.lastActiveAt), ...profiles.map((profile) => profile.lastActivityAt).filter(nonNull)
    ]);
    const latestMs = lastActivity ? new Date(lastActivity).getTime() : 0;
    const label = wallets.find((wallet) => wallet.lineageRoot?.label)?.lineageRoot?.label
      ?? seed?.sourceLabel ?? profiles.flatMap((profile) => profile.entityMemberships.map((membership) => membership.entity.label))[0]
      ?? 'Core wallet';
    const priority = wallets.flatMap((wallet) => wallet.monitoringSubscriptions.map((subscription) => subscription.priority))[0]
      ?? profiles.sort((a, b) => a.monitoringPriority.localeCompare(b.monitoringPriority))[0]?.monitoringPriority ?? 'inactive';
    const eventCount = refs.length ? await this.prisma.massTransactionEvent.count({ where: { OR: eventAddressWhere(refs) } }) : 0;
    return {
      address: targetKey, chains: refs.map((ref) => ref.chain), label,
      status: latestMs && Date.now() - latestMs <= 30 * 86_400_000 ? 'Active' : 'Dormant',
      historicalAlpha: maxOrNull(profiles.map((profile) => profile.historicalAlphaScore)),
      evidence: maxOrNull(profiles.map((profile) => profile.evidenceScore)), lastActivity,
      monitoringPriority: priority, eventCount,
      entity: profiles.flatMap((profile) => profile.entityMemberships.map((membership) => membership.entity.label))[0] ?? unified?.entity.entityKey ?? null
    };
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
    const metadataRefs = tokenMetadataAddressWhere(refs);
    const candidateMintRefs = refs.map((ref) => ({ chain: ref.chain, mint: ref.address }));
    const universeRefs = refs.map((ref) => ({ chain: ref.chain, tokenAddress: ref.address }));
    const tokenEventRefs: Prisma.MassTransactionEventWhereInput[] = refs.map((ref) => ({ chain: ref.chain, assetAddress: ref.address }));
    const walletRefs = refs.map((ref) => ({ chain: ref.chain, address: ref.address }));
    const candidateWalletRefs = refs.map((ref) => ({ chain: ref.chain, walletAddress: ref.address }));
    const [tokens, metadata, universe, candidateMints, tokenEvents, wallets, entityAddresses, candidateWallets, walletEvents] = await Promise.all([
      this.prisma.token.count({ where: { OR: tokenRefs } }),
      this.prisma.tokenMetadata.count({ where: { OR: metadataRefs } }),
      this.prisma.historicalTokenUniverse.count({ where: { OR: universeRefs } }),
      this.prisma.tokenTopPnlCandidate.count({ where: { OR: candidateMintRefs } }),
      this.prisma.massTransactionEvent.count({ where: { OR: tokenEventRefs } }),
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
    if (!refs.length) throw new Error('Invalid token contract address');
    const result = await this.prisma.historicalTokenUniverse.updateMany({
      where: { OR: refs.map((ref) => ({ chain: ref.chain, tokenAddress: ref.address })) },
      data: { processingStatus: 'pending', nextRetryAt: null, lastError: null }
    });
    if (!result.count) throw new Error('Token is not in the historical discovery universe');
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

  async pendingWalletInvestigationSessions(limit = 20) {
    return this.prisma.operatorSession.findMany({
      where: {
        workflow: 'wallet',
        expiresAt: { gt: new Date() },
        OR: [
          { stateJson: { path: ['investigationStatus'], equals: 'queued' } },
          { stateJson: { path: ['investigationStatus'], equals: 'running' } }
        ]
      },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(Math.trunc(limit), 100))
    });
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
    let created = await this.materializeCoreWalletAlerts(watches.filter((watch) => watch.targetType === 'core_wallet'), activations, since);
    for (const watch of watches.filter((candidate) => candidate.targetType !== 'core_wallet')) {
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
      if (watch.alertTypes.includes('dormant_wallet_reactivated')) {
        const dormantEvents = await this.prisma.walletIntelligenceEvent.findMany({
          where: {
            eventType: 'Dormant Wallet Awakened', occurredAt: { gte: since },
            OR: [
              ...(refs.length ? [{ OR: refs.map((ref) => ({ chain: ref.chain, walletAddress: ref.address })) }] : []),
              { clusterKey: watch.targetKey },
              ...(target.entity ? [{ profile: { entityKey: target.entity.entityKey } }] : [])
            ]
          },
          include: { profile: { include: { cluster: true, entityMemberships: { where: { scope: 'core', status: { not: 'rejected' }, entity: { status: 'active' } }, include: { entity: true }, take: 1 } } } }, orderBy: { occurredAt: 'asc' }, take: 1_000
        });
        for (const event of dormantEvents) {
          const result = await this.prisma.operatorWatchAlert.createMany({ data: [{
            watchId: watch.id,
            eventKey: `intelligence-dormant:${event.eventKey}`,
            alertType: 'dormant_wallet_reactivated',
            payloadJson: json({
              title: 'Dormant Wallet Awakened', chain: event.chain, wallet: event.walletAddress,
              cluster: event.profile.cluster.clusterKey,
              entity: event.profile.entityMemberships[0]?.entity.label ?? event.profile.entityKey,
              entityId: event.profile.entityMemberships[0]?.entityId ?? null,
              coreWallet: event.profile.entityMemberships[0]?.scope === 'core', role: event.profile.role,
              sourceScore: event.profile.sourceScore, evidenceScore: event.profile.evidenceScore,
              rawHistoricalAlphaScore: event.profile.rawHistoricalAlphaScore,
              sampleAdjustedHistoricalAlphaScore: event.profile.sampleAdjustedAlphaScore,
              alphaConfidence: event.profile.alphaConfidence, alphaSampleSize: event.profile.alphaSampleSize,
              historicalAlphaScore: event.profile.historicalAlphaScore,
              wakeUpPotential: event.profile.wakeUpPotential, confidence: event.profile.confidence,
              intelligenceStatus: event.profile.intelligenceStatus,
              preWakeDormancy: objectJson(event.evidenceJson)?.dormantDays ?? null,
              sourceEventId: event.sourceEventId, txHash: event.txHash, tokenAddress: event.tokenAddress,
              occurredAt: event.occurredAt.toISOString(), evidence: event.evidenceJson
            })
          }], skipDuplicates: true });
          created += result.count;
        }
      }
      if (watch.alertTypes.includes('receiver_bought_token')) {
        for (const activation of activations) {
          if ((activation.alertType !== 'same_cluster_multi_wallet_buy' && !activation.alertType.startsWith('cluster_intelligence_')) || activation.trackedWalletCount < 2) continue;
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
          const activationEvidence = objectJson(activation.evidenceJson);
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
              activationType: activation.alertType, activatedAt: activation.activatedAt.toISOString(),
              explanation: activationEvidence?.explanation ?? null,
              reasons: activationEvidence?.reasons ?? [],
              intelligenceSignalId: activationEvidence?.intelligenceSignalId ?? null,
              qualityAssessmentId: activationEvidence?.qualityAssessmentId ?? null,
              evidence: activationEvidence
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

  private async materializeCoreWalletAlerts(
    watches: Awaited<ReturnType<PrismaClient['operatorWatch']['findMany']>>,
    _activations: Awaited<ReturnType<PrismaClient['trackedTokenActivationAlert']['findMany']>>,
    since: Date
  ) {
    let created = 0;
    if (watches.length) {
      await this.prisma.operatorWatchAlert.updateMany({
        where: {
          watchId: { in: watches.map((watch) => watch.id) }, status: { in: ['pending', 'retryable', 'update_pending'] },
          OR: [
            { alertType: { in: ['core_wallet_token_buy', 'connected_core_receiver_buy', 'independent_entity_confluence'] } },
            { alertType: 'core_multi_wallet_buy', NOT: { eventKey: { startsWith: 'core-confluence-v3:' } } }
          ]
        },
        data: { status: 'rejected', lastError: 'superseded_by_core_confluence_v3' }
      });
    }
    const refsByWatch = new Map<string, ReturnType<typeof inferredAddressRefs>>();
    const connectedByWatch = new Map<string, Array<{ chain: ChainId; address: string; route: string; confidence: number; source: string }>>();
    for (const watch of watches) {
      const refs = inferredAddressRefs(watch.targetKey);
      refsByWatch.set(watch.id, refs);
      const relationships = refs.length ? await this.prisma.walletFlowRelationship.findMany({
        where: {
          AND: [
            { OR: refs.map((ref) => ({ sourceChain: ref.chain, sourceWallet: ref.address })) },
            { role: { not: 'service_router_cex_node' } },
            { OR: [
              { route: 'exact_bridge', safeEntityLink: true },
              { route: 'direct_transfer', transferCount: { gte: 1 } }
            ] }
          ]
        },
        orderBy: [{ relationshipConfidence: 'desc' }, { lastTransferTs: 'desc' }], take: 10_000
      }) : [];
      const connected = uniqueConnected(relationships.map((row) => ({
        chain: row.relatedChain, address: row.relatedWallet, route: row.route,
        confidence: normalizeConfidence(row.relationshipConfidence), source: row.sourceWallet
      })));
      connectedByWatch.set(watch.id, connected);

      if (watch.alertTypes.includes('dormant_wallet_reactivated') && refs.length) {
        const dormant = await this.prisma.walletIntelligenceEvent.findMany({
          where: {
            eventType: 'Dormant Wallet Awakened', occurredAt: { gte: maxDate(since, watch.updatedAt) },
            OR: refs.map((ref) => ({ chain: ref.chain, walletAddress: ref.address }))
          }, orderBy: { occurredAt: 'asc' }, take: 10_000
        });
        for (const event of dormant) {
          const result = await this.prisma.operatorWatchAlert.createMany({ data: [{
            watchId: watch.id, eventKey: `core-dormant:${event.eventKey}`, alertType: 'dormant_wallet_reactivated',
            payloadJson: json({ title: 'Dormant Wallet Awakened', wallet: event.walletAddress, chain: event.chain, occurredAt: event.occurredAt.toISOString(), txHash: event.txHash, evidence: event.evidenceJson })
          }], skipDuplicates: true });
          created += result.count;
        }
      }

    }

    const byChat = new Map<string, typeof watches>();
    for (const watch of watches) {
      const key = `${watch.userId}:${watch.chatId}`;
      const bucket = byChat.get(key) ?? [];
      bucket.push(watch); byChat.set(key, bucket);
    }
    for (const chatWatches of byChat.values()) {
      const anchor = [...chatWatches].sort((a, b) => a.id.localeCompare(b.id))[0];
      if (!anchor) continue;
      const coreRefs = uniqueRefs(chatWatches.flatMap((watch) => refsByWatch.get(watch.id) ?? []));
      const monitoredByRef = new Map<string, {
        chain: ChainId; address: string; role: 'core' | 'related'; activeSince: Date;
        relation: { route: string; confidence: number; source: string } | null;
      }>();
      for (const watch of chatWatches) {
        for (const ref of refsByWatch.get(watch.id) ?? []) {
          monitoredByRef.set(`${ref.chain}:${ref.address}`, { ...ref, role: 'core', activeSince: watch.updatedAt, relation: null });
        }
        for (const related of connectedByWatch.get(watch.id) ?? []) {
          const key = `${related.chain}:${related.address}`;
          const current = monitoredByRef.get(key);
          if (current?.role === 'core') continue;
          if (!current || related.confidence > (current.relation?.confidence ?? 0)) {
            monitoredByRef.set(key, {
              chain: related.chain, address: related.address, role: 'related', activeSince: watch.updatedAt,
              relation: { route: related.route, confidence: related.confidence, source: related.source }
            });
          }
        }
      }
      const monitored = [...monitoredByRef.values()];
      const profiles = monitored.length ? await this.prisma.walletIntelligenceProfile.findMany({
        where: { OR: ALL_CHAINS.flatMap((chain) => {
          const addresses = monitored.filter((ref) => ref.chain === chain).map((ref) => ref.address);
          return addresses.length ? [{ chain, address: { in: addresses } }] : [];
        }) },
        include: {
          cluster: { select: { clusterKey: true } },
          entityMemberships: {
            where: { status: { not: 'rejected' }, entity: { status: 'active' } },
            include: { entity: { select: { entityKey: true, label: true, identityConfidence: true, historicalAlphaScore: true } } },
            orderBy: [{ identityConfidence: 'desc' }, { evidenceScore: 'desc' }]
          }
        }
      }) : [];
      const profileByRef = new Map(profiles.map((profile) => [`${profile.chain}:${profile.address}`, profile]));
      const dormantEvents = monitored.length ? await this.prisma.walletIntelligenceEvent.findMany({
        where: {
          eventType: 'Dormant Wallet Awakened', occurredAt: { gte: since },
          OR: ALL_CHAINS.flatMap((chain) => {
            const addresses = monitored.filter((ref) => ref.chain === chain).map((ref) => ref.address);
            return addresses.length ? [{ chain, walletAddress: { in: addresses } }] : [];
          })
        }, orderBy: { occurredAt: 'asc' }, take: 20_000
      }) : [];
      const dormantByRef = new Map<string, typeof dormantEvents>();
      for (const event of dormantEvents) {
        const key = `${event.chain}:${event.walletAddress}`;
        const bucket = dormantByRef.get(key) ?? [];
        bucket.push(event); dormantByRef.set(key, bucket);
      }

      const buyGroups = new Map<string, PersistedMassTransactionEvent[]>();
      for (const chain of ALL_CHAINS) {
        const addresses = monitored.filter((ref) => ref.chain === chain).map((ref) => ref.address);
        if (!addresses.length) continue;
        const buys = await this.prisma.massTransactionEvent.findMany({
          where: {
            chain, kind: 'token_buy', status: { not: 'failed' }, assetAddress: { not: null }, observedAt: { gt: since },
            OR: [{ actorAddress: { in: addresses } }, { fromAddress: { in: addresses } }]
          }, orderBy: [{ ts: 'asc' }, { eventId: 'asc' }], take: 20_000
        });
        for (const event of buys) {
          if (!event.assetAddress) continue;
          const wallet = event.actorAddress ?? event.fromAddress;
          const ref = monitoredByRef.get(`${chain}:${wallet}`);
          if (!ref || event.ts < ref.activeSince) continue;
          const key = `${chain}:${event.assetAddress}`;
          const bucket = buyGroups.get(key) ?? [];
          bucket.push(event); buyGroups.set(key, bucket);
        }
      }

      if (!anchor.alertTypes.includes('core_multi_wallet_buy') && !anchor.alertTypes.includes('independent_entity_confluence')) continue;
      for (const [groupKey, groupEvents] of buyGroups) {
        const separator = groupKey.indexOf(':');
        const chain = groupKey.slice(0, separator) as ChainId;
        const tokenAddress = groupKey.slice(separator + 1);
        for (const windowEvents of splitCoreBuyWindows(groupEvents, CORE_CONFLUENCE_WINDOW_MS)) {
          const windowEnd = windowEvents.at(-1)!.ts;
          const [token, quality] = await Promise.all([
            this.prisma.token.findUnique({
              where: { chain_address: { chain, address: tokenAddress } },
              select: {
                name: true, symbol: true, dex: true, firstSeenAt: true, tokenCreatedAt: true, riskFlags: true,
                marketSnapshots: { where: { ts: { lte: windowEnd } }, orderBy: { ts: 'desc' }, take: 1 }
              }
            }),
            this.prisma.tokenQualityAssessment.findFirst({
              where: { chain, tokenAddress, assessedAt: { lte: windowEnd } }, orderBy: { assessedAt: 'desc' }
            })
          ]);
          const snapshot = token?.marketSnapshots[0];
          const trustedSnapshot = snapshot?.source === 'seed_synthetic_continuation' ? null : snapshot;
          const liquidityUsd = quality?.liquidityUsd != null && quality.coverage !== 'unavailable'
            ? decimal(quality.liquidityUsd) : trustedSnapshot ? decimal(trustedSnapshot.liquidityUsd) : null;
          const holderCount = quality?.holderCount != null && quality.coverage !== 'unavailable'
            ? quality.holderCount : trustedSnapshot?.holderCount ?? null;
          const liquidityAvailable = liquidityUsd !== null;
          const holdersAvailable = holderCount !== null;
          const criticalRisk = hasCriticalTokenRisk(token?.riskFlags, quality?.reasonCodes ?? []) || liquidityAvailable && liquidityUsd === 0;
          const candidates: CoreBuyCandidate[] = windowEvents.map((event) => {
            const wallet = event.actorAddress ?? event.fromAddress;
            const ref = monitoredByRef.get(`${chain}:${wallet}`)!;
            const profile = profileByRef.get(`${chain}:${wallet}`);
            const membership = profile?.entityMemberships[0];
            const intelligenceQuality = Math.max(profile?.evidenceScore ?? 0, profile?.historicalAlphaScore ?? 0, membership?.identityConfidence ? membership.identityConfidence * 100 : 0);
            return {
              eventId: event.eventId, wallet, role: ref.role, ts: event.ts,
              amountUsd: decimal(event.amountUsd), amountToken: finiteNumber(event.amountToken),
              entityKey: membership?.entity.entityKey ?? profile?.entityKey ?? null,
              entityLabel: membership?.entity.label ?? null, clusterKey: profile?.cluster.clusterKey ?? null,
              entityIdentityConfidence: membership?.identityConfidence ?? null,
              evidenceScore: profile?.evidenceScore ?? null,
              historicalAlphaScore: Math.max(profile?.historicalAlphaScore ?? 0, membership?.entity.historicalAlphaScore ?? 0) || null,
              qualityQualified: ref.role === 'core' || Boolean(ref.relation && (ref.relation.route === 'exact_bridge' || ref.relation.confidence >= 0.5) && (!profile || intelligenceQuality >= 50)),
              relationshipRoute: ref.relation?.route ?? null, relationshipConfidence: ref.relation?.confidence ?? null,
              fundingSource: ref.relation?.source ?? null,
              dormantDays: latestDormantDays(dormantByRef.get(`${chain}:${wallet}`) ?? [], event.ts)
            };
          });
          const evaluation = evaluateCoreBuyWindow(candidates, { criticalRisk, qualityPassed: quality?.passed ?? null });
          // `firstSeenAt` is FlowRadar discovery time, not necessarily token
          // creation time. Treating it as launch time can make an old token
          // discovered during backfill look fresh, so opportunity push uses
          // only the explicit launch anchor and otherwise fails closed.
          const birth = token?.tokenCreatedAt ?? null;
          const tokenAgeSec = birth ? Math.max(0, Math.round((windowEnd.getTime() - birth.getTime()) / 1_000)) : null;
          const evaluatedAt = new Date();
          const pushDecision = evaluateCorePushEligibility(evaluation, {
            evaluatedAt, tokenAgeSec, liquidityUsd, liquidityAvailable, holderCount, holdersAvailable,
            marketCapUsd: quality?.marketCapUsd != null ? decimal(quality.marketCapUsd) : trustedSnapshot ? decimal(trustedSnapshot.marketCapUsd) : null,
            tokenQualityPassed: quality?.passed ?? null, tokenQualityScore: quality?.score ?? null,
            criticalTokenRisk: criticalRisk, infrastructureContamination: false
          });
          const evaluationByEvent = new Map(evaluation.audits.map((audit) => [audit.eventId, audit]));
          const candidateByEvent = new Map(candidates.map((candidate) => [candidate.eventId, candidate]));
          for (const event of windowEvents) {
            const audit = evaluationByEvent.get(event.eventId);
            const candidate = candidateByEvent.get(event.eventId);
            if (audit) await persistCoreBuyAudit(this.prisma, event, audit, {
              tokenAddress, windowStart: evaluation.windowStart, windowEnd: evaluation.windowEnd,
              qualifies: evaluation.qualifies, triggerType: evaluation.triggerType,
              entityKey: candidate?.entityKey ?? null, clusterKey: candidate?.clusterKey ?? null,
              marketCapUsd: quality?.marketCapUsd != null ? decimal(quality.marketCapUsd) : trustedSnapshot ? decimal(trustedSnapshot.marketCapUsd) : null,
              evaluation, pushDecision, evaluatedAt, liquidityUsd, liquidityAvailable, holderCount, holdersAvailable,
              tokenAgeSec, firstObservedAt: event.observedAt, persistedAt: event.createdAt
            });
          }
          if (!evaluation.windowStart || !evaluation.windowEnd) continue;
          const entryDelaySec = birth ? Math.max(0, Math.round((evaluation.windowStart.getTime() - birth.getTime()) / 1_000)) : null;
          const eventById = new Map(windowEvents.map((event) => [event.eventId, event]));
          const qualifiedEvents = evaluation.sourceEventIds.map((eventId) => eventById.get(eventId)).filter(nonNull);
          const entityKeys = uniqueStrings(evaluation.participants.map((participant) => participant.entityKey).filter(nonNull));
          const entityLabels = uniqueStrings(evaluation.participants.map((participant) => participant.entityLabel).filter(nonNull));
          const fundingPaths = evaluation.participants.flatMap((participant) => participant.fundingSource ? [{
            source: participant.fundingSource, destination: participant.wallet,
            route: participant.relationshipRoute, confidence: participant.relationshipConfidence
          }] : []);
          const lifecycleRevision = [windowEvents.map((event) => event.eventId).sort().join(','), pushDecision.eligibilityResult,
            evaluation.qualifyingWalletCount, evaluation.independentEntityCount, evaluation.combinedBuyUsd.toFixed(4),
            pushDecision.alertScore.toFixed(2)].join('|');
          const payload = {
            schemaVersion: 3, title: evaluation.triggerType ? coreConfluenceTitle(evaluation.triggerType) : 'Core Buy Candidate',
            triggerType: evaluation.triggerType, signalTier: pushDecision.signalTier, chain,
            token: token?.name ?? token?.symbol ?? tokenAddress,
            symbol: token?.symbol ?? qualifiedEvents[0]?.assetSymbol ?? windowEvents[0]?.assetSymbol ?? null,
            ca: tokenAddress, protocol: token?.dex ?? null,
            participants: evaluation.participants.map((participant) => ({
              wallet: participant.wallet, role: participant.role, amountUsd: participant.cumulativeBuyUsd,
              amountToken: participant.cumulativeTokenAmount, entityKey: participant.entityKey,
              entityLabel: participant.entityLabel, entityIdentityConfidence: participant.entityIdentityConfidence,
              clusterKey: participant.clusterKey,
              evidenceScore: participant.evidenceScore, historicalAlphaScore: participant.historicalAlphaScore,
              relationshipRoute: participant.relationshipRoute, relationshipConfidence: participant.relationshipConfidence,
              fundingSource: participant.fundingSource, dormantDays: participant.dormantDays,
              firstBuyAt: participant.firstBuyAt.toISOString(), lastBuyAt: participant.lastBuyAt.toISOString()
            })),
            wallets: evaluation.participants.map((participant) => participant.wallet), entityKeys, entityLabels,
            rawWalletCount: evaluation.rawWalletCount, qualifyingWalletCount: evaluation.qualifyingWalletCount,
            coreWalletCount: evaluation.coreWalletCount,
            relatedWalletCount: evaluation.relatedWalletCount, entityCount: evaluation.entityCount,
            independentEntityCount: evaluation.independentEntityCount,
            sameEntityWalletCount: evaluation.sameEntityWalletCount,
            effectiveConfirmationCount: evaluation.effectiveConfirmationCount,
            entityConcentration: evaluation.entityConcentration, independenceConfidence: evaluation.independenceConfidence,
            totalBuyUsd: evaluation.totalBuyUsd, combinedBuyUsd: evaluation.combinedBuyUsd,
            combinedTokenAmount: evaluation.combinedTokenAmount,
            windowMs: evaluation.windowMs, windowStart: evaluation.windowStart.toISOString(), windowEnd: evaluation.windowEnd.toISOString(),
            confidence: evaluation.confidence, historicalAlphaScore: maxOrNull(evaluation.participants.map((participant) => participant.historicalAlphaScore).filter(nonNull)),
            dormantWakeUpCount: evaluation.dormantWakeUpCount,
            maxDormantDays: maxOrNull(evaluation.participants.map((participant) => participant.dormantDays).filter(nonNull)),
            fundingPathCount: evaluation.fundingPathCount, fundingPaths,
            marketCapUsd: quality?.marketCapUsd != null ? decimal(quality.marketCapUsd) : trustedSnapshot ? decimal(trustedSnapshot.marketCapUsd) : null,
            liquidityUsd, liquidityAvailable, holderCount, holdersAvailable,
            marketSnapshotAt: quality?.assessedAt.toISOString() ?? trustedSnapshot?.ts.toISOString() ?? null,
            entryDelaySec, tokenAgeSec, tokenLifecycle: pushDecision.tokenLifecycle,
            tokenQualityPassed: quality?.passed ?? null, tokenQualityScore: quality?.score ?? null,
            riskFlags: token?.riskFlags ?? [], criticalRisk,
            sourceEventIds: windowEvents.map((event) => event.eventId).sort(),
            qualifyingEventIds: evaluation.sourceEventIds,
            txHashes: uniqueStrings(qualifiedEvents.map((event) => event.txHash)),
            whyThisMatters: pushDecision.pushEligible ? coreConfluenceReason(evaluation) : null,
            alertScore: pushDecision.alertScore, alertScoreContributions: pushDecision.contributions,
            pushEligible: pushDecision.pushEligible, eligibilityResult: pushDecision.eligibilityResult,
            acceptedReason: pushDecision.acceptedReason, rejectionReason: pushDecision.rejectionReason,
            eventTimestamp: evaluation.windowEnd.toISOString(), firstObservedAt: minDate(windowEvents.map((event) => event.observedAt)).toISOString(),
            persistedAt: minDate(windowEvents.map((event) => event.createdAt)).toISOString(), evaluatedAt: evaluatedAt.toISOString(),
            dispatchResult: pushDecision.pushEligible ? 'pending' : 'suppressed', lifecycleRevision,
            pipeline: { persisted: true, eligibility: pushDecision.eligibilityResult, rejectionReason: pushDecision.rejectionReason },
            policy: {
              version: CORE_ALERT_POLICY_VERSION, minimumQualifyingBuyUsd: MIN_QUALIFYING_BUY_USD,
              windowMs: CORE_CONFLUENCE_WINDOW_MS, maxPushEventAgeMs: MAX_PUSH_EVENT_AGE_MS,
              minimumPushConfidence: MIN_PUSH_CONFIDENCE, minimumPushAlertScore: MIN_PUSH_ALERT_SCORE
            }
          };
          const eventKey = `core-confluence-v3:${windowEvents[0]!.eventId}`;
          const alertType = pushDecision.pushEligible ? 'core_multi_wallet_buy' : 'core_buy_candidate';
          const desiredStatus = pushDecision.pushEligible ? 'pending'
            : pushDecision.eligibilityResult === 'INBOX_ONLY' ? 'inbox_only' : 'rejected';
          const existing = await this.prisma.operatorWatchAlert.findFirst({ where: { watchId: anchor.id, eventKey } });
          if (!existing) {
            await this.prisma.operatorWatchAlert.create({ data: { watchId: anchor.id, eventKey, alertType, status: desiredStatus, payloadJson: json(payload) } });
            if (pushDecision.pushEligible) created += 1;
          } else if (objectJson(existing.payloadJson)?.lifecycleRevision !== lifecycleRevision) {
            const existingPayload = objectJson(existing.payloadJson) ?? {};
            const deliveryReceipt = objectJson(existingPayload.deliveryReceipt as Prisma.JsonValue);
            if (existing.status === 'sent' && !pushDecision.pushEligible) continue;
            await this.prisma.operatorWatchAlert.update({
              where: { id: existing.id },
              data: {
                alertType,
                payloadJson: json({ ...payload, ...(deliveryReceipt ? { deliveryReceipt } : {}) }), lastError: null,
                status: pushDecision.pushEligible ? existing.status === 'sent' ? 'update_pending' : 'pending' : desiredStatus
              }
            });
          }
        }
      }
    }
    return created;
  }

  async pendingWatchAlerts(limit = 100) { return this.prisma.operatorWatchAlert.findMany({ where: { status: { in: ['pending', 'retryable', 'update_pending'] }, watch: { active: true } }, include: { watch: true }, orderBy: { createdAt: 'asc' }, take: Math.max(1, Math.min(limit, 1_000)) }); }

  async prepareWatchAlertForDispatch(id: string, now = new Date()) {
    const alert = await this.prisma.operatorWatchAlert.findUnique({ where: { id }, include: { watch: true } });
    if (!alert || alert.watch.targetType !== 'core_wallet') return Boolean(alert);
    const payload = objectJson(alert.payloadJson) ?? {};
    let reason: ReturnType<typeof validateCorePushPayload> = null;
    if (alert.alertType === 'dormant_wallet_reactivated') {
      const occurredAt = typeof payload.occurredAt === 'string' ? new Date(payload.occurredAt) : null;
      if (!occurredAt || Number.isNaN(occurredAt.getTime()) || now.getTime() - occurredAt.getTime() > MAX_PUSH_EVENT_AGE_MS) {
        reason = 'stale_event_not_push_eligible';
      }
    } else if (alert.alertType === 'core_multi_wallet_buy') {
      reason = validateCorePushPayload(payload, now);
    } else {
      reason = 'duplicate_signal_lifecycle';
    }
    if (!reason) return true;
    const inboxOnly = reason === 'confidence_below_push_threshold' || reason === 'liquidity_unavailable_fail_closed' || reason === 'token_age_unavailable';
    const nextPayload = {
      ...payload, pushEligible: false, eligibilityResult: inboxOnly ? 'INBOX_ONLY' : 'REJECTED',
      rejectionReason: reason, dispatchResult: 'suppressed', dispatchEvaluatedAt: now.toISOString()
    };
    await this.prisma.operatorWatchAlert.update({
      where: { id }, data: { status: inboxOnly ? 'inbox_only' : 'rejected', lastError: reason, payloadJson: json(nextPayload) }
    });
    await updateCoreEventDispatchReceipts(this.prisma, nextPayload, { status: 'suppressed', reason, at: now });
    return false;
  }

  async alertInbox(userId: string, chatId: string, filter: AlertInboxFilter = 'push', page = 1, pageSize = 5): Promise<OperatorPage<AlertInboxItem>> {
    const where: Prisma.OperatorWatchAlertWhereInput = { watch: { userId, chatId } };
    if (filter === 'push') where.status = { in: ['pending', 'retryable', 'update_pending', 'sent'] };
    else if (filter === 'inbox') where.status = 'inbox_only';
    else if (filter === 'rejected') where.status = { in: ['rejected', 'failed'] };
    else if (filter === 'dormant') where.alertType = 'dormant_wallet_reactivated';
    else if (filter === 'independent') where.payloadJson = { path: ['triggerType'], equals: 'multi_entity_confluence' };
    else where.alertType = { in: ['core_multi_wallet_buy', 'core_buy_candidate'] };
    const size = Math.max(1, Math.min(10, boundedPageSize(pageSize)));
    const [total, rows] = await Promise.all([
      this.prisma.operatorWatchAlert.count({ where }),
      this.prisma.operatorWatchAlert.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: offset(page, size), take: size })
    ]);
    const items = rows.map((row): AlertInboxItem => {
      const payload = objectJson(row.payloadJson) ?? {};
      const trigger = typeof payload.triggerType === 'string' ? payload.triggerType : null;
      const category: AlertInboxItem['category'] = row.status === 'rejected' || row.status === 'failed' ? 'rejected'
        : row.status === 'inbox_only' ? 'inbox'
          : row.alertType === 'dormant_wallet_reactivated' ? 'dormant'
            : trigger === 'multi_entity_confluence' ? 'independent'
              : row.alertType === 'core_multi_wallet_buy' ? 'cluster' : 'push';
      const timestamp = [payload.eventTimestamp, payload.occurredAt, payload.windowEnd]
        .find((value): value is string => typeof value === 'string') ?? row.createdAt.toISOString();
      return {
        id: row.id, category, status: row.status,
        token: stringJson(payload.symbol) ?? stringJson(payload.token) ?? stringJson(payload.ca),
        chain: isChainId(payload.chain) ? payload.chain : null,
        qualifyingWalletCount: finiteJsonNumber(payload.qualifyingWalletCount) ?? 0,
        independentEntityCount: finiteJsonNumber(payload.independentEntityCount) ?? 0,
        amountUsd: finiteJsonNumber(payload.combinedBuyUsd), signalTier: stringJson(payload.signalTier),
        rejectionReason: stringJson(payload.rejectionReason) ?? stringJson(objectJson(payload.pipeline as Prisma.JsonValue)?.rejectionReason),
        timestamp
      };
    });
    return pageResult(items, page, size, total, []);
  }
  async coreMonitoringAlert(alertId: string, userId: string, chatId: string) {
    return this.prisma.operatorWatchAlert.findFirst({
      where: { id: alertId, watch: { userId, chatId, targetType: 'core_wallet' } }, include: { watch: true }
    });
  }
  async intelligenceAlert(alertId: string) {
    const alert = await this.prisma.operatorWatchAlert.findUnique({ where: { id: alertId }, include: { watch: true } });
    if (!alert) return null;
    const payload = objectJson(alert.payloadJson);
    const signalId = typeof payload?.intelligenceSignalId === 'string' ? payload.intelligenceSignalId : null;
    const signal = signalId ? await this.prisma.intelligenceSignal.findUnique({
      where: { id: signalId },
      include: { qualityAssessment: true, outcomes: { orderBy: { targetAt: 'asc' } }, outcomeLabel: true, buyCandidate: true }
    }) : null;
    const entities = signal?.entityIds.length ? await this.prisma.intelligenceEntity.findMany({
      where: { id: { in: signal.entityIds } },
      include: { memberships: { where: { status: { not: 'rejected' }, scope: { not: 'infrastructure' } }, include: { profile: true }, orderBy: [{ scope: 'asc' }, { identityConfidence: 'desc' }] } }
    }) : [];
    return { alert, payload, signal, entities };
  }
  async recordWatchAlertDispatchAttempt(id: string) {
    const alert = await this.prisma.operatorWatchAlert.findUnique({ where: { id }, select: { payloadJson: true } });
    if (!alert) return;
    const payload = objectJson(alert.payloadJson) ?? {};
    const prior = objectJson(payload.deliveryReceipt as Prisma.JsonValue) ?? {};
    const attempts = Number(prior.attempts);
    const attemptedAt = new Date();
    const nextPayload = {
      ...payload,
      deliveryReceipt: {
        ...prior, attempts: Number.isFinite(attempts) ? attempts + 1 : 1,
        dispatchAttemptedAt: attemptedAt.toISOString(), status: 'attempted'
      }
    };
    await this.prisma.operatorWatchAlert.update({
      where: { id },
      data: { payloadJson: json(nextPayload) }
    });
    await updateCoreEventDispatchReceipts(this.prisma, nextPayload, { status: 'attempted', reason: null, at: attemptedAt });
  }

  async markWatchAlert(id: string, error?: string, receipt?: { telegramMessageId?: number; telegramChatId?: number }) {
    const alert = await this.prisma.operatorWatchAlert.findUnique({ where: { id }, select: { payloadJson: true } });
    const payload = alert ? objectJson(alert.payloadJson) ?? {} : {};
    const prior = objectJson(payload.deliveryReceipt as Prisma.JsonValue) ?? {};
    const now = new Date();
    const deliveryReceipt = error
      ? { ...prior, status: 'failed', failedAt: now.toISOString(), error: error.slice(0, 1_000) }
      : {
          ...prior, status: 'delivered', deliveredAt: now.toISOString(),
          telegramMessageId: receipt?.telegramMessageId ?? null,
          telegramChatId: receipt?.telegramChatId ?? null
        };
    await this.prisma.operatorWatchAlert.update({
      where: { id },
      data: error
        ? { status: 'retryable', lastError: error.slice(0, 1_000), payloadJson: json({ ...payload, deliveryReceipt }) }
        : { status: 'sent', sentAt: now, lastError: null, payloadJson: json({ ...payload, deliveryReceipt }) }
    });
    await updateCoreEventDispatchReceipts(this.prisma, payload, {
      status: error ? 'failed' : 'delivered', reason: error ?? null, at: now,
      telegramMessageId: error ? null : receipt?.telegramMessageId ?? null
    });
  }
  async stopTelegramDelivery(chatId: string, error: string) {
    const watches = await this.prisma.operatorWatch.findMany({ where: { chatId }, select: { id: true } });
    if (!watches.length) return;
    const watchIds = watches.map((watch) => watch.id);
    await this.prisma.$transaction([
      this.prisma.operatorWatch.updateMany({ where: { id: { in: watchIds }, active: true }, data: { active: false } }),
      this.prisma.operatorWatchAlert.updateMany({
        where: { watchId: { in: watchIds }, status: { in: ['pending', 'retryable', 'update_pending'] } },
        data: { status: 'failed', lastError: error.slice(0, 1_000) }
      })
    ]);
  }

  private async resolveTarget(input: string) {
    const trimmed = input.trim();
    const entity = await this.prisma.unifiedEntity.findFirst({
      where: { OR: [{ entityKey: trimmed }, { addresses: { some: { address: normalizeMaybe(trimmed) } } }] },
      include: { addresses: { orderBy: [{ chain: 'asc' }, { address: 'asc' }] } }
    });
    if (entity) return { entity, addresses: entity.addresses.map((x) => ({ chain: x.chain, address: x.address })) };
    const cluster = await this.prisma.intelligenceCluster.findFirst({
      where: { OR: [{ clusterKey: trimmed }, { profiles: { some: { address: normalizeMaybe(trimmed) } } }] },
      include: { profiles: { orderBy: [{ chain: 'asc' }, { address: 'asc' }] } }
    });
    return { entity: null, addresses: cluster?.profiles.map((profile) => ({ chain: profile.chain, address: profile.address })) ?? [] };
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
function maxOrNull(values: number[]) { const finite = values.filter(Number.isFinite); return finite.length ? Math.max(...finite) : null; }
function latestIso(values: Date[]) { return values.length ? new Date(Math.max(...values.map((value) => value.getTime()))).toISOString() : null; }
function maxDate(left: Date, right: Date) { return left.getTime() >= right.getTime() ? left : right; }
function minDate(values: Date[]) { return new Date(Math.min(...values.map((value) => value.getTime()))); }
function normalizeConfidence(value: number) { return Math.max(0, Math.min(1, value > 1 ? value / 100 : value)); }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
function extractPositions(value: Prisma.JsonValue): unknown[] { const profile = value as { local?: { tokenPositions?: unknown[] } }; return Array.isArray(profile?.local?.tokenPositions) ? profile.local.tokenPositions : []; }
function extractDiscoveryMints(value: Prisma.JsonValue | null): string[] { if (!value || typeof value !== 'object') return []; const object = value as Record<string, unknown>; const direct = object.mints; if (Array.isArray(direct)) return direct.filter((x): x is string => typeof x === 'string'); return Object.values(object).flatMap((x) => Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []); }
function dormancyFlags(value: Prisma.JsonValue | undefined) { const text = JSON.stringify(value ?? {}).toLowerCase(); const has = (days: number) => text.includes(`"days":${days}`) || text.includes(`"windowdays":${days}`) ? text.includes('covered_dormant') || text.includes('dormant') : null; return { days7: has(7), days14: has(14), days30: has(30), days90: has(90) }; }
function uniqueFunder(value: { chain: ChainId; address: string; txHash: string }, index: number, all: Array<{ chain: ChainId; address: string; txHash: string }>) { return all.findIndex((x) => x.chain === value.chain && x.address === value.address && x.txHash === value.txHash) === index; }
function uniqueStrings(values: string[]) { return [...new Set(values)]; }
function tokenMetadataAddressWhere(refs: Array<{ chain: ChainId; address: string }>): Prisma.TokenMetadataWhereInput[] {
  return refs.map((ref) => ({ chain: ref.chain, mint: ref.address }));
}
function uniqueConnected<T extends { chain: ChainId; address: string; confidence: number }>(values: T[]) {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = `${value.chain}:${value.address}`;
    const current = result.get(key);
    if (!current || value.confidence > current.confidence) result.set(key, value);
  }
  return [...result.values()];
}
function splitCoreBuyWindows(events: PersistedMassTransactionEvent[], windowMs: number) {
  const ordered = [...events].sort((left, right) => left.ts.getTime() - right.ts.getTime() || left.eventId.localeCompare(right.eventId));
  const windows: PersistedMassTransactionEvent[][] = [];
  for (const event of ordered) {
    const current = windows.at(-1);
    if (!current || event.ts.getTime() - current[0]!.ts.getTime() > windowMs) windows.push([event]);
    else current.push(event);
  }
  return windows;
}
function finiteNumber(value: Prisma.Decimal | number | string | null | undefined) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function latestDormantDays(events: Array<{ occurredAt: Date; evidenceJson: Prisma.JsonValue }>, buyAt: Date) {
  const event = events.filter((candidate) => candidate.occurredAt <= buyAt && buyAt.getTime() - candidate.occurredAt.getTime() <= 24 * 60 * 60_000).at(-1);
  const evidence = event ? objectJson(event.evidenceJson) : null;
  return finiteJsonNumber(evidence?.dormantDays ?? evidence?.preWakeDormancy ?? evidence?.days);
}
function hasCriticalTokenRisk(riskFlags: Prisma.JsonValue | null | undefined, reasonCodes: string[]) {
  const text = `${JSON.stringify(riskFlags ?? [])} ${reasonCodes.join(' ')}`.toLowerCase();
  return ['honeypot', 'rug', 'scam', 'malicious', 'blocked_transfer', 'critical_risk'].some((flag) => text.includes(flag));
}
function coreConfluenceTitle(trigger: NonNullable<ReturnType<typeof evaluateCoreBuyWindow>['triggerType']>) {
  if (trigger === 'multi_entity_confluence') return 'Multi-Entity Token Entry';
  if (trigger === 'funded_execution_buy') return 'Funded Execution Entry';
  if (trigger === 'same_entity_cluster_buy') return 'Cluster Buy Detected';
  return 'Core Confluence Detected';
}
function coreConfluenceReason(evaluation: ReturnType<typeof evaluateCoreBuyWindow>) {
  const minutes = Math.max(1, Math.ceil(evaluation.windowMs / 60_000));
  const lines = evaluation.independentEntityCount >= 2
    ? `${evaluation.independentEntityCount} independent quality entities entered within ${minutes} minutes.`
    : evaluation.sameEntityWalletCount >= 2
      ? `${evaluation.sameEntityWalletCount} quality wallets from the same entity entered within ${minutes} minutes; counted as one independent confirmation.`
      : evaluation.coreWalletCount >= 2
        ? `${evaluation.coreWalletCount} Core wallets entered within ${minutes} minutes.`
        : 'Core capital reached a qualified execution wallet before its token entry.';
  const dormant = evaluation.dormantWakeUpCount > 0
    ? ` ${evaluation.dormantWakeUpCount} dormant participant${evaluation.dormantWakeUpCount === 1 ? '' : 's'} reactivated.` : '';
  return `${lines}${dormant}`;
}
async function persistCoreBuyAudit(
  prisma: PrismaClient,
  event: PersistedMassTransactionEvent,
  audit: CoreBuyAuditDecision,
  context: {
    tokenAddress: string; windowStart: Date | null; windowEnd: Date | null; qualifies: boolean;
    triggerType: ReturnType<typeof evaluateCoreBuyWindow>['triggerType']; entityKey: string | null;
    clusterKey: string | null; marketCapUsd: number | null;
    evaluation: ReturnType<typeof evaluateCoreBuyWindow>; pushDecision: CorePushDecision; evaluatedAt: Date;
    liquidityUsd: number | null; liquidityAvailable: boolean; holderCount: number | null; holdersAvailable: boolean;
    tokenAgeSec: number | null; firstObservedAt: Date; persistedAt: Date;
  }
) {
  const metadata = objectJson(event.metadataJson) ?? {};
  const next = {
    policyVersion: CORE_ALERT_POLICY_VERSION, minimumQualifyingBuyUsd: MIN_QUALIFYING_BUY_USD,
    confluenceWindowMs: CORE_CONFLUENCE_WINDOW_MS, wallet: audit.wallet, entityKey: context.entityKey,
    clusterKey: context.clusterKey, tokenAddress: context.tokenAddress, amountUsd: decimal(event.amountUsd),
    marketCapUsd: context.marketCapUsd, liquidityUsd: context.liquidityUsd,
    liquidityAvailable: context.liquidityAvailable, holderCount: context.holderCount,
    holdersAvailable: context.holdersAvailable, tokenAgeSec: context.tokenAgeSec,
    chainEventTimestamp: event.ts.toISOString(), firstObservedAt: context.firstObservedAt.toISOString(),
    persistedAt: context.persistedAt.toISOString(), eligibilityEvaluatedAt: context.evaluatedAt.toISOString(),
    transaction: event.txHash,
    cumulativeWalletBuyUsd: audit.cumulativeWalletBuyUsd, eligibility: audit.eligibility,
    rawWalletCount: context.evaluation.rawWalletCount,
    qualifyingWalletCount: context.evaluation.qualifyingWalletCount,
    coreWalletCount: context.evaluation.coreWalletCount,
    entityCount: context.evaluation.entityCount,
    independentEntityCount: context.evaluation.independentEntityCount,
    sameEntityWalletCount: context.evaluation.sameEntityWalletCount,
    effectiveConfirmationCount: context.evaluation.effectiveConfirmationCount,
    totalBuyUsd: context.evaluation.totalBuyUsd, qualifyingBuyUsd: context.evaluation.combinedBuyUsd,
    confidence: context.evaluation.confidence, alertScore: context.pushDecision.alertScore,
    alertScoreContributions: context.pushDecision.contributions,
    eligibilityResult: audit.eligibility === 'rejected' ? 'REJECTED' : context.pushDecision.eligibilityResult,
    acceptedReason: audit.eligibility === 'rejected' ? null : context.pushDecision.acceptedReason,
    rejectionReason: audit.rejectionReason ?? context.pushDecision.rejectionReason,
    dispatchResult: context.pushDecision.pushEligible && audit.eligibility !== 'rejected' ? 'pending' : 'suppressed',
    telegramMessageId: null, confluenceQualified: context.qualifies,
    triggerType: context.triggerType, windowStart: context.windowStart?.toISOString() ?? null,
    windowEnd: context.windowEnd?.toISOString() ?? null
  };
  if (JSON.stringify(metadata.coreAlertAudit ?? null) === JSON.stringify(next)) return;
  await prisma.massTransactionEvent.update({
    where: { eventId: event.eventId },
    data: { metadataJson: json({ ...metadata, coreAlertAudit: next }) }
  });
}
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
function stringJson(value: unknown) { return typeof value === 'string' && value.length ? value : null; }
function isChainId(value: unknown): value is ChainId { return typeof value === 'string' && ALL_CHAINS.includes(value as ChainId); }
async function updateCoreEventDispatchReceipts(
  prisma: PrismaClient,
  payload: Record<string, unknown>,
  receipt: { status: string; reason: string | null; at: Date; telegramMessageId?: number | null }
) {
  const receiptEventIds = Array.isArray(payload.qualifyingEventIds) ? payload.qualifyingEventIds : payload.sourceEventIds;
  const eventIds = Array.isArray(receiptEventIds)
    ? receiptEventIds.filter((value): value is string => typeof value === 'string').slice(0, 100)
    : [];
  if (!eventIds.length) return;
  const events = await prisma.massTransactionEvent.findMany({ where: { eventId: { in: eventIds } }, select: { eventId: true, metadataJson: true } });
  for (const event of events) {
    const metadata = objectJson(event.metadataJson) ?? {};
    const audit = objectJson(metadata.coreAlertAudit as Prisma.JsonValue);
    if (!audit) continue;
    await prisma.massTransactionEvent.update({
      where: { eventId: event.eventId },
      data: { metadataJson: json({
        ...metadata,
        coreAlertAudit: {
          ...audit, dispatchResult: receipt.status, dispatchReason: receipt.reason,
          dispatchTimestamp: receipt.at.toISOString(), telegramMessageId: receipt.telegramMessageId ?? null
        }
      }) }
    });
  }
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
