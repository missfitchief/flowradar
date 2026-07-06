import { describe, expect, it } from 'vitest';
import { runBfs } from '../src/graph/bfs';
import type { EdgeFetcher, GraphNode, RawGraphEdge, RegistryLookup } from '../src/graph/types';
import type { Chain, GraphSearchParams, WalletGraphRelationship } from '../src/types';

// ---------------------------------------------------------------------------
// Fixture graph: R, A, B, C, X, D, K, L, M, BR, S, N (+ decoys Z, Z2), plus
// controller-supplement additions BR2/H1 (bridge doNotExpand) and P/H2 (pool
// doNotExpand), and fan-out-bomb node F with 50 counterparties.
//
// Every literal below is a constant (fixed base date T0 + fixed minute
// offsets); there is no Date.now()/PRNG anywhere in this fixture, so the
// whole graph — and every assertion against it — is fully deterministic.
//
//   R --10000 direct_transfer t0-------------------> A
//   A --9800  direct_transfer t0+10m----------------> B
//   B --9500  direct_transfer t0+25m----------------> C
//   A --100   direct_transfer t0+11m----------------> Z    (decoy: < 50% of A's 10000 inbound)
//   R --3000  swap_router_interaction t0------------> X    (router, registry doNotExpand)
//   X --3000  direct_transfer t0+5m------------------> D    (only reachable if X expands)
//   R --4000  cex_deposit t0-------------------------> K    (registry CEX)
//   R --50    direct_transfer t0----------------------> L    (below default minTransferUsd 100)
//   R --500x3 direct_transfer t0----------------------> M    (repeated pair)
//   M --500x3 direct_transfer t0+1h-------------------> R    (repeated pair, reverse leg)
//   R --2000  bridge_deposit t0------------------------> BR
//   R --5000  swap_router_interaction t0---------------> S
//   R --150   direct_transfer(txCount 1) t0-------------> N   (decoy: below entity-discovery heuristic)
//   N --999   direct_transfer t0+1h---------------------> Z2  (must never appear — N must not expand)
//   R --2500  bridge_deposit t0--------------------------> BR2  (registry BRIDGE, doNotExpand)
//   BR2 --2500 direct_transfer t0+5m----------------------> H1   (only reachable if BR2 expands)
//   R --1800  lp_interaction t0---------------------------> P    (registry POOL, doNotExpand)
//   P --1800  direct_transfer t0+5m------------------------> H2   (only reachable if P expands)
//   R --1500  direct_transfer t0---------------------------> F     (fan-out bomb hub)
//   F --(1000-i) direct_transfer t0+1m per i=0..49-----------> F0..F49 (50 counterparties)
//
// Negative-time fixture (separate small graph) for extractPaths' timeGapMs<0 drop case
// is built inline in the paths test file.
// ---------------------------------------------------------------------------

