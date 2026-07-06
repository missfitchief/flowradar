// FlowRadar — UnionFind + buildClusters (Task 22 binding decision 3).
//
// Classic disjoint-set-union with path compression + union by rank, exposed
// as both a `UnionFind` class (for callers that want incremental control)
// and a functional `buildClusters(pairs)` helper that unions every pair and
// returns a deterministic Map<representative, sortedMembers[]>.
//
// Only pairs actually passed in are unioned — buildClusters does NOT filter
// by any confidence threshold itself; the caller (clusterer.ts) is
// responsible for pre-filtering links to >= threshold before calling this.
//
// packages/core is PURE: zero I/O, zero framework deps.

export class UnionFind {
  private readonly parent = new Map<string, string>();
  private readonly rank = new Map<string, number>();

  /** Ensures `x` is a known member (its own root) if not already present. */
  private ensure(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  /** Finds the representative (root) of `x`'s set, with path compression. */
  find(x: string): string {
    this.ensure(x);
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression: point every visited node directly at the root.
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  /** Unions the sets containing `a` and `b` (union by rank). */
  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;

    const rankA = this.rank.get(rootA)!;
    const rankB = this.rank.get(rootB)!;

    if (rankA < rankB) {
      this.parent.set(rootA, rootB);
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA);
    } else {
      this.parent.set(rootB, rootA);
      this.rank.set(rootA, rankA + 1);
    }
  }

  /** All members ever seen (via find/union), in insertion order. */
  members(): string[] {
    return [...this.parent.keys()];
  }
}

export interface UnionPair {
  a: string;
  b: string;
}

/**
 * Unions every {a,b} pair via a fresh UnionFind, then groups all members by
 * their final representative. Returns a Map<representative, members[]> —
 * member arrays are sorted lexicographically for deterministic output
 * regardless of pair insertion order or which member happens to end up as
 * the union-find representative.
 */
export function buildClusters(pairs: UnionPair[]): Map<string, string[]> {
  const uf = new UnionFind();
  for (const { a, b } of pairs) {
    uf.union(a, b);
  }

  const groups = new Map<string, string[]>();
  for (const member of uf.members()) {
    const root = uf.find(member);
    const list = groups.get(root);
    if (list) {
      list.push(member);
    } else {
      groups.set(root, [member]);
    }
  }

  for (const list of groups.values()) {
    list.sort();
  }

  // Re-key the returned map by each group's sorted-first member so the map's
  // own key set is also deterministic (not dependent on which arbitrary
  // internal node the union-find algorithm happened to pick as root).
  const deterministic = new Map<string, string[]>();
  for (const list of groups.values()) {
    deterministic.set(list[0]!, list);
  }
  return deterministic;
}
