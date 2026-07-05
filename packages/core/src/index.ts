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
