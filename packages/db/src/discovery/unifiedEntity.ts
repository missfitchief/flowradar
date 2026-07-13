import { createHash } from 'node:crypto';
import { Prisma, type ChainId, type PrismaClient } from '@prisma/client';
import { normalizeAddress } from './unified';

export const UNIFIED_ENTITY_ENGINE_VERSION = 1;

type NodeKey = `${ChainId}:${string}`;
interface NodeEvidence { role: string; confidence: number; evidenceTier: string; evidence: unknown[] }
interface LinkEvidence { a: NodeKey; b: NodeKey; confidence: number; kind: string; receipt: unknown }

export interface UnifiedEntityBuildReport {
  nodes: number;
  entities: number;
  multiChainEntities: number;
  verifiedBridgeLinks: number;
  sameEvmAddressLinks: number;
}

/**
 * Builds the persisted cross-chain projection. The only cross-chain joins are
 * identical EVM account addresses and verified official bridge correlations.
 * Shared tokens, routers and CEX nodes never merge entities.
 */
export async function buildUnifiedEntityGraph(
  prisma: PrismaClient,
  options: { maxProfiles?: number; maxRoles?: number; maxBridgePairs?: number; now?: Date } = {}
): Promise<UnifiedEntityBuildReport> {
  const now = options.now ?? new Date();
  const maxProfiles = clamp(options.maxProfiles ?? 50_000, 1, 250_000);
  const maxRoles = clamp(options.maxRoles ?? 100_000, 1, 500_000);
  const maxBridgePairs = clamp(options.maxBridgePairs ?? 50_000, 1, 250_000);
  const nodes = new Map<NodeKey, NodeEvidence>();
  const links: LinkEvidence[] = [];

  const [profiles, roles, roots, dna, candidates, correlations, flowRelationships] = await Promise.all([
    prisma.entityDnaProfile.findMany({ orderBy: [{ chain: 'asc' }, { entityKey: 'asc' }], take: maxProfiles }),
    prisma.walletRoleAssignment.findMany({ orderBy: [{ chain: 'asc' }, { walletAddress: 'asc' }, { confidence: 'desc' }], take: maxRoles }),
    prisma.lineageRoot.findMany({ take: maxProfiles, select: { wallet: { select: { chain: true, address: true } }, source: true, label: true } }),
    prisma.walletDnaProfile.findMany({ orderBy: [{ chain: 'asc' }, { walletAddress: 'asc' }], take: maxProfiles, select: { chain: true, walletAddress: true, confidence: true, discoveryJson: true } }),
    prisma.tokenTopPnlCandidate.findMany({ orderBy: [{ chain: 'asc' }, { walletAddress: 'asc' }, { confidence: 'desc' }], distinct: ['chain', 'walletAddress'], take: maxProfiles, select: { chain: true, walletAddress: true, confidence: true, validation: true, source: true } }),
    prisma.massBridgeCorrelation.findMany({ where: { status: 'verified' }, orderBy: { correlatedAt: 'desc' }, take: maxBridgePairs }),
    prisma.walletFlowRelationship.findMany({ orderBy: [{ computedAt: 'desc' }, { id: 'asc' }], take: maxRoles })
  ]);

  for (const profile of profiles) {
    const members = [...new Set(profile.memberWallets.map((address) => normalizeAddress(profile.chain, address)))].sort();
    for (const address of members) addNode(nodes, profile.chain, address, 'unknown_related_wallet', normalizeConfidence(profile.confidence), 'relationship_tier', { entityDnaKey: profile.entityKey });
    for (let index = 1; index < members.length; index += 1) {
      links.push({
        a: nodeKey(profile.chain, members[0]), b: nodeKey(profile.chain, members[index]), confidence: normalizeConfidence(profile.confidence),
        kind: 'existing_entity_dna', receipt: { entityDnaKey: profile.entityKey, linkEvidence: profile.linkEvidenceJson }
      });
    }
  }
  for (const role of roles) addNode(nodes, role.chain, normalizeAddress(role.chain, role.walletAddress), mapRole(role.role), normalizeConfidence(role.confidence), role.evidenceTier, { roleId: role.id, reasons: role.reasonCodes, receipts: role.receiptsJson });
  for (const root of roots) addNode(nodes, root.wallet.chain, normalizeAddress(root.wallet.chain, root.wallet.address), 'root_main', 1, 'operator_seed', { source: root.source, label: root.label });
  for (const row of dna) addNode(nodes, row.chain, normalizeAddress(row.chain, row.walletAddress), 'execution_wallet', normalizeConfidence(row.confidence), 'profitable_wallet_discovery', { discovery: row.discoveryJson });
  for (const row of candidates) addNode(nodes, row.chain, normalizeAddress(row.chain, row.walletAddress), 'execution_wallet', normalizeConfidence(row.confidence), 'top_pnl_discovery', { validation: row.validation, source: row.source });
  for (const relationship of flowRelationships) {
    const sourceAddress = normalizeAddress(relationship.sourceChain, relationship.sourceWallet);
    const relatedAddress = normalizeAddress(relationship.relatedChain, relationship.relatedWallet);
    addNode(nodes, relationship.sourceChain, sourceAddress, 'unknown_related_wallet', normalizeConfidence(relationship.relationshipConfidence), relationship.route, { relationshipId: relationship.id, side: 'source' });
    addNode(nodes, relationship.relatedChain, relatedAddress, relationship.role, normalizeConfidence(relationship.relationshipConfidence), relationship.route, {
      relationshipId: relationship.id,
      transferReceiptIds: relationship.transferReceiptIds,
      bridgeCorrelationIds: relationship.bridgeCorrelationIds,
      supporting: relationship.supportingEvidenceJson,
      contradicting: relationship.contradictingEvidenceJson
    });
    if (relationship.safeEntityLink && ['direct_transfer', 'multi_hop_transfer', 'exact_bridge'].includes(relationship.route) && relationship.role !== 'service_router_cex_node') {
      links.push({
        a: nodeKey(relationship.sourceChain, sourceAddress),
        b: nodeKey(relationship.relatedChain, relatedAddress),
        confidence: normalizeConfidence(relationship.relationshipConfidence),
        kind: `wallet_flow:${relationship.route}`,
        receipt: { relationshipId: relationship.id, transferReceiptIds: relationship.transferReceiptIds, bridgeCorrelationIds: relationship.bridgeCorrelationIds }
      });
    }
  }

  // Same 20-byte account on EVM networks is continuity evidence, not a
  // same-token/router heuristic and not an identity claim. Service nodes are
  // excluded because equal contract/service addresses need not share control.
  let sameEvmAddressLinks = 0;
  const evmByAddress = new Map<string, NodeKey[]>();
  for (const key of nodes.keys()) {
    const [chain, address] = splitKey(key);
    if (chain === 'SOLANA' || nodes.get(key)?.role === 'service_router_cex_node') continue;
    const bucket = evmByAddress.get(address) ?? [];
    bucket.push(key);
    evmByAddress.set(address, bucket);
  }
  for (const keys of evmByAddress.values()) {
    keys.sort();
    for (let i = 1; i < keys.length; i += 1) {
      links.push({ a: keys[0], b: keys[i], confidence: 0.95, kind: 'same_evm_account_address', receipt: { address: splitKey(keys[0])[1] } });
      sameEvmAddressLinks += 1;
    }
  }

  let verifiedBridgeLinks = 0;
  if (correlations.length) {
    const eventIds = [...new Set(correlations.flatMap((x) => [x.sourceEventId, x.destinationEventId]))];
    const events = await prisma.massTransactionEvent.findMany({ where: { eventId: { in: eventIds } } });
    const byId = new Map(events.map((event) => [event.eventId, event]));
    const infrastructureKeys = await loadInfrastructureKeys(prisma, events.flatMap((event) => [
      { chain: event.chain, address: normalizeAddress(event.chain, event.actorAddress ?? event.fromAddress) },
      { chain: event.chain, address: normalizeAddress(event.chain, event.toAddress) }
    ]));
    for (const correlation of correlations) {
      const source = byId.get(correlation.sourceEventId);
      const destination = byId.get(correlation.destinationEventId);
      if (!source || !destination || source.chain === destination.chain) continue;
      const sourceAddress = normalizeAddress(source.chain, source.actorAddress ?? source.fromAddress);
      const destinationAddress = normalizeAddress(destination.chain, destination.actorAddress ?? destination.toAddress);
      // A verified bridge receipt proves a route only between end-user
      // endpoints. A registry-known bridge/router/CEX/contract terminal must
      // never become a union-find connector between otherwise unrelated users.
      if (infrastructureKeys.has(nodeKey(source.chain, sourceAddress)) || infrastructureKeys.has(nodeKey(destination.chain, destinationAddress))) continue;
      const bridgeConfidence = Math.max(0.5, normalizeConfidence(correlation.confidence));
      addNode(nodes, source.chain, sourceAddress, source.sourceRole ? mapRole(source.sourceRole) : 'funding_wallet', bridgeConfidence, 'verified_official_bridge', { eventId: source.eventId });
      addNode(nodes, destination.chain, destinationAddress, 'bridge_linked_receiver', bridgeConfidence, 'verified_official_bridge', { eventId: destination.eventId });
      links.push({
        a: nodeKey(source.chain, sourceAddress), b: nodeKey(destination.chain, destinationAddress), confidence: bridgeConfidence,
        kind: 'verified_official_bridge', receipt: { correlationId: correlation.correlationId, protocol: correlation.protocol, officialMessageId: correlation.officialMessageId }
      });
      verifiedBridgeLinks += 1;
    }
  }

  const union = new UnionFind([...nodes.keys()]);
  for (const link of links) union.join(link.a, link.b);
  const components = new Map<NodeKey, NodeKey[]>();
  for (const key of nodes.keys()) {
    const root = union.find(key);
    const bucket = components.get(root) ?? [];
    bucket.push(key);
    components.set(root, bucket);
  }

  const keepEntityKeys: string[] = [];
  let multiChainEntities = 0;
  for (const members of components.values()) {
    members.sort();
    const entityKey = unifiedEntityKey(members);
    keepEntityKeys.push(entityKey);
    const memberSet = new Set(members);
    const componentLinks = links.filter((link) => memberSet.has(link.a) && memberSet.has(link.b));
    const chains = [...new Set(members.map((key) => splitKey(key)[0]))].sort() as ChainId[];
    if (chains.length > 1) multiChainEntities += 1;
    const confidence = componentLinks.length ? Math.min(...componentLinks.map((x) => x.confidence)) : Math.max(...members.map((x) => nodes.get(x)!.confidence));
    const entity = await prisma.unifiedEntity.upsert({
      where: { entityKey },
      create: {
        entityKey, chains, memberCount: members.length, confidence, evidenceJson: json({ links: componentLinks }),
        caveats: ['probabilistic on-chain relationship; not a claim that wallets belong to one person', 'shared token/router/CEX activity never merges entities'],
        engineVersion: UNIFIED_ENTITY_ENGINE_VERSION, computedAt: now
      },
      update: {
        chains, memberCount: members.length, confidence, evidenceJson: json({ links: componentLinks }),
        caveats: ['probabilistic on-chain relationship; not a claim that wallets belong to one person', 'shared token/router/CEX activity never merges entities'],
        engineVersion: UNIFIED_ENTITY_ENGINE_VERSION, computedAt: now
      }
    });
    for (const key of members) {
      const [chain, address] = splitKey(key);
      const evidence = nodes.get(key)!;
      await prisma.unifiedEntityAddress.upsert({
        where: { chain_address: { chain, address } },
        create: { entityId: entity.id, chain, address, role: evidence.role, evidenceTier: evidence.evidenceTier, confidence: evidence.confidence, evidenceJson: json(evidence.evidence), observationOnly: true },
        update: { entityId: entity.id, role: evidence.role, evidenceTier: evidence.evidenceTier, confidence: evidence.confidence, evidenceJson: json(evidence.evidence), observationOnly: true }
      });
    }
    await prisma.unifiedEntityAddress.deleteMany({
      where: { entityId: entity.id, NOT: { OR: members.map((key) => { const [chain, address] = splitKey(key); return { chain, address }; }) } }
    });
  }
  await prisma.unifiedEntity.deleteMany({ where: { entityKey: { notIn: keepEntityKeys } } });

  return { nodes: nodes.size, entities: components.size, multiChainEntities, verifiedBridgeLinks, sameEvmAddressLinks };
}

