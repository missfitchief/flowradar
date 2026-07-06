// FlowRadar — wallet-graph BFS engine (Task 19).
//
// PURE: no I/O, no settings import. All tunables arrive via GraphSearchParams;
// the only I/O seam is the injected EdgeFetcher. perNodeTxCap (settings.graph)
// is documented here but NOT enforced by this module — it is the fetcher's
// concern (a live/mock EdgeFetcher slices its own per-node result set before
// returning it to runBfs; this module simply consumes whatever the fetcher
// hands back for a given address).
//
// -----------------------------------------------------------------------
// Two-gate traversal model (see task brief for the full derivation):
//
//   Gate 1 — universal admission filter. Applied to every edge returned by
//   the fetcher, mode-independent: amountUsd >= minTransferUsd; timeRange
//   (if set); relationship-type include-flag gating. An edge failing Gate 1
//   is never added to the graph — no node, no edge, invisible. This is also
//   where CAPITAL_FLOW/ENTITY_DISCOVERY's relationship-type ALLOWLIST is
//   enforced: it is a static, position-independent predicate on the edge's
//   own relationship value (exactly like an include-flag), so it belongs in
//   Gate 1, not in the per-node Gate 2 heuristics below. This keeps
//   CAPITAL_FLOW a coherent "money only" view and ENTITY_DISCOVERY a
//   coherent "wallet-relationship only" view — non-transfer-ish edges never
//   appear in either mode's graph at all, at any depth.
//
//   Gate 2 — mode-specific EXPANSION policy. Applied only to edges that
//   already passed Gate 1: decides whether the edge's destination node gets
//   enqueued onto the BFS frontier for further expansion. An edge/node that
//   fails Gate 2 is still fully visible in the result (added to nodes/edges)
//   — it simply never gets explored further. This is what CAPITAL_FLOW's
//   50%-of-inbound value heuristic and ENTITY_DISCOVERY's
//   txCount>=2-OR-significant-amount heuristic control. Both heuristics are
//   necessarily stateful/per-node (they compare against the edge that
//   discovered the node on THIS traversal), which is why they're vacuously
//   satisfied at the root (no inbound edge exists on the path to root).
//
//   Do-not-expand (registry/excludeRoutersPoolsContracts/CEX rule) is a
//   third, orthogonal Gate 2 condition layered on top of the mode's own
//   Gate 2 outcome — see `isDoNotExpand` below. Root always expands
//   regardless of any Gate 2 condition.
// -----------------------------------------------------------------------
//
// Global value-priority admission (fixes Critical 1 + Critical 2):
//
//   Admission under maxNodes/maxEdges is NOT parent-by-parent BFS. Every
//   Gate-1-passing edge discovered anywhere in the graph becomes a
//   CANDIDATE in a single global priority queue, ordered by
//   (amountUsd desc, txCount desc, insertion-order asc as a stable
//   tiebreak). We repeatedly pop the globally highest-priority candidate —
//   across ALL branches, not just the current parent's children — and only
//   THEN decide whether to admit it. This means a $100 grandchild of an
//   early-processed parent can no longer jump the queue ahead of a $5000
//   grandchild of a parent that merely happened to be discovered later:
//   both compete in the same pop order.
//
//   A candidate's edge and its destination node are committed ATOMICALLY at
//   a single commit point: the cap check (maxNodes/maxEdges) happens BEFORE
//   either the edge or the node is written, and if committing would exceed
//   either cap, NEITHER is written and the whole search stops (truncated).
//   This guarantees every edge in the result has both endpoints present in
//   the result's nodes — no orphan edges under a maxEdges/maxNodes cutoff.
//
//   maxDepth (and DIRECT's forced depth-1) still bounds candidate creation:
//   a node is only expanded (its outgoing edges fetched and turned into new
//   candidates) if its own depth is below effectiveMaxDepth; a candidate
//   whose resulting depth would exceed effectiveMaxDepth is never created.
//   Do-not-expand semantics (visible-but-not-enqueued) are unchanged.
// -----------------------------------------------------------------------