const T0 = new Date('2026-01-01T00:00:00Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

function edge(
  source: string,
  dest: string,
  relationship: WalletGraphRelationship,
  amountUsd: number,
  ts: Date,
  txCount = 1,
  counterpartyType?: RawGraphEdge['counterpartyType']
): RawGraphEdge {
  return {
    source,
    dest,
    relationship,
    asset: 'USDC',
    amountUsd,
    txCount,
    firstTs: ts,
    lastTs: ts,
    sampleTxHashes: [`tx-${source}-${dest}-${ts.getTime()}`],
    counterpartyType
  };
}

const ALL_EDGES: RawGraphEdge[] = [
  edge('R', 'A', 'direct_transfer', 10000, minutes(0)),
  edge('A', 'B', 'direct_transfer', 9800, minutes(10)),
  edge('B', 'C', 'direct_transfer', 9500, minutes(25)),
  edge('A', 'Z', 'direct_transfer', 100, minutes(11)),
  edge('R', 'X', 'swap_router_interaction', 3000, minutes(0), 1, 'ROUTER'),
  edge('X', 'D', 'direct_transfer', 3000, minutes(5)),
  edge('R', 'K', 'cex_deposit', 4000, minutes(0), 1, 'CEX'),
  edge('R', 'L', 'direct_transfer', 50, minutes(0)),
  edge('R', 'M', 'direct_transfer', 500, minutes(0), 3),
  edge('M', 'R', 'direct_transfer', 500, minutes(60), 3),
  edge('R', 'BR', 'bridge_deposit', 2000, minutes(0)),
  edge('R', 'S', 'swap_router_interaction', 5000, minutes(0)),
  edge('R', 'N', 'direct_transfer', 150, minutes(0), 1),
  edge('N', 'Z2', 'direct_transfer', 999, minutes(60)),
  edge('R', 'BR2', 'bridge_deposit', 2500, minutes(0)),
  edge('BR2', 'H1', 'direct_transfer', 2500, minutes(5)),
  edge('R', 'P', 'lp_interaction', 1800, minutes(0)),
  edge('P', 'H2', 'direct_transfer', 1800, minutes(5)),
  edge('R', 'F', 'direct_transfer', 1500, minutes(0)),
  ...Array.from({ length: 50 }, (_, i) => edge('F', `F${i}`, 'direct_transfer', 1000 - i, minutes(1)))
];

// Note on doNotExpand vs excludeRoutersPoolsContracts:
//   - excludeRoutersPoolsContracts (the params flag) covers ROUTER/POOL/CONTRACT
//     categories by name — X and P are blocked BY CATEGORY, so toggling the
//     flag actually changes their expansion outcome (doNotExpand left false).
//   - "Routers/Pools/Contracts" does not name CEX or BRIDGE: CEX has its own
//     dedicated rule (never expands unless includeCex && FULL_RAW); BRIDGE has
//     neither a flag nor a dedicated rule, so a bridge node is only blocked via
//     the registry's own doNotExpand — BR2 sets it true to model "this specific
//     bridge address is flagged as a dead end," independent of the flag.
const REGISTRY: Record<string, ReturnType<RegistryLookup>> = {
  X: { category: 'ROUTER', label: 'Some Router', doNotExpand: false },
  K: { category: 'CEX', label: 'Some CEX', doNotExpand: false },
  BR2: { category: 'BRIDGE', label: 'Some Bridge', doNotExpand: true },
  P: { category: 'POOL', label: 'Some Pool', doNotExpand: false }
};

const registry: RegistryLookup = (address) => REGISTRY[address] ?? null;

function makeFetcher(edges: RawGraphEdge[] = ALL_EDGES): EdgeFetcher {
  return async (address: string) => edges.filter((e) => e.source === address);
}

function baseParams(overrides: Partial<GraphSearchParams> = {}): GraphSearchParams {
  return {
    rootAddress: 'R',
    chain: 'SOLANA' as Chain,
    mode: 'FULL_RAW',
    maxDepth: 3,
    minTransferUsd: 100,
    includeNative: true,
    includeToken: true,
    includeSwaps: true,
    includeBridges: true,
    includeCex: true,
    excludeRoutersPoolsContracts: true,
    maxNodes: 5000,
    maxEdges: 25000,
    ...overrides
  };
}

function addr(nodes: GraphNode[], address: string): GraphNode | undefined {
  return nodes.find((n) => n.address === address);
}

describe('runBfs', () => {
  it('DIRECT mode returns only depth-1 neighbors and respects base filters', async () => {
    const result = await runBfs(baseParams({ mode: 'DIRECT', maxDepth: 3 }), makeFetcher(), registry);

    const depths = new Map(result.nodes.map((n) => [n.address, n.depth]));
    expect(depths.get('R')).toBe(0);
    expect(depths.get('A')).toBe(1);
    expect(depths.get('X')).toBe(1);
    expect(depths.get('K')).toBe(1);
    expect(depths.get('BR')).toBe(1);
    expect(depths.get('S')).toBe(1);
    expect(depths.get('M')).toBe(1);

    // depth-2 never reached regardless of maxDepth param
    expect(depths.has('B')).toBe(false);
    expect(depths.has('D')).toBe(false);

    // low-value edge filtered
    expect(depths.has('L')).toBe(false);
  });

  it('default excludeRoutersPoolsContracts shows router X and CEX K as nodes but never expands to D', async () => {
    const result = await runBfs(baseParams({ mode: 'FULL_RAW' }), makeFetcher(), registry);

    expect(addr(result.nodes, 'X')).toBeDefined();
    expect(addr(result.nodes, 'X')?.nodeType).toBe('ROUTER');
    expect(addr(result.nodes, 'K')).toBeDefined();
    expect(addr(result.nodes, 'K')?.nodeType).toBe('CEX');
    expect(addr(result.nodes, 'D')).toBeUndefined();
  });

  it('toggling excludeRoutersPoolsContracts false reaches D through router X', async () => {
    const result = await runBfs(
      baseParams({ mode: 'FULL_RAW', excludeRoutersPoolsContracts: false }),
      makeFetcher(),
      registry
    );

    expect(addr(result.nodes, 'X')).toBeDefined();
    expect(addr(result.nodes, 'D')).toBeDefined();
    expect(addr(result.nodes, 'D')?.depth).toBe(2);
  });

  it('CEX node K never expands even with excludeRoutersPoolsContracts false, unless includeCex && FULL_RAW', async () => {
    // K itself has no outgoing edges in the fixture, so assert indirectly:
    // this test documents the rule via a variant fetcher where K->K2 exists.
    const withCexChild = [...ALL_EDGES, edge('K', 'K2', 'direct_transfer', 1000, minutes(0))];
    const fetcher = makeFetcher(withCexChild);

    const blocked = await runBfs(
      baseParams({ mode: 'FULL_RAW', excludeRoutersPoolsContracts: false, includeCex: false }),
      fetcher,
      registry
    );
    expect(addr(blocked.nodes, 'K2')).toBeUndefined();

    const allowed = await runBfs(
      baseParams({ mode: 'FULL_RAW', excludeRoutersPoolsContracts: false, includeCex: true }),
      fetcher,
      registry
    );
    expect(addr(allowed.nodes, 'K2')).toBeDefined();
  });

  it('all four do-not-expand registry categories (router/CEX/bridge/pool) are visible but never expand by default', async () => {
    const result = await runBfs(baseParams({ mode: 'FULL_RAW' }), makeFetcher(), registry);

    expect(addr(result.nodes, 'X')).toBeDefined();
    expect(addr(result.nodes, 'X')?.nodeType).toBe('ROUTER');
    expect(addr(result.nodes, 'K')).toBeDefined();
    expect(addr(result.nodes, 'K')?.nodeType).toBe('CEX');
    expect(addr(result.nodes, 'BR2')).toBeDefined();
    expect(addr(result.nodes, 'BR2')?.nodeType).toBe('BRIDGE');
    expect(addr(result.nodes, 'P')).toBeDefined();
    expect(addr(result.nodes, 'P')?.nodeType).toBe('POOL');

    // none of the hidden nodes behind these do-not-expand nodes ever appear
    expect(addr(result.nodes, 'D')).toBeUndefined();
    expect(addr(result.nodes, 'H1')).toBeUndefined();
    expect(addr(result.nodes, 'H2')).toBeUndefined();
  });

  it('toggling excludeRoutersPoolsContracts false (FULL_RAW) reaches D (router) and H2 (pool) — category-driven blocks', async () => {
    const result = await runBfs(
      baseParams({ mode: 'FULL_RAW', excludeRoutersPoolsContracts: false }),
      makeFetcher(),
      registry
    );

    expect(addr(result.nodes, 'D')).toBeDefined();
    expect(addr(result.nodes, 'H2')).toBeDefined();
    // BR2 is blocked via registry.doNotExpand (independent of the flag), so H1
    // stays unreachable even with excludeRoutersPoolsContracts false.
    expect(addr(result.nodes, 'H1')).toBeUndefined();
  });

  it('registry.doNotExpand blocks BR2 independently of excludeRoutersPoolsContracts, but unblocks when false', async () => {
    const registryWithoutBridgeFlag: RegistryLookup = (address) =>
      address === 'BR2' ? { category: 'BRIDGE', label: 'Some Bridge', doNotExpand: false } : registry(address);

    const result = await runBfs(
      baseParams({ mode: 'FULL_RAW', excludeRoutersPoolsContracts: false }),
      makeFetcher(),
      registryWithoutBridgeFlag
    );
    expect(addr(result.nodes, 'H1')).toBeDefined();
  });

  it('minTransferUsd filters low-value edge L', async () => {
    const result = await runBfs(baseParams({ mode: 'FULL_RAW', minTransferUsd: 100 }), makeFetcher(), registry);
    expect(addr(result.nodes, 'L')).toBeUndefined();

    const lowered = await runBfs(baseParams({ mode: 'FULL_RAW', minTransferUsd: 10 }), makeFetcher(), registry);
    expect(addr(lowered.nodes, 'L')).toBeDefined();
  });

  it('includeSwaps gates swap edge S', async () => {
    const hidden = await runBfs(baseParams({ mode: 'FULL_RAW', includeSwaps: false }), makeFetcher(), registry);
    expect(addr(hidden.nodes, 'S')).toBeUndefined();

    const shown = await runBfs(baseParams({ mode: 'FULL_RAW', includeSwaps: true }), makeFetcher(), registry);
    expect(addr(shown.nodes, 'S')).toBeDefined();
  });

  it('includeBridges gates bridge edge BR', async () => {
    const hidden = await runBfs(baseParams({ mode: 'FULL_RAW', includeBridges: false }), makeFetcher(), registry);
    expect(addr(hidden.nodes, 'BR')).toBeUndefined();

    const shown = await runBfs(baseParams({ mode: 'FULL_RAW', includeBridges: true }), makeFetcher(), registry);
    expect(addr(shown.nodes, 'BR')).toBeDefined();
  });

  it('includeCex gates cex edge K (deposit itself, not just expansion)', async () => {
    const hidden = await runBfs(baseParams({ mode: 'FULL_RAW', includeCex: false }), makeFetcher(), registry);
    expect(addr(hidden.nodes, 'K')).toBeUndefined();

    const shown = await runBfs(baseParams({ mode: 'FULL_RAW', includeCex: true }), makeFetcher(), registry);
    expect(addr(shown.nodes, 'K')).toBeDefined();
  });

  it('maxDepth honored: depth-3 reaches C, depth-2 does not', async () => {
    const deep = await runBfs(
      baseParams({ mode: 'FULL_RAW', maxDepth: 3, excludeRoutersPoolsContracts: false }),
      makeFetcher(),
      registry
    );
    expect(addr(deep.nodes, 'C')).toBeDefined();
    expect(addr(deep.nodes, 'C')?.depth).toBe(3);

    const shallow = await runBfs(
      baseParams({ mode: 'FULL_RAW', maxDepth: 2, excludeRoutersPoolsContracts: false }),
      makeFetcher(),
      registry
    );
    expect(addr(shallow.nodes, 'C')).toBeUndefined();
    expect(addr(shallow.nodes, 'B')).toBeDefined();
  });

  it('maxNodes caps node count and sets truncated true', async () => {
    const result = await runBfs(baseParams({ mode: 'FULL_RAW', maxNodes: 3 }), makeFetcher(), registry);
    expect(result.truncated).toBe(true);
    expect(result.nodes.length).toBeLessThanOrEqual(3);
  });

  it('maxEdges caps edge count and sets truncated true', async () => {
    const result = await runBfs(baseParams({ mode: 'FULL_RAW', maxEdges: 2 }), makeFetcher(), registry);
    expect(result.truncated).toBe(true);
    expect(result.edges.length).toBeLessThanOrEqual(2);
  });

  it('frontier priority: largest edge expanded first, observable via truncation with small maxNodes', async () => {
    // Root has children by amountUsd desc: A(10000), S(5000), K(4000), X(3000), BR(2000), M(500), N(150), L(50 filtered).
    // With maxNodes small, the highest-value depth-1 nodes must be added before lower-value ones.
    const result = await runBfs(baseParams({ mode: 'FULL_RAW', maxNodes: 2 }), makeFetcher(), registry);
    // root + first frontier node by amountUsd desc = A
    expect(addr(result.nodes, 'R')).toBeDefined();
    expect(addr(result.nodes, 'A')).toBeDefined();
    expect(result.nodes.length).toBe(2);
  });

  it('fan-out bomb: F has 50 counterparties, maxNodes 20 truncates and admits highest-value first', async () => {
    const result = await runBfs(baseParams({ mode: 'FULL_RAW', maxDepth: 3, maxNodes: 20 }), makeFetcher(), registry);

    expect(result.truncated).toBe(true);
    expect(result.nodes.length).toBeLessThanOrEqual(20);

    // F's children are F0..F49 with amountUsd = 1000-i (F0 highest at 1000, F49 lowest at 951).
    // Whichever F-children got admitted before the cap hit must be a prefix of the
    // amountUsd-desc order — i.e. if F13 (987) was admitted, F0..F12 (988-1000) must all be present too.
    const admittedF = result.nodes
      .map((n) => n.address)
      .filter((a) => /^F\d+$/.test(a))
      .map((a) => Number(a.slice(1)))
      .sort((a, b) => a - b);

    for (let i = 0; i < admittedF.length; i++) {
      expect(admittedF[i]).toBe(i);
    }
  });

  it('CAPITAL_FLOW follows the decaying R->A->B->C chain', async () => {
    const result = await runBfs(baseParams({ mode: 'CAPITAL_FLOW', maxDepth: 3 }), makeFetcher(), registry);

    expect(addr(result.nodes, 'A')).toBeDefined();
    expect(addr(result.nodes, 'B')).toBeDefined();
    expect(addr(result.nodes, 'C')).toBeDefined();
    expect(addr(result.nodes, 'C')?.depth).toBe(3);
  });

  it('CAPITAL_FLOW does not expand through the sub-50%-of-inbound decoy A->Z', async () => {
    const withZChild = [...ALL_EDGES, edge('Z', 'Z3', 'direct_transfer', 100, minutes(20))];
    const result = await runBfs(baseParams({ mode: 'CAPITAL_FLOW', maxDepth: 3 }), makeFetcher(withZChild), registry);

    // Z itself is visible (edge passes relationship-type + base filters)...
    expect(addr(result.nodes, 'Z')).toBeDefined();
    // ...but is never expanded because 100 < 50% of A's inbound 10000.
    expect(addr(result.nodes, 'Z3')).toBeUndefined();
  });

  it('CAPITAL_FLOW excludes non-transfer-ish edges (swap/router/cex) from the graph entirely', async () => {
    const result = await runBfs(baseParams({ mode: 'CAPITAL_FLOW', maxDepth: 3 }), makeFetcher(), registry);

    expect(addr(result.nodes, 'S')).toBeUndefined(); // swap
    expect(addr(result.nodes, 'X')).toBeUndefined(); // router interaction
    expect(addr(result.nodes, 'K')).toBeUndefined(); // cex_deposit is transfer-ish? no — excluded per relationship allowlist
    expect(addr(result.nodes, 'BR')).toBeDefined(); // bridge_deposit IS in the CAPITAL_FLOW allowlist
  });

  it('ENTITY_DISCOVERY expands the repeated-transfer pair M (txCount 3)', async () => {
    const result = await runBfs(baseParams({ mode: 'ENTITY_DISCOVERY', maxDepth: 3 }), makeFetcher(), registry);

    expect(addr(result.nodes, 'M')).toBeDefined();
    // M -> R is a dedupe/back-edge to the root (already visited), so instead
    // assert M's forward expansion by giving M a fresh child in a variant fetcher.
  });

  it('ENTITY_DISCOVERY excludes non-transfer relationship edges (swap/router/cex/bridge) entirely', async () => {
    const result = await runBfs(baseParams({ mode: 'ENTITY_DISCOVERY', maxDepth: 3 }), makeFetcher(), registry);

    expect(addr(result.nodes, 'S')).toBeUndefined(); // swap
    expect(addr(result.nodes, 'X')).toBeUndefined(); // router interaction
    expect(addr(result.nodes, 'K')).toBeUndefined(); // cex_deposit
    expect(addr(result.nodes, 'BR')).toBeUndefined(); // bridge_deposit — narrower allowlist than CAPITAL_FLOW
  });

  it('ENTITY_DISCOVERY expands repeated M to reach a fresh downstream node', async () => {
    const withMChild = [...ALL_EDGES, edge('M', 'M2', 'direct_transfer', 200, minutes(70), 1)];
    const result = await runBfs(
      baseParams({ mode: 'ENTITY_DISCOVERY', maxDepth: 3 }),
      makeFetcher(withMChild),
      registry
    );
    expect(addr(result.nodes, 'M2')).toBeDefined();
  });

  it('ENTITY_DISCOVERY does not expand past the one-shot small decoy N', async () => {
    const result = await runBfs(baseParams({ mode: 'ENTITY_DISCOVERY', maxDepth: 3 }), makeFetcher(), registry);

    // N is visible at depth 1 (relationship type qualifies)...
    expect(addr(result.nodes, 'N')).toBeDefined();
    expect(addr(result.nodes, 'N')?.depth).toBe(1);
    // ...but does not expand further: Z2 (behind N) must never appear.
    expect(addr(result.nodes, 'Z2')).toBeUndefined();
  });

  it('node aggregates: A has correct sent/received/net/interactionCount/first-lastSeen', async () => {
    const result = await runBfs(
      baseParams({ mode: 'FULL_RAW', excludeRoutersPoolsContracts: false }),
      makeFetcher(),
      registry
    );
    const a = addr(result.nodes, 'A');
    expect(a).toBeDefined();
    expect(a?.totalReceivedUsd).toBe(10000);
    expect(a?.totalSentUsd).toBe(9800 + 100); // B leg + Z decoy leg
    expect(a?.netFlowUsd).toBe(10000 - (9800 + 100));
    expect(a?.interactionCount).toBe(3); // R->A, A->B, A->Z
    expect(a?.firstSeen?.getTime()).toBe(minutes(0).getTime());
    expect(a?.lastSeen?.getTime()).toBe(minutes(11).getTime());
  });

  it('confidence: root is 100, decays by depth, floored at 10', async () => {
    const result = await runBfs(
      baseParams({ mode: 'FULL_RAW', excludeRoutersPoolsContracts: false, maxDepth: 3 }),
      makeFetcher(),
      registry
    );
    const root = addr(result.nodes, 'R');
    const a = addr(result.nodes, 'A'); // depth 1, direct_transfer inbound (base 80)
    const b = addr(result.nodes, 'B'); // depth 2, direct_transfer inbound (base 80 - 10)
    const c = addr(result.nodes, 'C'); // depth 3, direct_transfer inbound (base 80 - 20)

    expect(root?.confidence).toBe(100);
    expect(a?.confidence).toBe(80);
    expect(b?.confidence).toBe(70);
    expect(c?.confidence).toBe(60);
  });

  it('edge dedupe merges duplicate (source,dest,relationship) edges', async () => {
    const dup = [
      ...ALL_EDGES,
      edge('R', 'A', 'direct_transfer', 500, minutes(120), 2)
    ];
    const result = await runBfs(baseParams({ mode: 'FULL_RAW' }), makeFetcher(dup), registry);

    const raEdges = result.edges.filter((e) => e.source === 'R' && e.dest === 'A' && e.relationship === 'direct_transfer');
    expect(raEdges.length).toBe(1);
    expect(raEdges[0].amountUsd).toBe(10000 + 500);
    expect(raEdges[0].txCount).toBe(1 + 2);
    expect(raEdges[0].lastTs.getTime()).toBe(minutes(120).getTime());
    expect(raEdges[0].sampleTxHashes.length).toBeLessThanOrEqual(5);
  });

  it('root always expands regardless of registry/exclude flags', async () => {
    const rootIsRouter: RegistryLookup = (address) =>
      address === 'R' ? { category: 'ROUTER', label: 'root-as-router', doNotExpand: true } : registry(address);

    const result = await runBfs(baseParams({ mode: 'FULL_RAW' }), makeFetcher(), rootIsRouter);
    expect(addr(result.nodes, 'A')).toBeDefined();
  });
});
