import type { ChainId } from '@prisma/client';

export type InvestigationCoverageStatus = 'complete' | 'partial' | 'retryable' | 'unavailable';
export type InvestigationRouteType = 'direct' | 'multi_hop' | 'bridge' | 'possible_cex' | 'profit_return' | 'token_deployment';

export interface InvestigationChainCoverage {
  chain: ChainId;
  activityFound: boolean;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
  eventsScanned: number;
  coverageStatus: InvestigationCoverageStatus;
  provider: string | null;
  warnings: string[];
}

export interface InvestigationHop {
  sourceChain: ChainId;
  sourceAddress: string;
  destinationChain: ChainId;
  destinationAddress: string;
  assetAddress: string | null;
  assetSymbol: string | null;
  amountToken: string | null;
  amountUsd: number | null;
  valueStatus: string;
  timestamp: string;
  txHash: string;
  routeType: InvestigationRouteType;
  protocol: string | null;
  evidenceTier: string;
  confidence: number;
}

export interface InvestigationPath {
  id: string;
  routeType: InvestigationRouteType;
  sourceChain: ChainId;
  sourceAddress: string;
  destinationChain: ChainId;
  destinationAddress: string;
  assetAddress: string | null;
  assetSymbol: string | null;
  amountToken: string | null;
  amountUsd: number | null;
  valueStatus: string;
  eventTs: string;
  txHash: string | null;
  protocol: string | null;
  evidenceTier: string;
  confidence: number;
  hops: InvestigationHop[];
  supportingEvidence: unknown;
  contradictingEvidence: unknown;
}

export interface InvestigationMember {
  chain: ChainId;
  address: string;
  role: string;
  parentChain: ChainId | null;
  parentAddress: string | null;
  entityKey: string | null;
  relationshipConfidence: number;
  evidenceTier: string;
  firstLinkedAt: string;
  lastLinkedAt: string;
  observationOnly: boolean;
}

export interface InvestigationDeployment {
  id: string;
  chain: ChainId;
  buyerAddress: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  buyTs: string;
  buyTxHash: string;
  amountToken: string | null;
  amountUsd: number | null;
  entryMarketCapUsd: number | null;
  fundingToBuyDelaySec: number | null;
  sourceEntityKey: string | null;
  capitalRoute: InvestigationHop[];
  holdingStatus: string;
  evidenceTier: string;
}

export interface WalletInvestigationResult {
  id: string;
  investigationKey: string;
  rootAddress: string;
  addressKind: 'solana' | 'evm';
  maxDepth: number;
  status: string;
  entityKey: string | null;
  coverageStatus: InvestigationCoverageStatus;
  activityChains: ChainId[];
  coverage: InvestigationChainCoverage[];
  counts: {
    directReceivers: number;
    multiHopWallets: number;
    bridgeDestinations: number;
    probableAltExecutionWallets: number;
    profitCollectors: number;
    tokenDeployments: number;
    possibleCexLinks: number;
    strongLinks: number;
    probableLinks: number;
    possibleLinks: number;
  };
  paths: InvestigationPath[];
  members: InvestigationMember[];
  deployments: InvestigationDeployment[];
  providerReceipts: unknown;
  completedAt: string | null;
}