import type { GraphSearchParams, NodeType, WalletGraphRelationship } from '../types';
import type { EdgeFetcher, GraphEdge, GraphNode, RawGraphEdge, RegistryLookup } from './types';

const TRANSFER_ISH: ReadonlySet<WalletGraphRelationship> = new Set([
  'direct_transfer',
  'native_transfer',
  'token_transfer',
  'stablecoin_transfer'
]);

const CAPITAL_FLOW_ALLOWLIST: ReadonlySet<WalletGraphRelationship> = new Set([
  ...TRANSFER_ISH,
  'bridge_deposit',
  'bridge_withdrawal'
]);

const CONFIDENCE_BASE: Partial<Record<WalletGraphRelationship, number>> = {
  direct_transfer: 80,
  native_transfer: 80,
  token_transfer: 80,
  stablecoin_transfer: 80,
  bridge_deposit: 60,
  bridge_withdrawal: 60,
  cex_deposit: 40,
  cex_withdrawal: 40
};
const DEFAULT_CONFIDENCE_BASE = 50;
const CONFIDENCE_FLOOR = 10;

interface MutableNode {
  address: string;
  depth: number;
  nodeType: NodeType;
  totalSentUsd: number;
  totalReceivedUsd: number;
  interactionCount: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
  tags: string[];
  /** Max confidence contribution seen so far from inbound accepted edges. */
  confidence: number;
  /** Largest inbound edge amountUsd that discovered/reached this node during this traversal (undefined for root). */
  discoveryEdgeAmountUsd?: number;
}

interface MutableEdge {
  source: string;
  dest: string;
  relationship: WalletGraphRelationship;
  asset: string;
  amountUsd: number;
  txCount: number;
  firstTs: Date;
  lastTs: Date;
  sampleTxHashes: string[];
}

function passesIncludeFlags(relationship: WalletGraphRelationship, params: GraphSearchParams): boolean {
  switch (relationship) {
    case 'native_transfer':
      return params.includeNative;
    case 'token_transfer':
    case 'stablecoin_transfer':
      return params.includeToken;
    case 'swap_router_interaction':
      return params.includeSwaps;
    case 'bridge_deposit':
    case 'bridge_withdrawal':
      return params.includeBridges;
    case 'cex_deposit':
    case 'cex_withdrawal':
      return params.includeCex;
    case 'direct_transfer':
    case 'lp_interaction':
    case 'contract_interaction':
    case 'deployer_interaction':
    case 'unknown':
    default:
      return true;
  }
}

function passesModeRelationshipAllowlist(relationship: WalletGraphRelationship, mode: GraphSearchParams['mode']): boolean {
  if (mode === 'CAPITAL_FLOW') return CAPITAL_FLOW_ALLOWLIST.has(relationship);
  if (mode === 'ENTITY_DISCOVERY') return TRANSFER_ISH.has(relationship);
  return true; // DIRECT / FULL_RAW: no relationship-type restriction of their own
}

function passesGate1(edge: RawGraphEdge, params: GraphSearchParams): boolean {
  if (edge.amountUsd < params.minTransferUsd) return false;
  if (params.timeRange?.from && edge.lastTs < params.timeRange.from) return false;
  if (params.timeRange?.to && edge.firstTs > params.timeRange.to) return false;
  if (!passesIncludeFlags(edge.relationship, params)) return false;
  if (!passesModeRelationshipAllowlist(edge.relationship, params.mode)) return false;
  return true;
}

