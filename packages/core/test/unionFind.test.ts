import { describe, expect, it } from 'vitest';
import { buildClusters } from '../src/cluster/unionFind';

// FlowRadar — buildClusters (union-find) tests (Task 22 binding decision 3).
//
// buildClusters(pairs) unions every {a,b} pair (path compression + union by
// rank internally) and returns a Map<representative, members[]> — one entry
// per connected component with >= 1 member. Member arrays are sorted for
// deterministic ordering; only pairs actually passed in are unioned (caller
// is responsible for pre-filtering by any confidence threshold).

describe('buildClusters', () => {
  it('transitive merge: a-b, b-c -> one cluster {a,b,c}', () => {
    const result = buildClusters([
      { a: 'a', b: 'b' },
      { a: 'b', b: 'c' }
    ]);
    const groups = [...result.values()].map((members) => [...members].sort());
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual(['a', 'b', 'c']);
  });

  it('disjoint sets stay separate', () => {
    const result = buildClusters([
      { a: 'a', b: 'b' },
      { a: 'c', b: 'd' }
    ]);
    const groups = [...result.values()].map((members) => [...members].sort()).sort();
    expect(groups).toHaveLength(2);
    expect(groups).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ]);
  });

  it('determinism: member arrays are sorted regardless of input pair order', () => {
    const result1 = buildClusters([
      { a: 'z', b: 'a' },
      { a: 'a', b: 'm' }
    ]);
    const result2 = buildClusters([
      { a: 'm', b: 'a' },
      { a: 'a', b: 'z' }
    ]);
    const members1 = [...result1.values()][0];
    const members2 = [...result2.values()][0];
    expect(members1).toEqual(['a', 'm', 'z']);
    expect(members2).toEqual(['a', 'm', 'z']);
  });

  it('a single pair produces one 2-member cluster', () => {
    const result = buildClusters([{ a: 'x', b: 'y' }]);
    expect(result.size).toBe(1);
    expect([...result.values()][0]).toEqual(['x', 'y']);
  });

  it('empty input -> empty map', () => {
    const result = buildClusters([]);
    expect(result.size).toBe(0);
  });

  it('repeated identical pairs are idempotent (no duplicate members)', () => {
    const result = buildClusters([
      { a: 'a', b: 'b' },
      { a: 'a', b: 'b' },
      { a: 'a', b: 'b' }
    ]);
    expect(result.size).toBe(1);
    expect([...result.values()][0]).toEqual(['a', 'b']);
  });

  it('longer chain unions transitively across many links', () => {
    const result = buildClusters([
      { a: 'w1', b: 'w2' },
      { a: 'w2', b: 'w3' },
      { a: 'w3', b: 'w4' },
      { a: 'w4', b: 'w5' }
    ]);
    expect(result.size).toBe(1);
    expect([...result.values()][0]).toEqual(['w1', 'w2', 'w3', 'w4', 'w5']);
  });
});