function addNode(nodes: Map<NodeKey, NodeEvidence>, chain: ChainId, address: string, role: string, confidence: number, evidenceTier: string, evidence: unknown) {
  const key = nodeKey(chain, address);
  const current = nodes.get(key);
  if (!current) {
    nodes.set(key, { role, confidence, evidenceTier, evidence: [evidence] });
    return;
  }
  current.evidence.push(evidence);
  if (roleRank(role) < roleRank(current.role) || (role === current.role && confidence > current.confidence)) {
    current.role = role;
    current.confidence = confidence;
    current.evidenceTier = evidenceTier;
  }
}

function mapRole(role: string): string {
  const map: Record<string, string> = {
    operator_root: 'root_main', root_main: 'root_main', funding_wallet: 'funding_wallet', execution_wallet: 'execution_wallet',
    probable_side_wallet: 'probable_side_wallet', probable_linked_wallet: 'probable_side_wallet', fresh_funded_receiver: 'fresh_funded_receiver',
    dormant_funded_receiver: 'dormant_funded_receiver', bridge_linked_receiver: 'bridge_linked_receiver', possible_cex_mediated_receiver: 'possible_cex_mediated_receiver',
    profit_collection_wallet: 'profit_collection_wallet', service_router_cex_node: 'service_router_cex_node', unknown_related_wallet: 'unknown_related_wallet'
  };
  return map[role] ?? 'unknown_related_wallet';
}

