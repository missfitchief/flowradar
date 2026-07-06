// FlowRadar — buildRotationSankey (Task 24 review fix: extracted PURE Sankey
// node/link builder for the Money Flow page's "Capital rotation flow" chart).
//
// Chain shape (product brief Module 9 (Money Flow page) / plan Task 24):
//   Token(source) -> Cluster|Wallet(source) -> Bridge -> Wallet(dest) -> Token(dest)
//
// The second hop is a Cluster node ONLY when the rotation's source wallet is
// a member of an EntityCluster (per EntityCluster/EntityClusterWallet — an
// entity-level view is more informative than one anonymous wallet address
// once we know several wallets act as one economic actor). If the source
// wallet is not clustered, the chain falls back to a plain Wallet node (the
// pre-fix behavior) — this is a documented fallback, not a bug: an
// unclustered wallet has no cluster identity to surface.
//
// packages/core is PURE: this module takes only plain data (no Prisma
// Decimal/Date, no framework types) and returns plain name/category/value
// node+link data — the same shape apps/web/components/flow/FlowSankey.tsx
// already renders.

export type FlowSankeyNodeCategory = 'token' | 'wallet' | 'bridge' | 'cluster';

export interface FlowSankeyNode {
  name: string;
  category: FlowSankeyNodeCategory;
}

export interface FlowSankeyLink {
  source: string;
  target: string;
  value: number;
}

export interface FlowSankeyData {
  nodes: FlowSankeyNode[];
  links: FlowSankeyLink[];
}

export interface RotationSankeyInput {
  sourceTokenSymbol: string;
  sourceWalletAddress: string;
  /** Cluster the source wallet belongs to, if any (null/undefined => unclustered fallback). */
  sourceWalletCluster?: { id: string; walletCount: number } | null;
  destWalletAddress: string;
  destTokenSymbol: string;
  bridgeName: string;
  realizedProfitUsd: number;
  transferredValueUsd: number;
}

/**
 * Shortens an id/address to a display-friendly prefix, mirroring
 * apps/web/lib/format.ts's shortAddr for ids <= 10 chars returned unchanged.
 */
function shortId(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/**
 * Builds the Sankey nodes/links for one rotation chain:
 *   Token(source) -> [Cluster <shortId> (<n> wallets) | Wallet <shortAddr>] -> Bridge -> Wallet(dest) -> Token(dest)
 * weighted by USD value at each hop (sell proceeds -> bridge deposit ->
 * bridge withdrawal -> dest buy). Dest side is always a plain Wallet node
 * (unchanged by this fix — only the source-side second hop can become a
 * Cluster node).
 */
export function buildRotationSankey(input: RotationSankeyInput): FlowSankeyData {
  const sourceTokenName = `$${input.sourceTokenSymbol}`;
  const destWalletName = `Wallet ${input.destWalletAddress.slice(0, 6)}`;
  const destTokenName = `$${input.destTokenSymbol}`;

  const isClustered = Boolean(input.sourceWalletCluster);
  const secondNodeName = isClustered
    ? `Cluster ${shortId(input.sourceWalletCluster!.id)} (${input.sourceWalletCluster!.walletCount} wallets)`
    : `Wallet ${input.sourceWalletAddress.slice(0, 6)}`;
  const secondNodeCategory: FlowSankeyNodeCategory = isClustered ? 'cluster' : 'wallet';

  const nodes: FlowSankeyNode[] = [
    { name: sourceTokenName, category: 'token' },
    { name: secondNodeName, category: secondNodeCategory },
    { name: input.bridgeName, category: 'bridge' },
    { name: destWalletName, category: 'wallet' },
    { name: destTokenName, category: 'token' }
  ];

  const links: FlowSankeyLink[] = [
    { source: sourceTokenName, target: secondNodeName, value: input.realizedProfitUsd },
    { source: secondNodeName, target: input.bridgeName, value: input.transferredValueUsd },
    { source: input.bridgeName, target: destWalletName, value: input.transferredValueUsd },
    { source: destWalletName, target: destTokenName, value: input.transferredValueUsd }
  ];

  return { nodes, links };
}
