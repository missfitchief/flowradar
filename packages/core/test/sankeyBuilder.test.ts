// FlowRadar — buildRotationSankey tests (Task 24 review fix).
//
// Proves the Cluster-node branch: the seeded ALPHA->BETA rotation's source
// wallet ('alpha-source', tags ['smart_money']) is NOT a member of any
// EntityCluster in packages/providers/src/mock/scenarios.ts (only NOVA's
// 18-wallet single-funder scenario produces a cluster) — so the live app's
// boot check exercises the unclustered fallback branch, not the Cluster
// branch. This unit test is what proves the Cluster branch renders
// correctly, independent of which branch the seed data happens to hit.

import { describe, expect, it } from 'vitest';
import { buildRotationSankey } from '../src/flow/sankeyBuilder';

const BASE_INPUT = {
  sourceTokenSymbol: 'ALPHA',
  sourceWalletAddress: 'SoLaNaSourceWalletAddress1234567890',
  destWalletAddress: 'BscDestWalletAddress1234567890abcdef',
  destTokenSymbol: 'BETA',
  bridgeName: 'Bridge (Wormhole)',
  realizedProfitUsd: 5000,
  transferredValueUsd: 4800
};

describe('buildRotationSankey', () => {
  it('unclustered source wallet -> falls back to a plain Wallet node (chain: Token -> Wallet -> Bridge -> Wallet -> Token)', () => {
    const result = buildRotationSankey({ ...BASE_INPUT, sourceWalletCluster: null });

    expect(result.nodes).toEqual([
      { name: '$ALPHA', category: 'token' },
      { name: 'Wallet SoLaNa', category: 'wallet' },
      { name: 'Bridge (Wormhole)', category: 'bridge' },
      { name: 'Wallet BscDes', category: 'wallet' },
      { name: '$BETA', category: 'token' }
    ]);
    expect(result.links).toEqual([
      { source: '$ALPHA', target: 'Wallet SoLaNa', value: 5000 },
      { source: 'Wallet SoLaNa', target: 'Bridge (Wormhole)', value: 4800 },
      { source: 'Bridge (Wormhole)', target: 'Wallet BscDes', value: 4800 },
      { source: 'Wallet BscDes', target: '$BETA', value: 4800 }
    ]);
  });

  it('clustered source wallet -> second node becomes a Cluster node (chain: Token -> Cluster -> Bridge -> Wallet -> Token)', () => {
    const result = buildRotationSankey({
      ...BASE_INPUT,
      sourceWalletCluster: { id: 'clu_abcdefghij1234567890', walletCount: 18 }
    });

    expect(result.nodes[1]).toEqual({ name: 'Cluster clu_…7890 (18 wallets)', category: 'cluster' });
    expect(result.nodes.map((n) => n.category)).toEqual(['token', 'cluster', 'bridge', 'wallet', 'token']);
    // Dest side (Wallet -> Token) is unchanged by clustering.
    expect(result.nodes[3]).toEqual({ name: 'Wallet BscDes', category: 'wallet' });
    expect(result.nodes[4]).toEqual({ name: '$BETA', category: 'token' });
  });

  it('clustered source wallet -> links route through the Cluster node name, values unchanged', () => {
    const result = buildRotationSankey({
      ...BASE_INPUT,
      sourceWalletCluster: { id: 'clu_abcdefghij1234567890', walletCount: 18 }
    });

    const clusterName = 'Cluster clu_…7890 (18 wallets)';
    expect(result.links).toEqual([
      { source: '$ALPHA', target: clusterName, value: 5000 },
      { source: clusterName, target: 'Bridge (Wormhole)', value: 4800 },
      { source: 'Bridge (Wormhole)', target: 'Wallet BscDes', value: 4800 },
      { source: 'Wallet BscDes', target: '$BETA', value: 4800 }
    ]);
  });

  it('short cluster id (<=10 chars) is shown unshortened', () => {
    const result = buildRotationSankey({
      ...BASE_INPUT,
      sourceWalletCluster: { id: 'clu_abc', walletCount: 3 }
    });

    expect(result.nodes[1]).toEqual({ name: 'Cluster clu_abc (3 wallets)', category: 'cluster' });
  });

  it('undefined sourceWalletCluster (field omitted) also falls back to Wallet node', () => {
    const result = buildRotationSankey(BASE_INPUT);
    expect(result.nodes[1]!.category).toBe('wallet');
  });
});