function mapRegistryCategoryToNodeType(category: NonNullable<ReturnType<RegistryLookup>>['category']): {
  nodeType: NodeType;
  extraTag?: string;
} {
  switch (category) {
    case 'CEX':
      return { nodeType: 'CEX' };
    case 'BRIDGE':
      return { nodeType: 'BRIDGE' };
    case 'ROUTER':
      return { nodeType: 'ROUTER' };
    case 'POOL':
      return { nodeType: 'POOL' };
    case 'MIXER':
      return { nodeType: 'CONTRACT', extraTag: 'mixer' };
    case 'TOKEN_CONTRACT':
      return { nodeType: 'TOKEN_CONTRACT' };
    case 'DEPLOYER':
      return { nodeType: 'WALLET', extraTag: 'deployer' };
    default:
      return { nodeType: 'WALLET' };
  }
}

function isDoNotExpand(
  address: string,
  registryHit: ReturnType<RegistryLookup>,
  nodeType: NodeType,
  params: GraphSearchParams
): boolean {
  if (registryHit?.doNotExpand) return true;
  if (params.excludeRoutersPoolsContracts && (nodeType === 'ROUTER' || nodeType === 'POOL' || nodeType === 'CONTRACT')) {
    return true;
  }
  if (nodeType === 'CEX') {
    return !(params.includeCex && params.mode === 'FULL_RAW');
  }
  return false;
}

