// FlowRadar — shared domain types (packages/core is PURE; zero I/O, zero
// framework deps). Every later task imports domain types ONLY from this file.
//
// Normative sources:
//   - Plan "Shared Contracts (normative for every task)" — type names/signatures verbatim.
//   - Spec §4 "Data model" (enum vocabularies) — mirrored from packages/db/prisma/schema.prisma,
//     which is itself normative for enums. Enums below are string-literal unions (not
//     Prisma-generated enums) so packages/core stays dependency-free of @prisma/client.
//   - Spec §6 "Core engine" / §7 intervals table — scoring + interval shapes.

import type { Settings } from './settings';

// ---------------------------------------------------------------------------
// Chain / trade / tx-leg vocabularies
// ---------------------------------------------------------------------------

/** Mirrors schema.prisma `enum ChainId`. */
export type Chain = 'SOLANA' | 'BSC';

/** Mirrors schema.prisma `enum TradeAction` (WalletTokenTrade.action). */
export type TradeAction = 'BUY' | 'SELL' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'LP_ADD' | 'LP_REMOVE';

/**
 * Mirrors schema.prisma `enum WalletLabel` (WalletClassification.label) — 11 values.
 * Vocabulary fixed by product brief (Modules 1/5/6).
 */
export type WalletLabel =
  | 'human_like'
  | 'smart_money'
  | 'whale'
  | 'possible_bot'
  | 'sniper'
  | 'mev'
  | 'deployer_related'
  | 'copy_trader'
  | 'cex_related'
  | 'bridge_related'
  | 'unknown';

/**
 * Mirrors schema.prisma `enum MoneyFlowActionType` (MoneyFlowEdge.actionType) — 11 values.
 * Vocabulary fixed by product brief (Modules 1/5/6).
 */
export type MoneyFlowActionType =
  | 'transfer'
  | 'swap'
  | 'bridge_deposit'
  | 'bridge_withdrawal'
  | 'cex_deposit'
  | 'cex_withdrawal'
  | 'dex_buy'
  | 'dex_sell'
  | 'lp_add'
  | 'lp_remove'
  | 'contract_interaction';

/**
 * Mirrors schema.prisma `enum WalletGraphRelationship` (WalletGraphEdge.relationship) — 13 values.
 * Vocabulary fixed by product brief (Modules 1/5/6).
 */
export type WalletGraphRelationship =
  | 'direct_transfer'
  | 'native_transfer'
  | 'token_transfer'
  | 'stablecoin_transfer'
  | 'bridge_deposit'
  | 'bridge_withdrawal'
  | 'cex_deposit'
  | 'cex_withdrawal'
  | 'swap_router_interaction'
  | 'lp_interaction'
  | 'contract_interaction'
  | 'deployer_interaction'
  | 'unknown';

/** Kind of a single leg inside a NormalizedTx (provider-facing normalization, not a Prisma enum). */
export type LegKind =
  | 'native_transfer'
  | 'token_transfer'
  | 'swap_leg'
  | 'lp_add'
  | 'lp_remove'
  | 'bridge_deposit'
  | 'bridge_withdrawal'
  | 'contract_interaction';

export interface TxLeg {
  kind: LegKind;
  from: string;
  to: string;
  asset: { address?: string; symbol: string; decimals: number };
  amountToken: string;
  amountUsd?: number;
  programOrContract?: string;
}

export interface NormalizedTx {
  txHash: string;
  blockOrSlot: bigint;
  ts: Date;
  legs: TxLeg[];
}

// ---------------------------------------------------------------------------
// Market / risk
// ---------------------------------------------------------------------------

export interface TokenMarket {
  priceUsd: number;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  vol5m: number;
  vol1h: number;
  vol6h: number;
  vol24h: number;
  holderCount: number | null;
  pairAddress?: string;
  dex?: string;
}

export interface RiskReport {
  flags: { id: string; label: string; severity: 'info' | 'warn' | 'danger' }[];
  penalty: number; // 0..1
}

// ---------------------------------------------------------------------------
// Window aggregate (window/aggregate.ts consumer contract)
// ---------------------------------------------------------------------------

export interface TokenWindowAggregate {
  tokenId: string;
  windowMinutes: 30 | 1440;
  from: Date;
  to: Date;
  buyers: {
    walletId: string;
    walletScore: number;
    labels: string[];
    buyUsd: number;
    sellUsd: number;
    firstBuyTs: Date;
    blockOrSlot: bigint;
    entityClusterId?: string;
  }[];
  trackedBuyVolumeUsd: number;
  trackedSellVolumeUsd: number;
  netFlowUsd: number;
  buySellRatio: number;
  smartWalletCount: number;
  humanLikeCount: number;
  possibleBotCount: number;
  whaleBuys: { walletId: string; usd: number }[];
  uniqueEntityCount: number;
  largestClusterSize: number;
  avgEntryMcap: number | null;
  currentMcap: number | null;
  mcapExpansionFromAvgEntry: number | null;
  liquidityUsd: number | null;
  liquidityChangePct: number | null;
  tokenAgeDays: number | null;
  inflowSpike: boolean;
  exitedSmartPct: number;
  topHolderExits: number;
  newSmartBuyers: number;
  /**
   * Rule B growth check (base window buyer count -> target window buyer
   * count) needs the EARLY-window buyer count, which is not derivable from
   * this single-window aggregate alone. Optional/nullable: aggregation
   * wires it in Task 15. Missing (undefined/null) means rule B "cannot
   * evaluate growth" and must not fire (see rules/ruleB.ts).
   */
  earlyWindowBuyerCount?: number | null;
}

// ---------------------------------------------------------------------------
// Rules (rules/types.ts consumer contract)
// ---------------------------------------------------------------------------

