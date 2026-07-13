import { Prisma, type ChainId, type PrismaClient } from '@prisma/client';
import { buildUnifiedEntityGraph } from '../discovery/unifiedEntity';
import { normalizeAddress, validAddress } from '../discovery/unified';
import { enrollObservationWallet } from './monitoring';

export const WALLET_FLOW_INTELLIGENCE_ENGINE_VERSION = 2;
const INFRA_CATEGORIES = ['CEX', 'BRIDGE', 'ROUTER', 'POOL', 'MIXER', 'TOKEN_CONTRACT', 'PROGRAM', 'BURN', 'SYSTEM'];

interface RelationAccumulator {
  sourceChain: ChainId;
  sourceWallet: string;
  relatedChain: ChainId;
  relatedWallet: string;
  route: 'direct_transfer' | 'multi_hop_transfer' | 'exact_bridge' | 'bridge_inference' | 'cex_correlation';
  hops: number;
  events: Array<{ eventId: string; ts: Date; safe: boolean; amountUsd: number | null }>;
  bridgeCorrelationIds: string[];
  supporting: unknown[];
  contradicting: unknown[];
}

export interface WalletFlowExpansionReport {
  chain: ChainId;
  sourceWallet: string;
  relationshipsPersisted: number;
  direct: number;
  multiHop: number;
  exactBridge: number;
  bridgeInference: number;
  cexInference: number;
  receiversMonitored: number;
  freshReceivers: number;
  dormantReceivers: number;
  tokenBuysObserved: number;
  unifiedEntityKey: string | null;
  related: Array<{ chain: ChainId; address: string; role: string; route: string; confidence: number; safeEntityLink: boolean; entityKey: string | null }>;
}

