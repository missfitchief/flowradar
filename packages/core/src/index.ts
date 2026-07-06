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
export * from './cluster/linkConfidence';
export * from './cluster/unionFind';
export * from './cluster/clusterer';
export * from './rotation/matcher';
export * from './flow/sankeyBuilder';
export * from './backtest/evaluate';
export * from './backtest/summarize';
export * from './backtest/replay';
export * from './backtest/rulePerf';
export * from './backtest/thresholdTuning';
export * from './backtest/walkForward';
export * from './backtest/shadow';
export * from './backtest/replayRequest';
export * from './feed/explain';
export * from './candidates/validate';

// Graph module: the unused sketch GraphNode/GraphEdge/RawGraphEdge that used
// to live in ./types (never implemented or consumed — confirmed by repo-wide
// grep) have been deleted, so there is no longer a name collision here.
// graph/types.ts's shapes are the graph engine's one real contract; still
// exported by name (rather than `export *`) so WalletGraphNode/WalletGraphEdge
// keep their disambiguated aliases for existing consumers.
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
