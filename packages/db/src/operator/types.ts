import type { ChainId } from '@prisma/client';

export interface OperatorPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
  coverageWarnings: string[];
}

export interface OperatorAddressRef {
  chain: ChainId;
  address: string;
  role: string;
  confidence: number | null;
  evidenceTier: string | null;
}

export interface WalletSummary {
  address: string;
  detectedChains: ChainId[];
  role: string;
  relationshipConfidence: number | null;
  entityKey: string | null;
  eventCounts: { raw: number; relevant: number; highPriority: number };
  funders: Array<{ chain: ChainId; address: string; amountUsd: number | null; ts: string; txHash: string; evidenceTier: string }>;
  routes: { direct: number; multiHop: number; bridges: number; possibleCex: number };
  dormancy: { days7: boolean | null; days14: boolean | null; days30: boolean | null; days90: boolean | null; latestClass: string | null; evidence: unknown };
  positions: unknown[];
  completedPositions: number;
  winCount: number;
  lossCount: number;
  unresolvedPositions: number;
  winRate: number | null;
  evUsd: number | null;
  repeatRunnerCount: number | null;
  oneWinnerDependence: number | null;
  undeployedCapitalUsd: number | null;
  lastRelevantActivity: string | null;
  coverageWarnings: string[];
}

export type ProfitableSort = 'pnl' | 'win_rate' | 'ev' | 'repeat_runners' | 'entry_mcap' | 'one_winner' | 'dormancy' | 'confidence';
export type TokenTraderSort = 'pnl' | 'roi' | 'entry_mcap' | 'repeat_runners' | 'dormancy' | 'confidence';

export interface ProfitableWalletRow {
  chain: ChainId;
  address: string;
  entityKey: string | null;
  role: string;
  validation: string;
  localRealizedPnlUsd: number | null;
  providerClaimedPnlUsd: number | null;
  winRate: number | null;
  evUsd: number | null;
  repeatRunnerCount: number | null;
  medianEntryMcapUsd: number | null;
  oneWinnerDependence: number | null;
  dormancyReactivations: number;
  confidence: number;
  coverage: string;
}

export interface CapitalFlowRow {
  id: string;
  source: string;
  destination: string;
  sourceChain: ChainId;
  destinationChain: ChainId;
  route: string;
  protocol: string | null;
  asset: string | null;
  amountToken: string | null;
  amountUsd: number | null;
  ts: string;
  evidenceTier: string;
  txHash: string | null;
  explorerUrl: string | null;
}

export interface BridgeRow {
  correlationId: string;
  protocol: string;
  status: string;
  evidenceTier: string;
  confidence: number;
  sourceChain: ChainId;
  destinationChain: ChainId;
  sourceTx: string;
  destinationTx: string;
  recipient: string;
  amountToken: string;
  amountUsd: number | null;
  destinationActivity: string | null;
  tokenBuy: string | null;
}

export type OperatorWorkflow = 'wallet' | 'token' | 'profitable' | 'entity' | 'flow' | 'bridges' | 'recent';

export interface OperatorSessionState {
  target?: string;
  chain?: ChainId | 'ALL';
  sort?: ProfitableSort;
  tokenSort?: TokenTraderSort;
  page: number;
  pageSize: number;
  format?: 'json' | 'csv';
}
