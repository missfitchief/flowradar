CREATE TABLE "token_wallet_intelligence" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'observation_only',
    "role" TEXT NOT NULL,
    "entityKey" TEXT,
    "qualityScore" DOUBLE PRECISION NOT NULL,
    "evidenceConfidence" DOUBLE PRECISION NOT NULL,
    "localBuyCount" INTEGER NOT NULL DEFAULT 0,
    "localSellCount" INTEGER NOT NULL DEFAULT 0,
    "localTransferCount" INTEGER NOT NULL DEFAULT 0,
    "localRealizedPnlUsd" DECIMAL(24,4),
    "entryTs" TIMESTAMP(3),
    "exitTs" TIMESTAMP(3),
    "dormant7d" BOOLEAN,
    "dormant14d" BOOLEAN,
    "dormant30d" BOOLEAN,
    "dormant90d" BOOLEAN,
    "funderAddress" TEXT,
    "funderTxHash" TEXT,
    "completedPositions" INTEGER NOT NULL DEFAULT 0,
    "winCount" INTEGER NOT NULL DEFAULT 0,
    "lossCount" INTEGER NOT NULL DEFAULT 0,
    "unresolvedPositions" INTEGER NOT NULL DEFAULT 0,
    "winRate" DOUBLE PRECISION,
    "evUsd" DOUBLE PRECISION,
    "repeatRunnerCount" INTEGER,
    "oneWinnerDependence" DOUBLE PRECISION,
    "coverage" TEXT NOT NULL,
    "supportingEvidenceJson" JSONB NOT NULL,
    "contradictingEvidenceJson" JSONB NOT NULL,
    "monitoringEnrolled" BOOLEAN NOT NULL DEFAULT false,
    "engineVersion" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "token_wallet_intelligence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "token_wallet_intel_unique" ON "token_wallet_intelligence"("chain", "tokenAddress", "walletAddress");
CREATE INDEX "token_wallet_intel_rank_idx" ON "token_wallet_intelligence"("chain", "tokenAddress", "qualityScore");
CREATE INDEX "token_wallet_intel_wallet_idx" ON "token_wallet_intelligence"("chain", "walletAddress");

CREATE TABLE "wallet_flow_relationships" (
    "id" TEXT NOT NULL,
    "sourceChain" "ChainId" NOT NULL,
    "sourceWallet" TEXT NOT NULL,
    "sourceEntityKey" TEXT,
    "relatedChain" "ChainId" NOT NULL,
    "relatedWallet" TEXT NOT NULL,
    "relatedEntityKey" TEXT,
    "role" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "hops" INTEGER NOT NULL,
    "transferCount" INTEGER NOT NULL DEFAULT 0,
    "firstTransferTs" TIMESTAMP(3) NOT NULL,
    "lastTransferTs" TIMESTAMP(3) NOT NULL,
    "relationshipConfidence" DOUBLE PRECISION NOT NULL,
    "safeEntityLink" BOOLEAN NOT NULL DEFAULT false,
    "transferReceiptIds" TEXT[],
    "bridgeCorrelationIds" TEXT[],
    "supportingEvidenceJson" JSONB NOT NULL,
    "contradictingEvidenceJson" JSONB NOT NULL,
    "tradedTokensJson" JSONB NOT NULL,
    "pnlMetricsJson" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'observation_only',
    "engineVersion" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wallet_flow_relationships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallet_flow_rel_unique" ON "wallet_flow_relationships"("sourceChain", "sourceWallet", "relatedChain", "relatedWallet", "route");
CREATE INDEX "wallet_flow_rel_related_idx" ON "wallet_flow_relationships"("relatedChain", "relatedWallet");
CREATE INDEX "wallet_flow_rel_entity_idx" ON "wallet_flow_relationships"("sourceEntityKey");
CREATE INDEX "wallet_flow_rel_safe_idx" ON "wallet_flow_relationships"("safeEntityLink");

CREATE TABLE "tracked_token_activation_alerts" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "alertType" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL,
    "trackedWallets" TEXT[],
    "entityKeys" TEXT[],
    "trackedWalletCount" INTEGER NOT NULL DEFAULT 0,
    "independentEntityCount" INTEGER NOT NULL DEFAULT 0,
    "sourceEventIds" TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL,
    "historicalToken" BOOLEAN NOT NULL DEFAULT false,
    "evidenceJson" JSONB NOT NULL,
    "caveats" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "engineVersion" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tracked_token_activation_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tracked_activation_alert_dedupe" ON "tracked_token_activation_alerts"("dedupeKey");
CREATE INDEX "tracked_activation_alert_token_idx" ON "tracked_token_activation_alerts"("chain", "tokenAddress", "activatedAt");
CREATE INDEX "tracked_activation_alert_status_idx" ON "tracked_token_activation_alerts"("status", "activatedAt");

CREATE TABLE "tracked_activation_scan_runs" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "sinceTs" TIMESTAMP(3) NOT NULL,
    "trackedWallets" INTEGER NOT NULL DEFAULT 0,
    "newBuyEvents" INTEGER NOT NULL DEFAULT 0,
    "tokensConsidered" INTEGER NOT NULL DEFAULT 0,
    "alertsCreated" INTEGER NOT NULL DEFAULT 0,
    "historicalWithoutActivitySkipped" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "metadataJson" JSONB NOT NULL,
    CONSTRAINT "tracked_activation_scan_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tracked_activation_scan_started_idx" ON "tracked_activation_scan_runs"("startedAt");
CREATE INDEX "tracked_activation_scan_status_idx" ON "tracked_activation_scan_runs"("status");
