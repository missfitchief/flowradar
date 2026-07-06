// FlowRadar — clusterWallets (Task 22 binding decision 4).
//
// Union-find over wallet-pair links whose confidence is >= `threshold`
// (links below threshold are simply not unioned, matching unionFind.ts's
// "only pairs passed in are unioned" contract — this module does the
// filtering before delegating to buildClusters). Singletons (a wallet with
// no qualifying link) are NOT clusters: buildClusters only ever groups
// wallets that were unioned by at least one qualifying pair, so a wallet
// that never appears on either side of a >= threshold link never enters the
// union-find at all and correctly never appears in the output.
//
// Cluster confidence = mean of each member's OWN max-confidence qualifying
// link (i.e. for every member, take the highest confidence among all
// qualifying links touching that member, then average those per-member
// maxima across the cluster) — documented per binding decision 4's "mean of
// the max-confidence link touching each member" contract.
//
// packages/core is PURE: zero I/O, zero framework deps.

import { buildClusters } from './unionFind';
import type { LinkEvidence } from '../types';

export interface WalletLink {
  a: string;
  b: string;
  confidence: number;
  evidence: LinkEvidence;
}

export interface ClusterWalletsInput {
  links: WalletLink[];
  threshold: number;
}

export interface ClusterResult {
  members: string[];
  confidence: number;
  evidenceByPair: Record<string, LinkEvidence>;
}

export interface ClusterWalletsOutput {
  clusters: ClusterResult[];
}

function pairKey(a: string, b: string): string {
  return `${a}:${b}`;
}

export function clusterWallets(input: ClusterWalletsInput): ClusterWalletsOutput {
  const { links, threshold } = input;

  const qualifying = links.filter((link) => link.confidence >= threshold);

  const groups = buildClusters(qualifying.map((link) => ({ a: link.a, b: link.b })));

  // Per-member max confidence, computed once across all qualifying links
  // (a member may appear in multiple qualifying links; we want its single
  // highest-confidence link regardless of which cluster it lands in).
  const maxConfidenceByMember = new Map<string, number>();
  for (const link of qualifying) {
    for (const member of [link.a, link.b]) {
      const current = maxConfidenceByMember.get(member);
      if (current === undefined || link.confidence > current) {
        maxConfidenceByMember.set(member, link.confidence);
      }
    }
  }

  // evidenceByPair keyed by "a:b" using each qualifying link's own (a, b)
  // orientation as originally passed in (not the cluster's internal
  // representative ordering) — this is the pair's own evidence record, not
  // a per-cluster derived value.
  const evidenceByPairAll = new Map<string, LinkEvidence>();
  for (const link of qualifying) {
    evidenceByPairAll.set(pairKey(link.a, link.b), link.evidence);
  }

  const clusters: ClusterResult[] = [];
  // Map.values() iteration order is insertion order; buildClusters already
  // produces a deterministic key order (sorted by each group's first member)
  // by construction, and re-sorting here by first member is a cheap
  // belt-and-suspenders guarantee against relying on that internal detail.
  const orderedGroups = [...groups.values()].sort((a, b) => a[0]!.localeCompare(b[0]!));

  for (const members of orderedGroups) {
    if (members.length < 2) continue; // singletons are not clusters

    const perMemberMax = members.map((m) => maxConfidenceByMember.get(m) ?? 0);
    const confidence = perMemberMax.reduce((sum, v) => sum + v, 0) / perMemberMax.length;

    const evidenceByPair: Record<string, LinkEvidence> = {};
    const memberSet = new Set(members);
    for (const [key, evidence] of evidenceByPairAll.entries()) {
      const [a, b] = key.split(':') as [string, string];
      if (memberSet.has(a) && memberSet.has(b)) {
        evidenceByPair[key] = evidence;
      }
    }

    clusters.push({ members, confidence, evidenceByPair });
  }

  return { clusters };
}