const ROLE_ORDER = ['root_main', 'funding_wallet', 'execution_wallet', 'profit_collection_wallet', 'bridge_linked_receiver', 'dormant_funded_receiver', 'fresh_funded_receiver', 'probable_side_wallet', 'possible_cex_mediated_receiver', 'unknown_related_wallet', 'service_router_cex_node'];
function roleRank(role: string) { const index = ROLE_ORDER.indexOf(role); return index === -1 ? ROLE_ORDER.length : index; }
function nodeKey(chain: ChainId, address: string): NodeKey { return `${chain}:${normalizeAddress(chain, address)}` as NodeKey; }
function splitKey(key: NodeKey): [ChainId, string] { const colon = key.indexOf(':'); return [key.slice(0, colon) as ChainId, key.slice(colon + 1)]; }
function unifiedEntityKey(members: NodeKey[]) { return `ue_${createHash('sha256').update(members.join('|')).digest('hex').slice(0, 24)}`; }
function normalizeConfidence(value: number) { return Math.max(0, Math.min(1, value > 1 ? value / 100 : value)); }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, Math.trunc(value))); }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
async function loadInfrastructureKeys(prisma: PrismaClient, rows: Array<{ chain: ChainId; address: string }>) {
  const result = new Set<NodeKey>();
  for (const chain of ['SOLANA', 'ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'] as ChainId[]) {
    const addresses = [...new Set(rows.filter((row) => row.chain === chain).map((row) => row.address))].sort();
    for (let index = 0; index < addresses.length; index += 5_000) {
      const registryRows = await prisma.addressRegistry.findMany({
        where: { chain, address: { in: addresses.slice(index, index + 5_000) } }, select: { chain: true, address: true }
      });
      for (const row of registryRows) result.add(nodeKey(row.chain, row.address));
    }
  }
  return result;
}

class UnionFind {
  private readonly parent = new Map<NodeKey, NodeKey>();
  constructor(keys: NodeKey[]) { for (const key of keys) this.parent.set(key, key); }
  find(key: NodeKey): NodeKey { const parent = this.parent.get(key) ?? key; if (parent === key) return key; const root = this.find(parent); this.parent.set(key, root); return root; }
  join(a: NodeKey, b: NodeKey) { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); }
}