export async function expandWalletCapitalGraph(
  prisma: PrismaClient,
  input: { chain: ChainId; walletAddress: string; maxDepth?: number; maxNodes?: number; maxEventsPerNode?: number; now?: Date }
): Promise<WalletFlowExpansionReport> {
  const now = input.now ?? new Date();
  const sourceWallet = normalizeAddress(input.chain, input.walletAddress);
  if (!validAddress(input.chain, sourceWallet)) throw new Error(`Invalid ${input.chain} wallet address`);
  const maxDepth = Math.max(1, Math.min(input.maxDepth ?? 4, 4));
  const maxNodes = Math.max(1, Math.min(input.maxNodes ?? 100, 500));
  const maxEvents = Math.max(10, Math.min(input.maxEventsPerNode ?? 250, 2_000));
  const sourceEntity = await prisma.unifiedEntityAddress.findUnique({
    where: { chain_address: { chain: input.chain, address: sourceWallet } },
    include: { entity: { select: { entityKey: true } } }
  });
  const sourceEntityKey = sourceEntity?.entity.entityKey ?? `wallet:${input.chain}:${sourceWallet}`;
  await enrollObservationWallet(prisma, { chain: input.chain, address: sourceWallet, role: sourceEntity?.role ?? 'execution_wallet', reason: 'wallet_capital_graph_source', now });
  const infrastructureCache = new Map<string, string | null>();

  const relations = new Map<string, RelationAccumulator>();
  const visited = new Set<string>([`${input.chain}:${sourceWallet}`]);
  const queue: Array<{ chain: ChainId; address: string; depth: number; path: Array<{ eventId: string; ts: Date; safe: boolean; amountUsd: number | null }> }> = [
    { chain: input.chain, address: sourceWallet, depth: 0, path: [] }
  ];
  const bridgeSourceEventIds: string[] = [];
  let explored = 0;
  while (queue.length && explored < maxNodes) {
    const node = queue.shift()!;
    explored += 1;
    const events = await prisma.massTransactionEvent.findMany({
      where: {
        chain: node.chain,
        fromAddress: node.address,
        kind: { in: ['native_transfer', 'token_transfer', 'bridge_source'] },
        status: { not: 'failed' }
      },
      orderBy: [{ ts: 'asc' }, { eventId: 'asc' }],
      take: maxEvents
    });
    for (const event of events) {
      if (event.kind === 'bridge_source') {
        bridgeSourceEventIds.push(event.eventId);
        continue;
      }
      if (event.toAddress === node.address || event.toAddress === sourceWallet) continue;
      const infra = await infrastructureCategory(prisma, node.chain, event.toAddress, infrastructureCache);
      if (infra) {
        if (infra === 'CEX') addRelation(relations, {
          sourceChain: input.chain, sourceWallet, relatedChain: node.chain, relatedWallet: event.toAddress, route: 'cex_correlation', hops: node.depth + 1,
          events: [...node.path, eventReceipt(event)], bridgeCorrelationIds: [],
          supporting: [{ eventId: event.eventId, category: infra, rule: 'cex_terminal_only' }],
          contradicting: ['CEX correlation never attributes a downstream wallet or ownership']
        });
        continue;
      }
      const nextPath = [...node.path, eventReceipt(event)];
      const route = node.depth === 0 ? 'direct_transfer' : 'multi_hop_transfer';
      addRelation(relations, {
        sourceChain: input.chain,
        sourceWallet,
        relatedChain: node.chain,
        relatedWallet: event.toAddress,
        route,
        hops: node.depth + 1,
        events: nextPath,
        bridgeCorrelationIds: [],
        supporting: [{ eventId: event.eventId, relevance: event.relevanceCategory, reasonCodes: event.reasonCodes }],
        contradicting: event.safeEntityLink ? [] : ['event was not individually safe for entity merge']
      });
      const key = `${node.chain}:${event.toAddress}`;
      if (node.depth + 1 < maxDepth && !visited.has(key)) {
        visited.add(key);
        queue.push({ chain: node.chain, address: event.toAddress, depth: node.depth + 1, path: nextPath });
      }
    }
  }

  if (bridgeSourceEventIds.length) {
    const correlations = await prisma.massBridgeCorrelation.findMany({
      where: { sourceEventId: { in: bridgeSourceEventIds } },
      orderBy: { correlatedAt: 'asc' },
      take: 10_000
    });
    const eventIds = [...new Set(correlations.flatMap((row) => [row.sourceEventId, row.destinationEventId]))];
    const bridgeEvents = await prisma.massTransactionEvent.findMany({ where: { eventId: { in: eventIds } } });
    const bridgeById = new Map(bridgeEvents.map((event) => [event.eventId, event]));
    const correlatedSources = new Set(correlations.map((row) => row.sourceEventId));
    for (const correlation of correlations) {
      const source = bridgeById.get(correlation.sourceEventId);
      const destination = bridgeById.get(correlation.destinationEventId);
      if (!source || !destination || source.chain === destination.chain) continue;
      const recipient = normalizeAddress(destination.chain, bridgeField(destination.bridgeJson, 'recipient') ?? destination.actorAddress ?? destination.toAddress);
      if (!validAddress(destination.chain, recipient) || await infrastructureCategory(prisma, destination.chain, recipient, infrastructureCache)) continue;
      addRelation(relations, {
        sourceChain: input.chain,
        sourceWallet,
        relatedChain: destination.chain,
        relatedWallet: recipient,
        route: correlation.status === 'verified' ? 'exact_bridge' : 'bridge_inference',
        hops: 1,
        events: [eventReceipt(source), eventReceipt(destination)],
        bridgeCorrelationIds: [correlation.correlationId],
        supporting: [{ correlationId: correlation.correlationId, protocol: correlation.protocol, status: correlation.status, officialMessageId: correlation.officialMessageId }],
        contradicting: correlation.status === 'verified' ? [] : ['bridge correlation is not verified and cannot merge entities']
      });
    }
    const uncorrelated = await prisma.massTransactionEvent.findMany({ where: { eventId: { in: bridgeSourceEventIds.filter((id) => !correlatedSources.has(id)) } } });
    for (const source of uncorrelated) {
      const destinationChain = bridgeChain(source.bridgeJson);
      const recipientRaw = bridgeField(source.bridgeJson, 'recipient');
      if (!destinationChain || !recipientRaw) continue;
      const recipient = normalizeAddress(destinationChain, recipientRaw);
      if (!validAddress(destinationChain, recipient) || await infrastructureCategory(prisma, destinationChain, recipient, infrastructureCache)) continue;
      addRelation(relations, {
        sourceChain: input.chain, sourceWallet, relatedChain: destinationChain, relatedWallet: recipient, route: 'bridge_inference', hops: 1,
        events: [eventReceipt(source)], bridgeCorrelationIds: [],
        supporting: [{ eventId: source.eventId, protocol: source.bridgeProtocol, decodedRecipient: true }],
        contradicting: ['no verified source-to-destination bridge correlation']
      });
    }
  }

  const prepared: Array<{
    relation: RelationAccumulator;
    role: string;
    confidence: number;
    safeEntityLink: boolean;
    fresh: boolean;
    dormant: boolean;
    tradedTokens: Array<{ tokenAddress: string; firstBuyTs: string; buyEvents: number }>;
    dna: Awaited<ReturnType<typeof loadDna>>;
    monitoring: boolean;
  }> = [];
  for (const relation of relations.values()) {
    const first = relation.events.reduce((best, event) => event.ts < best ? event.ts : best, relation.events[0].ts);
    const last = relation.events.reduce((best, event) => event.ts > best ? event.ts : best, relation.events[0].ts);
    const [prior, buys, dna, returnedToSource, infra] = await Promise.all([
      prisma.massTransactionEvent.findFirst({
        where: { chain: relation.relatedChain, ts: { lt: first }, OR: [{ fromAddress: relation.relatedWallet }, { toAddress: relation.relatedWallet }, { actorAddress: relation.relatedWallet }] },
        orderBy: [{ ts: 'desc' }, { eventId: 'desc' }]
      }),
      prisma.massTransactionEvent.findMany({
        where: { chain: relation.relatedChain, kind: 'token_buy', ts: { gte: first }, OR: [{ actorAddress: relation.relatedWallet }, { fromAddress: relation.relatedWallet }] },
        orderBy: [{ ts: 'asc' }, { eventId: 'asc' }], take: 2_000
      }),
      loadDna(prisma, relation.relatedChain, relation.relatedWallet),
      prisma.massTransactionEvent.count({ where: { chain: relation.relatedChain, fromAddress: relation.relatedWallet, toAddress: sourceWallet, ts: { gte: first } } }),
      infrastructureCategory(prisma, relation.relatedChain, relation.relatedWallet, infrastructureCache)
    ]);
    const gapDays = prior ? (first.getTime() - prior.ts.getTime()) / 86_400_000 : null;
    const fresh = prior === null;
    const dormant = gapDays !== null && gapDays >= 7;
    const byToken = new Map<string, { tokenAddress: string; firstBuyTs: string; buyEvents: number }>();
    for (const buy of buys) {
      if (!buy.assetAddress) continue;
      const current = byToken.get(buy.assetAddress);
      if (current) current.buyEvents += 1;
      else byToken.set(buy.assetAddress, { tokenAddress: buy.assetAddress, firstBuyTs: buy.ts.toISOString(), buyEvents: 1 });
    }
    const tradedTokens = [...byToken.values()].map((token) => {
      const buyTs = new Date(token.firstBuyTs);
      const funding = relation.events.filter((event) => event.ts <= buyTs).sort((a, b) => b.ts.getTime() - a.ts.getTime())[0];
      return { ...token, fundingToBuyDelaySec: funding ? Math.max(0, Math.round((buyTs.getTime() - funding.ts.getTime()) / 1_000)) : null };
    });
    const role = infra ? 'service_router_cex_node'
      : relation.route === 'exact_bridge' ? 'bridge_linked_receiver'
      : returnedToSource > 0 && !tradedTokens.length ? 'profit_collection_wallet'
      : tradedTokens.length ? 'execution_wallet'
      : dormant ? 'dormant_funded_receiver'
      : fresh ? 'fresh_funded_receiver'
      : relation.route === 'direct_transfer' ? 'probable_side_wallet'
      : 'probable_linked_wallet';
    const directRepeated = relation.route === 'direct_transfer' && relation.events.length >= 2;
    const allSafe = relation.events.every((event) => event.safe);
    const safeEntityLink = !infra && (relation.route === 'exact_bridge' || (relation.route === 'direct_transfer' && (allSafe || directRepeated)) || (relation.route === 'multi_hop_transfer' && allSafe));
    const confidence = relationshipConfidence(relation.route, relation.events.length, safeEntityLink);
    let monitoring = false;
    if (!infra && relation.route !== 'cex_correlation') {
      const enrollment = await enrollObservationWallet(prisma, {
        chain: relation.relatedChain,
        address: relation.relatedWallet,
        role,
        reason: `wallet_flow:${relation.route};source:${input.chain}:${sourceWallet}`,
        firstSeenAt: first,
        lastActiveAt: last,
        now
      });
      monitoring = Boolean(enrollment.subscription.id);
    }
    prepared.push({ relation, role, confidence, safeEntityLink, fresh, dormant, tradedTokens, dna, monitoring });
  }

  for (const item of prepared) {
    const relation = item.relation;
    const firstTransferTs = relation.events.reduce((best, event) => event.ts < best ? event.ts : best, relation.events[0].ts);
    const lastTransferTs = relation.events.reduce((best, event) => event.ts > best ? event.ts : best, relation.events[0].ts);
    const receipts = [...new Set(relation.events.map((event) => event.eventId))];
    const data = {
      sourceChain: relation.sourceChain,
      sourceWallet: relation.sourceWallet,
      sourceEntityKey,
      relatedChain: relation.relatedChain,
      relatedWallet: relation.relatedWallet,
      relatedEntityKey: item.safeEntityLink ? sourceEntityKey : null,
      role: item.role,
      route: relation.route,
      hops: relation.hops,
      transferCount: receipts.length,
      firstTransferTs,
      lastTransferTs,
      relationshipConfidence: item.confidence,
      safeEntityLink: item.safeEntityLink,
      transferReceiptIds: receipts,
      bridgeCorrelationIds: [...new Set(relation.bridgeCorrelationIds)],
      supportingEvidenceJson: json({
        evidence: relation.supporting, freshAtReceipt: item.fresh, dormantAtReceipt: item.dormant, monitoringEnrolled: item.monitoring,
        knownAmountUsd: minimumKnownAmount(relation.events.map((event) => event.amountUsd)),
        sourceEventId: relation.events.slice().sort((a, b) => a.ts.getTime() - b.ts.getTime())[0]?.eventId ?? null
      }),
      contradictingEvidenceJson: json({ evidence: relation.contradicting, inferenceOnly: !item.safeEntityLink, cexNeverOwnership: relation.route === 'cex_correlation' }),
      tradedTokensJson: json(item.tradedTokens),
      pnlMetricsJson: json(item.dna ? {
        completedPositions: item.dna.completedPositions, winCount: item.dna.winCount, lossCount: item.dna.lossCount,
        unresolvedPositions: item.dna.openPositions + item.dna.unpricedPositions, winRate: item.dna.winRate,
        evUsd: item.dna.evUsdPerCompletedPosition, totalRealizedPnlUsd: decimal(item.dna.totalRealizedPnlUsd),
        repeatRunnerCount: item.dna.repeatRunnerCount, oneWinnerDependence: item.dna.oneWinnerDependence, coverage: item.dna.coverage
      } : { coverage: 'unavailable' }),
      status: 'observation_only',
      engineVersion: WALLET_FLOW_INTELLIGENCE_ENGINE_VERSION,
      computedAt: now
    };
    await prisma.walletFlowRelationship.upsert({
      where: { sourceChain_sourceWallet_relatedChain_relatedWallet_route: {
        sourceChain: relation.sourceChain, sourceWallet: relation.sourceWallet, relatedChain: relation.relatedChain, relatedWallet: relation.relatedWallet, route: relation.route
      } },
      create: data,
      update: data
    });
    await prisma.walletRoleAssignment.upsert({
      where: { chain_walletAddress_role: { chain: relation.relatedChain, walletAddress: relation.relatedWallet, role: item.role } },
      create: {
        chain: relation.relatedChain, walletAddress: relation.relatedWallet, role: item.role, evidenceTier: relation.route,
        entityKey: item.safeEntityLink ? sourceEntityKey : null, confidence: item.confidence,
        reasonCodes: item.safeEntityLink ? ['safe_wallet_flow_relationship'] : ['possible_relationship_only'],
        receiptsJson: json({ sourceChain: input.chain, sourceWallet, transferReceiptIds: receipts, bridgeCorrelationIds: relation.bridgeCorrelationIds }),
        caveats: relation.route === 'cex_correlation' ? ['CEX correlation is never ownership evidence'] : ['probabilistic on-chain relationship; not identity'],
        engineVersion: WALLET_FLOW_INTELLIGENCE_ENGINE_VERSION, computedAt: now
      },
      update: {
        evidenceTier: relation.route, entityKey: item.safeEntityLink ? sourceEntityKey : null, confidence: item.confidence,
        reasonCodes: item.safeEntityLink ? ['safe_wallet_flow_relationship'] : ['possible_relationship_only'],
        receiptsJson: json({ sourceChain: input.chain, sourceWallet, transferReceiptIds: receipts, bridgeCorrelationIds: relation.bridgeCorrelationIds }),
        caveats: relation.route === 'cex_correlation' ? ['CEX correlation is never ownership evidence'] : ['probabilistic on-chain relationship; not identity'],
        engineVersion: WALLET_FLOW_INTELLIGENCE_ENGINE_VERSION, computedAt: now
      }
    });
  }

  await buildUnifiedEntityGraph(prisma, { now });
  const persisted = await prisma.walletFlowRelationship.findMany({
    where: { sourceChain: input.chain, sourceWallet },
    orderBy: [{ relationshipConfidence: 'desc' }, { relatedChain: 'asc' }, { relatedWallet: 'asc' }]
  });
  const entityAddresses = await prisma.unifiedEntityAddress.findMany({
    where: { OR: [{ chain: input.chain, address: sourceWallet }, ...persisted.map((row) => ({ chain: row.relatedChain, address: row.relatedWallet }))] },
    include: { entity: { select: { entityKey: true } } }
  });
  const entityOf = new Map(entityAddresses.map((row) => [`${row.chain}:${row.address}`, row.entity.entityKey]));
  for (const row of persisted) {
    const relatedEntityKey = entityOf.get(`${row.relatedChain}:${row.relatedWallet}`) ?? null;
    if (row.relatedEntityKey !== relatedEntityKey) await prisma.walletFlowRelationship.update({ where: { id: row.id }, data: { relatedEntityKey } });
  }
  const updated = persisted.map((row) => ({
    chain: row.relatedChain,
    address: row.relatedWallet,
    role: row.role,
    route: row.route,
    confidence: row.relationshipConfidence,
    safeEntityLink: row.safeEntityLink,
    entityKey: entityOf.get(`${row.relatedChain}:${row.relatedWallet}`) ?? null
  }));
  return {
    chain: input.chain,
    sourceWallet,
    relationshipsPersisted: updated.length,
    direct: updated.filter((row) => row.route === 'direct_transfer').length,
    multiHop: updated.filter((row) => row.route === 'multi_hop_transfer').length,
    exactBridge: updated.filter((row) => row.route === 'exact_bridge').length,
    bridgeInference: updated.filter((row) => row.route === 'bridge_inference').length,
    cexInference: updated.filter((row) => row.route === 'cex_correlation').length,
    receiversMonitored: prepared.filter((row) => row.monitoring).length,
    freshReceivers: prepared.filter((row) => row.fresh).length,
    dormantReceivers: prepared.filter((row) => row.dormant).length,
    tokenBuysObserved: prepared.reduce((sum, row) => sum + row.tradedTokens.length, 0),
    unifiedEntityKey: entityOf.get(`${input.chain}:${sourceWallet}`) ?? null,
    related: updated
  };
}

