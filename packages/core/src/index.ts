// FlowRadar — @flowradar/core public API.
//
// packages/core is PURE (zero I/O, zero framework deps; zod is the only
// runtime dependency). Every later task imports domain types/functions ONLY
// from this package.

export * from './types';
export * from './settings';
export * from './scoring/walletScore';
export * from './scoring/flowScore';
export * from './pnl/fifo';
export * from './wallets/profitability';
export * from './rules/ruleA';
export * from './rules/ruleB';
export * from './rules/ruleC';
export * from './rules/ruleD';
export * from './rules/ruleE';
export * from './rules/ruleF';
export * from './rules/ruleG';
export * from './rules/index';
export * from './window/aggregate';
export * from './alerts/templates';
export * from './alerts/cooldown';

// Graph module: exported by NAME (not `export *`) because graph/types.ts
// intentionally defines its own GraphNode/GraphEdge/RawGraphEdge — richer,
// real shapes per Task 19's binding decisions — which collide by name with
// the abbreviated (unused-elsewhere) sketches already in ./types. Both are
// kept; consumers that want the graph engine's shapes import these names
// (or import directly from '@flowradar/core/src/graph/types' /
// './graph/types' within the monorepo).
export type {
  GraphNode as WalletGraphNode,
  GraphEdge as WalletGraphEdge,
  RawGraphEdge,
  RegistryLookup,
  EdgeFetcher,
  TransactionPath
} from './graph/types';
export { runBfs } from './graph/bfs';
export { extractPaths } from './graph/paths';
