import { describe, expect, it } from 'vitest';
import { extractPaths } from '../src/graph/paths';
import type { GraphEdge, GraphNode } from '../src/graph/types';

const T0 = new Date('2026-01-01T00:00:00Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

function node(address: string, confidence: number, depth: number): GraphNode {
  return {
    address,
    depth,
    nodeType: 'WALLET',
    totalSentUsd: 0,
    totalReceivedUsd: 0,
    netFlowUsd: 0,
    interactionCount: 1,
    firstSeen: minutes(0),
    lastSeen: minutes(0),
    tags: [],
    confidence
  };
}

function edge(source: string, dest: string, amountUsd: number, ts: Date): GraphEdge {
  return {
    source,
    dest,
    relationship: 'direct_transfer',
    asset: 'USDC',
    amountUsd,
    txCount: 1,
    firstTs: ts,
    lastTs: ts,
    sampleTxHashes: [`tx-${source}-${dest}`]
  };
}

describe('extractPaths', () => {
  const nodes: GraphNode[] = [
    node('R', 100, 0),
    node('A', 80, 1),
    node('B', 70, 2),
    node('C', 60, 3)
  ];
  const edges: GraphEdge[] = [
    edge('R', 'A', 10000, minutes(0)),
    edge('A', 'B', 9800, minutes(10)),
    edge('B', 'C', 9500, minutes(25))
  ];

  it('finds R->A->B->C with value retention, positive time gap, and min confidence', () => {
    const paths = extractPaths(nodes, edges, 'R');
    const full = paths.find((p) => p.addresses.join('>') === 'R>A>B>C');

    expect(full).toBeDefined();
    expect(full?.totalPathValueUsd).toBe(9500);
    expect(full?.valueRetentionPct).toBeCloseTo(95, 5);
    expect(full?.timeGapMs).toBe(minutes(25).getTime() - minutes(0).getTime());
    expect(full?.timeGapMs).toBeGreaterThan(0);
    expect(full?.confidence).toBe(60); // min(100, 80, 70, 60)
  });

  it('drops paths whose value moves backwards in time', () => {
    const backwardsEdges: GraphEdge[] = [
      edge('R', 'A', 10000, minutes(30)),
      edge('A', 'B', 9800, minutes(10)) // earlier than the R->A hop: time moves backwards
    ];
    const paths = extractPaths(nodes, backwardsEdges, 'R');
    expect(paths.find((p) => p.addresses.join('>') === 'R>A>B')).toBeUndefined();
  });

  it('caps results at maxPaths', () => {
    // Build a root fanning out to many 2-hop branches so there are more than maxPaths candidates.
    const fanNodes: GraphNode[] = [node('R', 100, 0)];
    const fanEdges: GraphEdge[] = [];
    for (let i = 0; i < 10; i++) {
      fanNodes.push(node(`M${i}`, 90, 1), node(`E${i}`, 80, 2));
      fanEdges.push(edge('R', `M${i}`, 1000 + i, minutes(0)));
      fanEdges.push(edge(`M${i}`, `E${i}`, 900 + i, minutes(5)));
    }

    const paths = extractPaths(fanNodes, fanEdges, 'R', { maxPaths: 3 });
    expect(paths.length).toBeLessThanOrEqual(3);
  });

  it('sorts by totalPathValueUsd descending', () => {
    const fanNodes: GraphNode[] = [node('R', 100, 0), node('P1', 90, 1), node('P2', 90, 1), node('E1', 80, 2), node('E2', 80, 2)];
    const fanEdges: GraphEdge[] = [
      edge('R', 'P1', 500, minutes(0)),
      edge('P1', 'E1', 400, minutes(5)),
      edge('R', 'P2', 900, minutes(0)),
      edge('P2', 'E2', 850, minutes(5))
    ];
    const paths = extractPaths(fanNodes, fanEdges, 'R');
    expect(paths[0].totalPathValueUsd).toBeGreaterThanOrEqual(paths[1].totalPathValueUsd);
  });

  it('minHops excludes single-hop paths when minHops is 2', () => {
    const paths = extractPaths(nodes, edges, 'R', { minHops: 2 });
    expect(paths.some((p) => p.hops.length < 2)).toBe(false);
    // the 3-hop R->A->B->C path (and its 2-hop prefix R->A->B) should still be present
    expect(paths.some((p) => p.addresses.join('>') === 'R>A>B>C')).toBe(true);
  });

  it('single-hop paths are included by default (minHops defaults below 2, i.e. no floor)', () => {
    const paths = extractPaths(nodes, edges, 'R');
    expect(paths.some((p) => p.hops.length === 1)).toBe(true);
  });

  it('does not revisit nodes within a path', () => {
    const cyclicEdges: GraphEdge[] = [...edges, edge('C', 'A', 100, minutes(40))];
    const paths = extractPaths(nodes, cyclicEdges, 'R');
    for (const p of paths) {
      expect(new Set(p.addresses).size).toBe(p.addresses.length);
    }
  });

  it('does not exceed 4 hops', () => {
    const longNodes: GraphNode[] = [
      node('R', 100, 0),
      node('H1', 90, 1),
      node('H2', 90, 2),
      node('H3', 90, 3),
      node('H4', 90, 4),
      node('H5', 90, 5)
    ];
    const longEdges: GraphEdge[] = [
      edge('R', 'H1', 1000, minutes(0)),
      edge('H1', 'H2', 900, minutes(10)),
      edge('H2', 'H3', 800, minutes(20)),
      edge('H3', 'H4', 700, minutes(30)),
      edge('H4', 'H5', 600, minutes(40))
    ];
    const paths = extractPaths(longNodes, longEdges, 'R');
    for (const p of paths) {
      expect(p.hops.length).toBeLessThanOrEqual(4);
    }
  });
});
