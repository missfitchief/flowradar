import { describe, expect, it } from 'vitest';
import { clusterWallets } from '../src/cluster/clusterer';
import type { LinkEvidence } from '../src/types';

// FlowRadar — clusterWallets tests (Task 22 binding decision 4).
//
// clusterWallets({ links, threshold }) unions pairs whose `confidence` is
// >= threshold via union-find, then returns { clusters: [{members, confidence,
// evidenceByPair}] } — singletons (no qualifying link) are excluded (only
// components with >= 2 members are clusters). Cluster confidence = mean of
// the max-confidence link touching each member.

const ALL_FALSE: LinkEvidence = {
  directTransfer: false,
  repeatedDirectTransfers: false,
  sameFundingSource: false,
  sameGasFunder: false,
  bridgeAmountTimeMatch: false,
  amountSimilarityAbove90: false,
  destBuysNewTokenWithin60m: false,
  freshWalletActivated: false,
  sameTokenRotation: false,
  repeatedCrossLaunchPattern: false,
  cexOrMixerInterruption: false,
  routerOnlyInteraction: false,
  weakAmountMatch: false,
  dustOnlyInteraction: false
};

function link(a: string, b: string, confidence: number): { a: string; b: string; confidence: number; evidence: LinkEvidence } {
  return { a, b, confidence, evidence: ALL_FALSE };
}

describe('clusterWallets', () => {
  it('a pair at exactly the threshold (61) merges into a cluster', () => {
    const result = clusterWallets({ links: [link('a', 'b', 61)], threshold: 61 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.members).toEqual(['a', 'b']);
    expect(result.clusters[0]!.confidence).toBe(61);
  });

  it('a pair below the threshold (60 < 61) is excluded entirely', () => {
    const result = clusterWallets({ links: [link('a', 'b', 60)], threshold: 61 });
    expect(result.clusters).toHaveLength(0);
  });

  it('a wallet with no qualifying link is not a cluster (singleton excluded)', () => {
    const result = clusterWallets({
      links: [link('a', 'b', 61), link('c', 'd', 20)],
      threshold: 61
    });
    // c-d is below threshold, so neither c nor d forms any cluster at all —
    // they simply never appear as a cluster (not a 1-member cluster).
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.members).toEqual(['a', 'b']);
  });

  it('transitive merge at threshold: a-b (70), b-c (65) with threshold 61 -> one cluster {a,b,c}', () => {
    const result = clusterWallets({
      links: [link('a', 'b', 70), link('b', 'c', 65)],
      threshold: 61
    });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.members).toEqual(['a', 'b', 'c']);
  });

  it('a below-threshold link does NOT bridge two otherwise-separate qualifying clusters', () => {
    const result = clusterWallets({
      links: [link('a', 'b', 70), link('b', 'c', 40), link('c', 'd', 75)],
      threshold: 61
    });
    // b-c (40) is below threshold, so {a,b} and {c,d} stay separate.
    const groups = result.clusters.map((c) => c.members).sort((x, y) => x[0]!.localeCompare(y[0]!));
    expect(groups).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ]);
  });

  it('cluster confidence = mean of member max-pair confidences', () => {
    // a-b: 70, b-c: 65 -> per-member max: a=70, b=70 (max of 70,65), c=65.
    // mean = (70 + 70 + 65) / 3 = 68.333...
    const result = clusterWallets({
      links: [link('a', 'b', 70), link('b', 'c', 65)],
      threshold: 61
    });
    expect(result.clusters[0]!.confidence).toBeCloseTo((70 + 70 + 65) / 3, 5);
  });

  it('deterministic member + cluster ordering regardless of input link order', () => {
    const linksA = [link('z', 'a', 90), link('m', 'z', 85), link('c', 'd', 70)];
    const linksB = [link('c', 'd', 70), link('m', 'z', 85), link('z', 'a', 90)];

    const resultA = clusterWallets({ links: linksA, threshold: 61 });
    const resultB = clusterWallets({ links: linksB, threshold: 61 });

    const shapeOf = (r: typeof resultA) => r.clusters.map((c) => c.members);
    expect(shapeOf(resultA)).toEqual(shapeOf(resultB));
    // First cluster (sorted by first member) should be {a,m,z}, second {c,d}.
    expect(shapeOf(resultA)).toEqual([
      ['a', 'm', 'z'],
      ['c', 'd']
    ]);
  });

  it('evidenceByPair carries each qualifying pair\'s own evidence', () => {
    const evA: LinkEvidence = { ...ALL_FALSE, directTransfer: true };
    const evB: LinkEvidence = { ...ALL_FALSE, sameFundingSource: true };
    const result = clusterWallets({
      links: [
        { a: 'a', b: 'b', confidence: 70, evidence: evA },
        { a: 'b', b: 'c', confidence: 65, evidence: evB }
      ],
      threshold: 61
    });
    const cluster = result.clusters[0]!;
    expect(cluster.evidenceByPair['a:b']).toEqual(evA);
    expect(cluster.evidenceByPair['b:c']).toEqual(evB);
  });

  it('empty links -> no clusters', () => {
    const result = clusterWallets({ links: [], threshold: 61 });
    expect(result.clusters).toEqual([]);
  });
});