/** Mirrors schema.prisma `enum SignalSeverity`. */
export type SignalSeverity = 'INFO' | 'WATCH' | 'HIGH' | 'CRITICAL';

/** Mirrors schema.prisma `enum FlowSignalStatus` (TokenFlowSnapshot.signalStatus). */
export type SignalStatus = 'watching' | 'hot' | 'profit_rotation' | 'exit_warning' | 'dead';

export interface RuleResult {
  rule: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  fired: boolean;
  severity: SignalSeverity;
  reasons: string[];
  metrics: Record<string, number | string | boolean>;
}

/**
 * Funding event observed for a wallet (rule E: fresh-wallet-funded-then-buys).
 * Shape per plan Shared Contracts note: "RuleExtras carries fundingEvents (rule E)
 * and rotationCandidates (rule F) — see Tasks 14, 23."
 */
export interface FundingEvent {
  funderWalletId: string;
  fundedWalletId: string;
  fundedAddressFresh: boolean;
  amountUsd: number;
  ts: Date;
  fundedFirstBuy?: { tokenId: string; usd: number; ts: Date; mcapAtBuy: number | null };
}

/** Candidate profit-rotation link (rule F: A exits X, B receives, B buys Y). */
export interface RotationCandidate {
  sourceWalletId: string;
  destWalletId: string;
  sourceTokenId: string;
  destTokenId: string;
  realizedPnlUsd: number;
  transferUsd: number;
  transferTs: Date;
  receiptUsd: number;
  receiptTs: Date;
  destBuyTs: Date;
  destTokenMcapUsd: number | null;
}

export interface RuleExtras {
  fundingEvents?: FundingEvent[];
  rotationCandidates?: RotationCandidate[];
}

export type Rule = (agg: TokenWindowAggregate, settings: Settings, extra?: RuleExtras) => RuleResult;

// ---------------------------------------------------------------------------
// Cluster / link confidence
// ---------------------------------------------------------------------------

export interface LinkEvidence {
  directTransfer: boolean;
  repeatedDirectTransfers: boolean;
  sameFundingSource: boolean;
  sameGasFunder: boolean;
  bridgeAmountTimeMatch: boolean;
  amountSimilarityAbove90: boolean;
  destBuysNewTokenWithin60m: boolean;
  freshWalletActivated: boolean;
  sameTokenRotation: boolean;
  repeatedCrossLaunchPattern: boolean;
  cexOrMixerInterruption: boolean;
  routerOnlyInteraction: boolean;
  weakAmountMatch: boolean;
  dustOnlyInteraction: boolean;
}

// ---------------------------------------------------------------------------
// Wallet graph (graph/bfs.ts consumer contract)
// ---------------------------------------------------------------------------

/** Mirrors schema.prisma `enum WalletGraphMode` (WalletGraphSearch.mode). */
export type GraphMode = 'DIRECT' | 'CAPITAL_FLOW' | 'ENTITY_DISCOVERY' | 'FULL_RAW';

/** Mirrors schema.prisma `enum WalletGraphNodeType` (WalletGraphNode.nodeType). */
export type NodeType =
  | 'WALLET'
  | 'BRIDGE'
  | 'CEX'
  | 'ROUTER'
  | 'POOL'
  | 'TOKEN_CONTRACT'
  | 'CONTRACT'
  | 'UNKNOWN';

export interface GraphSearchParams {
  rootAddress: string;
  chain: Chain;
  mode: GraphMode;
  maxDepth: number;
  minTransferUsd: number;
  timeRange?: { from?: Date; to?: Date };
  includeNative: boolean;
  includeToken: boolean;
  includeSwaps: boolean;
  includeBridges: boolean;
  includeCex: boolean;
  excludeRoutersPoolsContracts: boolean;
  maxNodes: number;
  maxEdges: number;
}

export interface GraphNode {
  address: string;
  chain: Chain;
  nodeType: NodeType;
  label?: string;
  depth: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  relationship: WalletGraphRelationship;
  amountUsd: number;
  ts: Date;
  txHash?: string;
}

export interface RawGraphEdge {
  from: string;
  to: string;
  relationship: WalletGraphRelationship;
  amountToken: string;
  amountUsd?: number;
  ts: Date;
  txHash?: string;
  asset?: { address?: string; symbol: string; decimals: number };
}

// ---------------------------------------------------------------------------
// Providers (providers/types.ts consumer contract)
// ---------------------------------------------------------------------------

export interface ProviderStatus {
  name: string;
  chain: Chain;
  capability: string;
  mode: 'live' | 'mock' | 'missing_key' | 'stub';
  note?: string;
}

export interface JobRunner {
  schedule(name: string, intervalMs: number, fn: () => Promise<void>): void;
  enqueue(name: string, payload: unknown): Promise<string>;
  process(name: string, fn: (payload: unknown) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Wallet candidacy / stats input (walletScore.ts consumer contract)
// ---------------------------------------------------------------------------

export interface WalletCandidate {
  walletId: string;
  chain: Chain;
  address: string;
  labels: WalletLabel[];
  walletScore: number;
}

export interface WalletStatsInput {
  pnl30d: number;
  winRate: number; // 0..1
  tradeCount: number;
  humanLikelihood: number; // 0..1
  entryQuality: number; // 0..1
  holdingQuality: number; // 0..1
  recentPerf: number; // 0..1
  botLikelihood: number; // 0..1
  pnlConfidence: number; // 0..100
}

// ---------------------------------------------------------------------------
// Backtest
// ---------------------------------------------------------------------------

/** Mirrors schema.prisma `enum BacktestHorizon` (BacktestResult.horizon). */
export type BacktestHorizon = 'M15' | 'H1' | 'H6' | 'H24' | 'D3' | 'D7';
