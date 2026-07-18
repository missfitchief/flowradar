import type { Chain } from '../types';

export type MassEventKind =
  | 'native_transfer'
  | 'token_transfer'
  | 'token_buy'
  | 'token_sell'
  | 'lp_add'
  | 'lp_remove'
  | 'contract_interaction'
  | 'bridge_source'
  | 'bridge_destination';

export type EntityWalletRole =
  | 'operator_root'
  | 'execution_wallet'
  | 'side_wallet'
  | 'linked_wallet'
  | 'unknown';

export type InfrastructureCategory =
  | 'CEX'
  | 'BRIDGE'
  | 'ROUTER'
  | 'POOL'
  | 'MIXER'
  | 'TOKEN_CONTRACT'
  | 'PROGRAM'
  | 'BURN'
  | 'SYSTEM';

export interface EventAsset {
  address: string | null;
  symbol: string | null;
  decimals: number | null;
  amount: string;
  amountUsd: number | null;
}

/**
 * Protocol-native bridge identity. `officialMessageId` must come from decoded
 * protocol data, never from amount/time proximity. For Wormhole it is the
 * finalized `emitter_chain/emitter_address/sequence` VAA tuple.
 */
export interface BridgeMessage {
  protocol: string;
  officialMessageId: string | null;
  sourceChain: Chain;
  destinationChain: Chain;
  sourceTxHash: string | null;
  destinationTxHash: string | null;
  sender: string | null;
  recipient: string | null;
  verifiedBy: 'protocol_message' | 'provider_decoded' | 'heuristic';
  /** Destination protocol execution observed; distinct from chain finality. */
  protocolCompleted: boolean;
  sourceFinality: 'processed' | 'confirmed' | 'finalized' | 'unknown';
}

/** Canonical, provider-independent event persisted/streamed by the mass tracker. */
export interface MassTransactionEvent {
  eventId: string;
  chain: Chain;
  txHash: string;
  eventIndex: number;
  blockOrSlot: bigint;
  ts: Date;
  kind: MassEventKind;
  status: 'succeeded' | 'failed';
  from: string;
  to: string;
  /** Wallet whose activity stream produced this event (required for swaps). */
  actor: string | null;
  asset: EventAsset;
  programOrContract: string | null;
  provider: string;
  observedAt: Date;
  bridge: BridgeMessage | null;
  metadata: Readonly<Record<string, unknown>>;
}

export interface TrackerAddressContext {
  chain: Chain;
  address: string;
  infrastructure: InfrastructureCategory | null;
  trackedEntityKey: string | null;
  /** Existing lineage root FK; classification never creates/promotes roots. */
  lineageRootId?: string | null;
  role: EntityWalletRole;
  observationOnly: boolean;
  distinctCounterparties: number;
  dormantDays: number | null;
}

export type RelevanceCategory =
  | 'failed'
  | 'self_transfer'
  | 'infrastructure_noise'
  | 'contract_noise'
  | 'dust'
  | 'capital_transfer'
  | 'gas_funding'
  | 'token_deployment'
  | 'bridge_verified'
  | 'bridge_unverified'
  | 'unrelated';

export interface RelevanceVerdict {
  relevant: boolean;
  category: RelevanceCategory;
  score: number;
  reasonCodes: string[];
  /** A path observation is allowed; this is never an automatic identity merge. */
  safeEntityLink: boolean;
  /** Receiver may be enrolled observation_only after DB-side freshness checks. */
  enrollmentCandidate: boolean;
  /** Operator roots remain provenance roots and never become traders by inference. */
  grantsTraderRole: false;
}

export interface ClassifiedMassEvent {
  event: MassTransactionEvent;
  verdict: RelevanceVerdict;
}

export interface RelevanceConfig {
  minCapitalTransferUsd: number;
  dustMaxUsd: number;
  gasFundingMinNative: number;
  gasFundingMaxNative: number;
  serviceDegreeThreshold: number;
  dormantReceiverDays: number;
}

export const DEFAULT_RELEVANCE_CONFIG: RelevanceConfig = {
  minCapitalTransferUsd: 100,
  dustMaxUsd: 1,
  gasFundingMinNative: 0.002,
  gasFundingMaxNative: 2,
  serviceDegreeThreshold: 250,
  dormantReceiverDays: 7
};

export interface BridgeCorrelation {
  correlationId: string;
  protocol: string;
  source: MassTransactionEvent;
  destination: MassTransactionEvent;
  confidence: number;
  status: 'verified' | 'probable';
  reasonCodes: string[];
}

export interface CapitalTrace {
  traceId: string;
  sourceEntityKey: string;
  sourceRole: EntityWalletRole;
  sourceWallet: string;
  terminalWallet: string;
  tokenBought: string;
  route: 'direct_transfer' | 'multi_hop_transfer' | 'verified_bridge' | 'multi_hop_bridge';
  hops: ClassifiedMassEvent[];
  bridgeCorrelations: BridgeCorrelation[];
  fundingToBuyDelaySec: number;
  confidence: number;
  reasonCodes: string[];
  grantsEligibility: false;
}

export interface TraceConfig {
  maxHops: number;
  maxGapMs: number;
  maxPaths: number;
  minLinkScore: number;
}

export const DEFAULT_TRACE_CONFIG: TraceConfig = {
  maxHops: 5,
  maxGapMs: 7 * 24 * 60 * 60_000,
  maxPaths: 10_000,
  minLinkScore: 60
};
