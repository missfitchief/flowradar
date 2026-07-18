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
export type Chain = 'SOLANA' | 'ETHEREUM' | 'BASE' | 'ARBITRUM' | 'BSC';

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

/**
 * Capital Lineage Engine (Phase 6b) relationship vocabulary — MUST stay in
 * sync with the Prisma WalletRelationshipKind enum. Probabilistic on-chain
 * relationship, never an identity claim.
 */
export type WalletRelationshipKind =
  | 'first_funder'
  | 'direct_funding'
  | 'repeated_transfer'
  | 'fresh_wallet_activation'
  | 'service_interrupted'
  | 'unknown';

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
  /** Additive provider execution status; legacy producers may omit it. */
  status?: 'succeeded' | 'failed';
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
    /**
     * True when Wallet.isWatched — carried per Task 15's wallet-driven scope
     * correction so smartWalletCount can be defined as "watched OR
     * profitable" without the aggregate consumer re-joining Wallet rows.
     */
    isWatched: boolean;
  }[];
  trackedBuyVolumeUsd: number;
  trackedSellVolumeUsd: number;
  netFlowUsd: number;
  buySellRatio: number;
  smartWalletCount: number;
  humanLikeCount: number;
  /**
   * Count of buyers whose `labels` include 'human_like' OR 'smart_money'
   * (union, not the human_like-only count). Task 15 fix: the product brief's
   * Rule C contract is "70%+ buying wallets are human_like OR smart_money" —
   * `humanLikeCount` alone under-counts scenarios whose smart cohort is
   * split across both labels (e.g. NOVA), so Rule C reads THIS field for its
   * ratio instead. `humanLikeCount` itself is UNCHANGED (flowScore.ts's
   * humanRatio component still reads humanLikeCount verbatim — do not
   * conflate the two).
   */
  humanOrSmartLabelCount: number;
  possibleBotCount: number;
  whaleBuys: { walletId: string; usd: number }[];
  uniqueEntityCount: number;
  largestClusterSize: number;
  avgEntryMcap: number | null;
  currentMcap: number | null;
  /** Growth ratio: currentMcap/avgEntryMcap − 1 (1.0 = +100% = 2× multiplier). Null when avg entry unknown. */
  mcapExpansionFromAvgEntry: number | null;
  liquidityUsd: number | null;
  liquidityChangePct: number | null;
  tokenAgeDays: number | null;
  inflowSpike: boolean;
  /**
   * Tracked buy volume in the equal-length window immediately BEFORE
   * `from` (i.e. [from - windowMinutes, from)) — the baseline `inflowSpike`
   * compares against. Exposed (rather than kept internal to aggregation) so
   * a settings-driven multiplier can be applied entirely outside
   * packages/core/src/window/aggregate.ts (which is itself settings-free —
   * see that file's header).
   */
  trailingBuyVolumeUsd: number;
  /** Alias for trackedBuyVolumeUsd, exposed under the name Rule A's inflow-spike comparison reads most naturally. */
  windowBuyVolumeUsd: number;
  /**
   * % of SMART holders-at-window-start (net BUY-SELL position > 0 built
   * from all trades strictly before `from`) whose in-window sells reach
   * >= 80% of that pre-window position, unioned with smart buyers who had
   * no pre-window position but bought-and-dumped >= 80% within the window
   * itself. Task 15 Fix B — holder-based (not window-buyer-based); see
   * window/aggregate.ts's `exitedSmartPct` derivation comment for the full
   * rationale (this replaces a prior window-buy-relative measure that could
   * never detect a scripted accumulate-then-dump-much-later pattern).
   */
  exitedSmartPct: number;
  /**
   * Among the top-5 holders-at-window-start by pre-window net USD position
   * (not smart-restricted), count who sold >= 80% of that position
   * in-window. Task 15 Fix B — holder-based, see `exitedSmartPct` above.
   */
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
  /**
   * Multi-window accumulation metrics (Task 15 wallet-driven scope
   * correction, binding decision 1) — only computed for the 1440-minute
   * (24h) aggregate; undefined for the 30-minute aggregate. Persisted
   * verbatim into TokenFlowSnapshot.componentBreakdown.metrics (no schema
   * change — componentBreakdown is already a Json column).
   */
  accumulation?: {
    /** Distinct buyer count in the trailing 30 minutes ending at `to`. */
    smartWalletCount30m: number;
    /** Distinct buyer count in the trailing 1 hour ending at `to`. */
    smartWalletCount1h: number;
    /** Distinct buyer count in the trailing 6 hours ending at `to`. */
    smartWalletCount6h: number;
    /** Share (0-100) of this window's buyers who sold anything (sellUsd > 0). */
    percentWalletsSold: number;
  };
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

/**
 * Candidate profit-rotation link (rule F: A exits sourceTokenId at a profit,
 * transfers proceeds — directly or bridged — to destWalletId, which then
 * buys destTokenId, the token CURRENTLY being evaluated).
 *
 * Shape per Task 14 binding decision 2 (rules/ruleF.ts is the sole consumer;
 * a builder — Task 23 — is responsible for constructing these and for
 * enforcing exit->transfer ordering upstream, so ruleF itself does not
 * re-derive realizedProfitUsd/transferTs from raw trades).
 */
export interface RotationCandidate {
  sourceWalletId: string;
  destWalletId: string;
  sourceTokenId: string;
  /** The token currently being evaluated (rule F only matches candidates for THIS token). */
  destTokenId: string;
  realizedProfitUsd: number;
  transferredValueUsd: number;
  receivedValueUsd: number;
  transferTs: Date;
  receiptTs: Date;
  destBuyTs: Date;
  destBuyUsd: number;
  /** null = mcap unknown at buy time; rule F treats this as "cannot evaluate" -> does not fire for this candidate. */
  destTokenMcapAtBuy: number | null;
  bridged: boolean;
  chainPath: string[];
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
