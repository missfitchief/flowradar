-- CreateEnum
CREATE TYPE "ChainId" AS ENUM ('SOLANA', 'BSC');

-- CreateEnum
CREATE TYPE "StatsSource" AS ENUM ('csv', 'computed', 'provider');

-- CreateEnum
CREATE TYPE "WalletLabel" AS ENUM ('human_like', 'smart_money', 'whale', 'possible_bot', 'sniper', 'mev', 'deployer_related', 'copy_trader', 'cex_related', 'bridge_related', 'unknown');

-- CreateEnum
CREATE TYPE "TradeAction" AS ENUM ('BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT', 'LP_ADD', 'LP_REMOVE');

-- CreateEnum
CREATE TYPE "FlowSignalStatus" AS ENUM ('watching', 'hot', 'profit_rotation', 'exit_warning', 'dead');

-- CreateEnum
CREATE TYPE "SignalRule" AS ENUM ('A', 'B', 'C', 'D', 'E', 'F', 'G');

-- CreateEnum
CREATE TYPE "SignalSeverity" AS ENUM ('INFO', 'WATCH', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('SIGNAL', 'ROTATION', 'WALLET_GRAPH', 'TEST');

-- CreateEnum
CREATE TYPE "AlertChannel" AS ENUM ('TELEGRAM', 'DISCORD');

-- CreateEnum
CREATE TYPE "MoneyFlowActionType" AS ENUM ('transfer', 'swap', 'bridge_deposit', 'bridge_withdrawal', 'cex_deposit', 'cex_withdrawal', 'dex_buy', 'dex_sell', 'lp_add', 'lp_remove', 'contract_interaction');

-- CreateEnum
CREATE TYPE "WalletGraphMode" AS ENUM ('DIRECT', 'CAPITAL_FLOW', 'ENTITY_DISCOVERY', 'FULL_RAW');

-- CreateEnum
CREATE TYPE "WalletGraphSearchStatus" AS ENUM ('queued', 'running', 'done', 'failed', 'truncated');

-- CreateEnum
CREATE TYPE "WalletGraphNodeType" AS ENUM ('WALLET', 'BRIDGE', 'CEX', 'ROUTER', 'POOL', 'TOKEN_CONTRACT', 'CONTRACT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WalletGraphRelationship" AS ENUM ('direct_transfer', 'native_transfer', 'token_transfer', 'stablecoin_transfer', 'bridge_deposit', 'bridge_withdrawal', 'cex_deposit', 'cex_withdrawal', 'swap_router_interaction', 'lp_interaction', 'contract_interaction', 'deployer_interaction', 'unknown');

-- CreateEnum
CREATE TYPE "BacktestHorizon" AS ENUM ('M15', 'H1', 'H6', 'H24', 'D3', 'D7');

-- CreateEnum
CREATE TYPE "AddressCategory" AS ENUM ('CEX', 'BRIDGE', 'ROUTER', 'POOL', 'DEPLOYER', 'MIXER', 'TOKEN_CONTRACT');

-- CreateTable
CREATE TABLE "chains" (
    "id" "ChainId" NOT NULL,
    "name" TEXT NOT NULL,
    "nativeSymbol" TEXT NOT NULL,
    "explorerTxUrl" TEXT NOT NULL,
    "explorerAddressUrl" TEXT NOT NULL,

    CONSTRAINT "chains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastActiveAt" TIMESTAMP(3) NOT NULL,
    "isWatched" BOOLEAN NOT NULL DEFAULT false,
    "isExcluded" BOOLEAN NOT NULL DEFAULT false,
    "exclusionReason" TEXT,
    "notes" TEXT,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_stats" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "pnlUsd" DECIMAL(20,4) NOT NULL,
    "realizedPnlUsd" DECIMAL(20,4) NOT NULL,
    "unrealizedPnlUsd" DECIMAL(20,4) NOT NULL,
    "winRate" DOUBLE PRECISION NOT NULL,
    "tradeCount" INTEGER NOT NULL,
    "avgTradeSizeUsd" DECIMAL(20,4) NOT NULL,
    "walletScore" DOUBLE PRECISION NOT NULL,
    "scoreComponents" JSONB NOT NULL,
    "pnlConfidence" DOUBLE PRECISION NOT NULL,
    "source" "StatsSource" NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_classifications" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "label" "WalletLabel" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" JSONB NOT NULL,

    CONSTRAINT "wallet_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokens" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "address" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "pairAddress" TEXT,
    "dex" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "tokenCreatedAt" TIMESTAMP(3),
    "website" TEXT,
    "twitter" TEXT,
    "telegram" TEXT,
    "riskFlags" JSONB NOT NULL,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_market_snapshots" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "priceUsd" DECIMAL(24,12) NOT NULL,
    "marketCapUsd" DECIMAL(20,4) NOT NULL,
    "fdvUsd" DECIMAL(20,4) NOT NULL,
    "liquidityUsd" DECIMAL(20,4) NOT NULL,
    "vol5m" DECIMAL(20,4) NOT NULL,
    "vol1h" DECIMAL(20,4) NOT NULL,
    "vol6h" DECIMAL(20,4) NOT NULL,
    "vol24h" DECIMAL(20,4) NOT NULL,
    "holderCount" INTEGER NOT NULL,

    CONSTRAINT "token_market_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_token_trades" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "action" "TradeAction" NOT NULL,
    "amountToken" DECIMAL(38,18) NOT NULL,
    "amountUsd" DECIMAL(20,4) NOT NULL,
    "txHash" TEXT NOT NULL,
    "blockOrSlot" BIGINT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "priceUsd" DECIMAL(24,12) NOT NULL,
    "marketCapAtTrade" DECIMAL(20,4) NOT NULL,
    "walletScoreAtTime" DOUBLE PRECISION NOT NULL,
    "entityClusterId" TEXT,
    "provider" TEXT NOT NULL,

    CONSTRAINT "wallet_token_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_flow_snapshots" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "windowMinutes" INTEGER NOT NULL,
    "flowScore" DOUBLE PRECISION NOT NULL,
    "smartWalletCount" INTEGER NOT NULL,
    "humanLikeCount" INTEGER NOT NULL,
    "possibleBotCount" INTEGER NOT NULL,
    "uniqueEntityCount" INTEGER NOT NULL,
    "clusterAdjustedWalletCount" INTEGER NOT NULL,
    "entityConcentrationRisk" DOUBLE PRECISION NOT NULL,
    "trackedBuyVolumeUsd" DECIMAL(20,4) NOT NULL,
    "trackedSellVolumeUsd" DECIMAL(20,4) NOT NULL,
    "netFlowUsd" DECIMAL(20,4) NOT NULL,
    "buySellRatio" DOUBLE PRECISION NOT NULL,
    "avgEntryMcap" DECIMAL(20,4) NOT NULL,
    "currentMcap" DECIMAL(20,4) NOT NULL,
    "mcapExpansionFromAvgEntry" DOUBLE PRECISION NOT NULL,
    "holdersGrowth" DOUBLE PRECISION NOT NULL,
    "liquidityChange" DOUBLE PRECISION NOT NULL,
    "signalStatus" "FlowSignalStatus" NOT NULL,
    "componentBreakdown" JSONB NOT NULL,

    CONSTRAINT "token_flow_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signals" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "rule" "SignalRule" NOT NULL,
    "severity" "SignalSeverity" NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL,
    "reasons" JSONB NOT NULL,
    "walletCount" INTEGER NOT NULL,
    "uniqueEntityCount" INTEGER NOT NULL,
    "netFlowUsd" DECIMAL(20,4) NOT NULL,
    "mcapAtTrigger" DECIMAL(20,4) NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "signalId" TEXT,
    "type" "AlertType" NOT NULL,
    "channel" "AlertChannel" NOT NULL,
    "tokenId" TEXT,
    "rule" "SignalRule",
    "sentAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "deliveryStatus" TEXT NOT NULL,
    "error" TEXT,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_sync_states" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "scope" TEXT NOT NULL,
    "cursor" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "failCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "provider_sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "okRows" INTEGER NOT NULL,
    "errorRows" INTEGER NOT NULL,
    "errors" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "money_flow_edges" (
    "id" TEXT NOT NULL,
    "sourceAddress" TEXT NOT NULL,
    "destinationAddress" TEXT NOT NULL,
    "sourceChain" "ChainId" NOT NULL,
    "destinationChain" "ChainId" NOT NULL,
    "asset" TEXT NOT NULL,
    "amountToken" DECIMAL(38,18) NOT NULL,
    "amountUsd" DECIMAL(20,4) NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "txHash" TEXT NOT NULL,
    "actionType" "MoneyFlowActionType" NOT NULL,
    "bridgeProtocol" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "providerSource" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,

    CONSTRAINT "money_flow_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_clusters" (
    "id" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "walletCount" INTEGER NOT NULL,
    "total30dPnlUsd" DECIMAL(20,4) NOT NULL,
    "chains" "ChainId"[],
    "evidence" JSONB NOT NULL,
    "mainFundingSource" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_cluster_wallets" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "linkConfidence" DOUBLE PRECISION NOT NULL,
    "evidence" JSONB NOT NULL,

    CONSTRAINT "entity_cluster_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profit_rotation_signals" (
    "id" TEXT NOT NULL,
    "sourceWalletId" TEXT NOT NULL,
    "destWalletId" TEXT NOT NULL,
    "sourceTokenId" TEXT NOT NULL,
    "destTokenId" TEXT NOT NULL,
    "realizedProfitUsd" DECIMAL(20,4) NOT NULL,
    "transferredValueUsd" DECIMAL(20,4) NOT NULL,
    "chainPath" "ChainId"[],
    "timeGapMin" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "destTokenMcapAtBuy" DECIMAL(20,4) NOT NULL,
    "currentDestPerfPct" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "profit_rotation_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_graph_searches" (
    "id" TEXT NOT NULL,
    "rootAddress" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "mode" "WalletGraphMode" NOT NULL,
    "params" JSONB NOT NULL,
    "status" "WalletGraphSearchStatus" NOT NULL,
    "nodeCount" INTEGER NOT NULL,
    "edgeCount" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "wallet_graph_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_graph_nodes" (
    "id" TEXT NOT NULL,
    "searchId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "nodeType" "WalletGraphNodeType" NOT NULL,
    "totalSentUsd" DECIMAL(20,4) NOT NULL,
    "totalReceivedUsd" DECIMAL(20,4) NOT NULL,
    "netFlowUsd" DECIMAL(20,4) NOT NULL,
    "interactionCount" INTEGER NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "wallet_graph_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_graph_edges" (
    "id" TEXT NOT NULL,
    "searchId" TEXT NOT NULL,
    "sourceAddress" TEXT NOT NULL,
    "destAddress" TEXT NOT NULL,
    "relationship" "WalletGraphRelationship" NOT NULL,
    "totalUsd" DECIMAL(20,4) NOT NULL,
    "txCount" INTEGER NOT NULL,
    "firstTs" TIMESTAMP(3) NOT NULL,
    "lastTs" TIMESTAMP(3) NOT NULL,
    "sampleTxHashes" TEXT[],

    CONSTRAINT "wallet_graph_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_results" (
    "id" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "horizon" "BacktestHorizon" NOT NULL,
    "maxUpsidePct" DOUBLE PRECISION NOT NULL,
    "maxDrawdownPct" DOUBLE PRECISION NOT NULL,
    "roiPct" DOUBLE PRECISION NOT NULL,
    "timeTo2xMin" DOUBLE PRECISION,
    "timeTo5xMin" DOUBLE PRECISION,
    "timeTo10xMin" DOUBLE PRECISION,
    "smartExitedBeforeDump" BOOLEAN,
    "notes" TEXT,

    CONSTRAINT "backtest_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "address_registry" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "address" TEXT NOT NULL,
    "category" "AddressCategory" NOT NULL,
    "label" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "doNotExpand" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "address_registry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallets_address_chain_key" ON "wallets"("address", "chain");

-- CreateIndex
CREATE INDEX "wallet_stats_walletId_idx" ON "wallet_stats"("walletId");

-- CreateIndex
CREATE INDEX "wallet_classifications_walletId_idx" ON "wallet_classifications"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_chain_address_key" ON "tokens"("chain", "address");

-- CreateIndex
CREATE INDEX "token_market_snapshots_tokenId_ts_idx" ON "token_market_snapshots"("tokenId", "ts");

-- CreateIndex
CREATE INDEX "wallet_token_trades_walletId_idx" ON "wallet_token_trades"("walletId");

-- CreateIndex
CREATE INDEX "wallet_token_trades_tokenId_idx" ON "wallet_token_trades"("tokenId");

-- CreateIndex
CREATE INDEX "wallet_token_trades_entityClusterId_idx" ON "wallet_token_trades"("entityClusterId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_token_trades_chain_txHash_walletId_tokenId_action_key" ON "wallet_token_trades"("chain", "txHash", "walletId", "tokenId", "action");

-- CreateIndex
CREATE INDEX "token_flow_snapshots_tokenId_ts_idx" ON "token_flow_snapshots"("tokenId", "ts");

-- CreateIndex
CREATE INDEX "token_flow_snapshots_flowScore_idx" ON "token_flow_snapshots"("flowScore");

-- CreateIndex
CREATE INDEX "signals_severity_triggeredAt_idx" ON "signals"("severity", "triggeredAt");

-- CreateIndex
CREATE INDEX "signals_tokenId_idx" ON "signals"("tokenId");

-- CreateIndex
CREATE INDEX "alerts_tokenId_rule_sentAt_idx" ON "alerts"("tokenId", "rule", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "provider_sync_states_provider_chain_scope_key" ON "provider_sync_states"("provider", "chain", "scope");

-- CreateIndex
CREATE INDEX "money_flow_edges_sourceAddress_ts_idx" ON "money_flow_edges"("sourceAddress", "ts");

-- CreateIndex
CREATE INDEX "money_flow_edges_destinationAddress_ts_idx" ON "money_flow_edges"("destinationAddress", "ts");

-- CreateIndex
CREATE INDEX "money_flow_edges_txHash_idx" ON "money_flow_edges"("txHash");

-- CreateIndex
CREATE INDEX "money_flow_edges_sourceChain_ts_idx" ON "money_flow_edges"("sourceChain", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "entity_cluster_wallets_clusterId_walletId_key" ON "entity_cluster_wallets"("clusterId", "walletId");

-- CreateIndex
CREATE INDEX "profit_rotation_signals_sourceWalletId_idx" ON "profit_rotation_signals"("sourceWalletId");

-- CreateIndex
CREATE INDEX "profit_rotation_signals_destWalletId_idx" ON "profit_rotation_signals"("destWalletId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_graph_nodes_searchId_address_key" ON "wallet_graph_nodes"("searchId", "address");

-- CreateIndex
CREATE INDEX "wallet_graph_edges_searchId_idx" ON "wallet_graph_edges"("searchId");

-- CreateIndex
CREATE UNIQUE INDEX "backtest_results_signalId_horizon_key" ON "backtest_results"("signalId", "horizon");

-- CreateIndex
CREATE UNIQUE INDEX "address_registry_chain_address_key" ON "address_registry"("chain", "address");

-- AddForeignKey
ALTER TABLE "wallet_stats" ADD CONSTRAINT "wallet_stats_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_classifications" ADD CONSTRAINT "wallet_classifications_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_market_snapshots" ADD CONSTRAINT "token_market_snapshots_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_token_trades" ADD CONSTRAINT "wallet_token_trades_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_token_trades" ADD CONSTRAINT "wallet_token_trades_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_token_trades" ADD CONSTRAINT "wallet_token_trades_entityClusterId_fkey" FOREIGN KEY ("entityClusterId") REFERENCES "entity_clusters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_flow_snapshots" ADD CONSTRAINT "token_flow_snapshots_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_cluster_wallets" ADD CONSTRAINT "entity_cluster_wallets_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "entity_clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_cluster_wallets" ADD CONSTRAINT "entity_cluster_wallets_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profit_rotation_signals" ADD CONSTRAINT "profit_rotation_signals_sourceWalletId_fkey" FOREIGN KEY ("sourceWalletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profit_rotation_signals" ADD CONSTRAINT "profit_rotation_signals_destWalletId_fkey" FOREIGN KEY ("destWalletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profit_rotation_signals" ADD CONSTRAINT "profit_rotation_signals_sourceTokenId_fkey" FOREIGN KEY ("sourceTokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profit_rotation_signals" ADD CONSTRAINT "profit_rotation_signals_destTokenId_fkey" FOREIGN KEY ("destTokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_graph_nodes" ADD CONSTRAINT "wallet_graph_nodes_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "wallet_graph_searches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_graph_edges" ADD CONSTRAINT "wallet_graph_edges_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "wallet_graph_searches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtest_results" ADD CONSTRAINT "backtest_results_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