export async function runBfs(
  params: GraphSearchParams,
  fetchEdges: EdgeFetcher,
  registry: RegistryLookup
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }> {
  const effectiveMaxDepth = params.mode === 'DIRECT' ? 1 : params.maxDepth;

  const nodes = new Map<string, MutableNode>();
  const edgeMap = new Map<string, MutableEdge>();
  let truncated = false;

  nodes.set(params.rootAddress, {
    address: params.rootAddress,
    depth: 0,
    nodeType: 'WALLET',
    totalSentUsd: 0,
    totalReceivedUsd: 0,
    interactionCount: 0,
    firstSeen: null,
    lastSeen: null,
    tags: [],
    confidence: 100
  });

  function nodeTypeAndTags(address: string, counterpartyType: NodeType | undefined): { nodeType: NodeType; tags: string[] } {
    const hit = registry(address);
    if (hit) {
      const { nodeType, extraTag } = mapRegistryCategoryToNodeType(hit.category);
      const tags = [hit.label, hit.category.toLowerCase()];
      if (extraTag) tags.push(extraTag);
      return { nodeType, tags };
    }
    return { nodeType: counterpartyType ?? 'WALLET', tags: [] };
  }

  function edgeKey(e: { source: string; dest: string; relationship: WalletGraphRelationship }): string {
    return `${e.source}${e.dest}${e.relationship}`;
  }

  // Global candidate priority queue. Every Gate-1-passing edge discovered
  // anywhere in the graph — regardless of which parent it came from —
  // becomes one candidate here, and candidates compete for admission in a
  // single total order: amountUsd desc, txCount desc, insertionSeq asc
  // (stable tiebreak; insertion order is itself fully determined by prior
  // pops, so the whole traversal is deterministic).
  interface Candidate {
    raw: RawGraphEdge;
    destDepth: number;
    sourceIsRoot: boolean;
    sourceDiscoveryAmountUsd: number;
    insertionSeq: number;
  }

  let insertionSeqCounter = 0;
  const queue: Candidate[] = [];
  const enqueuedForExpansion = new Set<string>([params.rootAddress]);

  // Fetches `address`'s outgoing edges and turns every Gate-1-passing,
  // depth-bounded edge into a new candidate on the global queue. Does
  // nothing if `depth` is already at/beyond effectiveMaxDepth (DIRECT's
  // forced depth-1 bound, or maxDepth, are both enforced here — a candidate
  // beyond effectiveMaxDepth is never created).
  async function expandNode(address: string, depth: number, isRootNode: boolean, discoveryAmountUsd: number): Promise<void> {
    if (depth >= effectiveMaxDepth) return;

    const rawEdges = await fetchEdges(address, params.chain, params);
    // Sort this node's own outgoing edges by amountUsd desc, txCount desc so
    // insertion order into the global queue is deterministic and value-first
    // among same-node siblings (the global sort below then re-orders across
    // ALL branches, using insertionSeq only as the final tiebreak).
    const sorted = [...rawEdges].sort((a, b) => b.amountUsd - a.amountUsd || b.txCount - a.txCount);

    for (const raw of sorted) {
      if (raw.source !== address) continue; // fetcher contract: edges FROM this address
      if (!passesGate1(raw, params)) continue;

      const destDepth = depth + 1;
      if (destDepth > effectiveMaxDepth) continue;

      queue.push({
        raw,
        destDepth,
        sourceIsRoot: isRootNode,
        sourceDiscoveryAmountUsd: discoveryAmountUsd,
        insertionSeq: insertionSeqCounter++
      });
    }
  }

  await expandNode(params.rootAddress, 0, true, Number.POSITIVE_INFINITY);

  while (queue.length > 0) {
    // Global total order: highest value first, across every branch, with a
    // deterministic stable tiebreak (insertion order) for exact ties.
    queue.sort(
      (a, b) =>
        b.raw.amountUsd - a.raw.amountUsd ||
        b.raw.txCount - a.raw.txCount ||
        a.insertionSeq - b.insertionSeq
    );

    const candidate = queue.shift()!;
    const raw = candidate.raw;
    const destAddress = raw.dest;
    const destDepth = candidate.destDepth;

    const destExistsAlready = nodes.has(destAddress);
    const key = edgeKey(raw);
    const edgeIsNew = !edgeMap.has(key);

    // Single commit point (fixes Critical 2): check BOTH caps before writing
    // anything. If admitting this candidate's edge (and, if needed, its new
    // node) would exceed either cap, commit NEITHER — never leave an edge
    // dangling with a missing endpoint. Truncation is a hard stop: candidates
    // are popped in global value order, so the admitted set is always a
    // prefix of that order.
    const wouldExceedNodes = !destExistsAlready && nodes.size + 1 > params.maxNodes;
    const wouldExceedEdges = edgeIsNew && edgeMap.size + 1 > params.maxEdges;
    if (wouldExceedNodes || wouldExceedEdges) {
      truncated = true;
      break;
    }

    // --- commit: edge ---
    if (edgeIsNew) {
      edgeMap.set(key, {
        source: raw.source,
        dest: raw.dest,
        relationship: raw.relationship,
        asset: raw.asset,
        amountUsd: raw.amountUsd,
        txCount: raw.txCount,
        firstTs: raw.firstTs,
        lastTs: raw.lastTs,
        sampleTxHashes: [...raw.sampleTxHashes].slice(0, 5)
      });
    } else {
      const existing = edgeMap.get(key)!;
      existing.amountUsd += raw.amountUsd;
      existing.txCount += raw.txCount;
      if (raw.firstTs < existing.firstTs) existing.firstTs = raw.firstTs;
      if (raw.lastTs > existing.lastTs) existing.lastTs = raw.lastTs;
      for (const h of raw.sampleTxHashes) {
        if (existing.sampleTxHashes.length >= 5) break;
        if (!existing.sampleTxHashes.includes(h)) existing.sampleTxHashes.push(h);
      }
    }

    // --- commit: node (first edge touching an address creates it) ---
    let destNode = nodes.get(destAddress);
    if (!destNode) {
      const { nodeType, tags } = nodeTypeAndTags(destAddress, raw.counterpartyType);
      destNode = {
        address: destAddress,
        depth: destDepth,
        nodeType,
        totalSentUsd: 0,
        totalReceivedUsd: 0,
        interactionCount: 0,
        firstSeen: null,
        lastSeen: null,
        tags,
        confidence: CONFIDENCE_FLOOR,
        discoveryEdgeAmountUsd: raw.amountUsd
      };
      nodes.set(destAddress, destNode);
    } else if (destNode.discoveryEdgeAmountUsd === undefined || raw.amountUsd > destNode.discoveryEdgeAmountUsd) {
      destNode.discoveryEdgeAmountUsd = raw.amountUsd;
    }

    // aggregates: update BOTH endpoints touched by this accepted edge
    const srcNode = nodes.get(raw.source)!;
    srcNode.totalSentUsd += raw.amountUsd;
    srcNode.interactionCount += raw.txCount;
    srcNode.firstSeen = srcNode.firstSeen === null || raw.firstTs < srcNode.firstSeen ? raw.firstTs : srcNode.firstSeen;
    srcNode.lastSeen = srcNode.lastSeen === null || raw.lastTs > srcNode.lastSeen ? raw.lastTs : srcNode.lastSeen;

    destNode.totalReceivedUsd += raw.amountUsd;
    destNode.interactionCount += raw.txCount;
    destNode.firstSeen = destNode.firstSeen === null || raw.firstTs < destNode.firstSeen ? raw.firstTs : destNode.firstSeen;
    destNode.lastSeen = destNode.lastSeen === null || raw.lastTs > destNode.lastSeen ? raw.lastTs : destNode.lastSeen;

    // confidence: max over inbound accepted edges of (base - 10*(depth-1)), floored
    const base = CONFIDENCE_BASE[raw.relationship] ?? DEFAULT_CONFIDENCE_BASE;
    const decayed = Math.max(CONFIDENCE_FLOOR, base - 10 * (destDepth - 1));
    destNode.confidence = Math.max(destNode.confidence === CONFIDENCE_FLOOR ? 0 : destNode.confidence, decayed);
    if (destNode.confidence < CONFIDENCE_FLOOR) destNode.confidence = CONFIDENCE_FLOOR;

    // Gate 2: should destAddress be enqueued for further expansion? Only
    // ever attempted once successfully (enqueuedForExpansion guard) — but a
    // dest that failed Gate 2 via an earlier, weaker inbound edge gets
    // re-evaluated against THIS edge, matching prior (per-parent) semantics.
    if (enqueuedForExpansion.has(destAddress)) continue;

    let gate2Pass: boolean;
    if (params.mode === 'CAPITAL_FLOW') {
      gate2Pass = passesCapitalFlowValueHeuristic(raw, candidate.sourceIsRoot, candidate.sourceDiscoveryAmountUsd);
    } else if (params.mode === 'ENTITY_DISCOVERY') {
      gate2Pass = raw.txCount >= 2 || raw.amountUsd >= 10 * params.minTransferUsd;
    } else {
      gate2Pass = true;
    }

    if (!gate2Pass) continue;
    if (isDoNotExpand(destAddress, registry(destAddress), destNode.nodeType, params) && destAddress !== params.rootAddress) {
      continue;
    }

    enqueuedForExpansion.add(destAddress);
    await expandNode(destAddress, destDepth, false, raw.amountUsd);
  }

  const resultNodes: GraphNode[] = [...nodes.values()].map((n) => ({
    address: n.address,
    depth: n.depth,
    nodeType: n.nodeType,
    totalSentUsd: n.totalSentUsd,
    totalReceivedUsd: n.totalReceivedUsd,
    netFlowUsd: n.totalReceivedUsd - n.totalSentUsd,
    interactionCount: n.interactionCount,
    firstSeen: n.firstSeen,
    lastSeen: n.lastSeen,
    tags: n.tags,
    confidence: n.address === params.rootAddress ? 100 : n.confidence
  }));

  const resultEdges: GraphEdge[] = [...edgeMap.values()].map((e) => ({ ...e }));

  return { nodes: resultNodes, edges: resultEdges, truncated };
}

function passesCapitalFlowValueHeuristic(raw: RawGraphEdge, isRootSource: boolean, sourceDiscoveryAmountUsd: number): boolean {
  if (isRootSource) return true; // root has no inbound edge on the traversal path: vacuously qualifies
  return raw.amountUsd >= 0.5 * sourceDiscoveryAmountUsd;
}