function addRelation(relations: Map<string, RelationAccumulator>, incoming: RelationAccumulator) {
  const key = `${incoming.relatedChain}:${incoming.relatedWallet}:${incoming.route}`;
  const current = relations.get(key);
  if (!current) {
    relations.set(key, {
      ...incoming,
      events: [...incoming.events],
      bridgeCorrelationIds: [...incoming.bridgeCorrelationIds],
      supporting: [...incoming.supporting],
      contradicting: [...incoming.contradicting]
    });
    return;
  }
  for (const event of incoming.events) current.events.push(event);
  for (const correlationId of incoming.bridgeCorrelationIds) current.bridgeCorrelationIds.push(correlationId);
  for (const evidence of incoming.supporting) current.supporting.push(evidence);
  for (const evidence of incoming.contradicting) current.contradicting.push(evidence);
  current.hops = Math.min(current.hops, incoming.hops);
}
function eventReceipt(event: { eventId: string; ts: Date; safeEntityLink: boolean; amountUsd: Prisma.Decimal | null }) {
  return { eventId: event.eventId, ts: event.ts, safe: event.safeEntityLink, amountUsd: decimal(event.amountUsd) };
}
async function infrastructureCategory(prisma: PrismaClient, chain: ChainId, address: string, cache: Map<string, string | null>) {
  const key = `${chain}:${address}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const row = await prisma.addressRegistry.findFirst({ where: { chain, address }, select: { category: true } });
  const category = row && INFRA_CATEGORIES.includes(row.category) ? row.category : null;
  cache.set(key, category);
  return category;
}
async function loadDna(prisma: PrismaClient, chain: ChainId, address: string) {
  return prisma.walletDnaProfile.findUnique({ where: { chain_walletAddress: { chain, walletAddress: address } } });
}
function relationshipConfidence(route: RelationAccumulator['route'], transferCount: number, safe: boolean) {
  const base = route === 'exact_bridge' ? 0.95 : route === 'direct_transfer' ? 0.8 : route === 'multi_hop_transfer' ? 0.62 : route === 'bridge_inference' ? 0.4 : 0.2;
  return Math.max(0, Math.min(1, base + Math.min(0.15, Math.max(0, transferCount - 1) * 0.05) + (safe && route !== 'exact_bridge' ? 0.05 : 0)));
}
function bridgeField(value: Prisma.JsonValue | null, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.trim() ? field.trim() : null;
}
function bridgeChain(value: Prisma.JsonValue | null): ChainId | null {
  const chain = bridgeField(value, 'destinationChain');
  return chain && ['SOLANA', 'ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'].includes(chain) ? chain as ChainId : null;
}
function decimal(value: Prisma.Decimal | number | null | undefined) { if (value == null) return null; const result = Number(value); return Number.isFinite(result) ? result : null; }
function minimumKnownAmount(values: Array<number | null>) { const known = values.filter((value): value is number => value !== null && value >= 0); return known.length ? Math.min(...known) : null; }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
