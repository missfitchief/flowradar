CREATE TABLE "wallet_investigations" (
    "id" TEXT NOT NULL,
    "investigationKey" TEXT NOT NULL,
    "rootAddress" TEXT NOT NULL,
    "addressKind" TEXT NOT NULL,
    "maxDepth" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "entityKey" TEXT,
    "coverageStatus" TEXT NOT NULL,
    "summaryJson" JSONB NOT NULL,
    "providerReceiptsJson" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "lastRefreshAt" TIMESTAMP(3),
    "lastError" TEXT,
    "engineVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wallet_investigations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wallet_investigation_chain_coverage" (
    "id" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "activityFound" BOOLEAN NOT NULL DEFAULT false,
    "firstActivityAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "eventsScanned" INTEGER NOT NULL DEFAULT 0,
    "coverageStatus" TEXT NOT NULL,
    "provider" TEXT,
    "warnings" TEXT[],
    "receiptsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wallet_investigation_chain_coverage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wallet_investigation_paths" (
    "id" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "pathKey" TEXT NOT NULL,
    "routeType" TEXT NOT NULL,
    "sourceChain" "ChainId" NOT NULL,
    "sourceAddress" TEXT NOT NULL,
    "destinationChain" "ChainId" NOT NULL,
    "destinationAddress" TEXT NOT NULL,
    "assetAddress" TEXT,
    "assetSymbol" TEXT,
    "amountToken" TEXT,
    "amountUsd" DECIMAL(24,4),
    "valueStatus" TEXT NOT NULL,
    "eventTs" TIMESTAMP(3) NOT NULL,
    "txHash" TEXT,
    "protocol" TEXT,
    "evidenceTier" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "hopCount" INTEGER NOT NULL,
    "hopsJson" JSONB NOT NULL,
    "supportingEvidenceJson" JSONB NOT NULL,
    "contradictingEvidenceJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wallet_investigation_paths_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wallet_investigation_members" (
    "id" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "address" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "parentChain" "ChainId",
    "parentAddress" TEXT,
    "entityKey" TEXT,
    "relationshipConfidence" DOUBLE PRECISION NOT NULL,
    "evidenceTier" TEXT NOT NULL,
    "supportingEvidenceJson" JSONB NOT NULL,
    "contradictingEvidenceJson" JSONB NOT NULL,
    "firstLinkedAt" TIMESTAMP(3) NOT NULL,
    "lastLinkedAt" TIMESTAMP(3) NOT NULL,
    "observationOnly" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wallet_investigation_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wallet_investigation_deployments" (
    "id" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "deploymentKey" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "buyerAddress" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT,
    "buyTs" TIMESTAMP(3) NOT NULL,
    "buyTxHash" TEXT NOT NULL,
    "amountToken" TEXT,
    "amountUsd" DECIMAL(24,4),
    "entryMarketCapUsd" DECIMAL(24,4),
    "fundingToBuyDelaySec" INTEGER,
    "sourceEntityKey" TEXT,
    "capitalRouteJson" JSONB NOT NULL,
    "holdingStatus" TEXT NOT NULL,
    "evidenceTier" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wallet_investigation_deployments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallet_investigations_investigationKey_key" ON "wallet_investigations"("investigationKey");
CREATE INDEX "wallet_investigations_rootAddress_completedAt_idx" ON "wallet_investigations"("rootAddress", "completedAt");
CREATE INDEX "wallet_investigations_entityKey_completedAt_idx" ON "wallet_investigations"("entityKey", "completedAt");
CREATE INDEX "wallet_investigations_status_updatedAt_idx" ON "wallet_investigations"("status", "updatedAt");
CREATE UNIQUE INDEX "wallet_investigation_chain_coverage_investigationId_chain_key" ON "wallet_investigation_chain_coverage"("investigationId", "chain");
CREATE INDEX "wallet_investigation_chain_coverage_chain_activityFound_idx" ON "wallet_investigation_chain_coverage"("chain", "activityFound");
CREATE UNIQUE INDEX "wallet_investigation_paths_investigationId_pathKey_key" ON "wallet_investigation_paths"("investigationId", "pathKey");
CREATE INDEX "wallet_investigation_paths_investigationId_eventTs_idx" ON "wallet_investigation_paths"("investigationId", "eventTs");
CREATE INDEX "wallet_investigation_paths_investigationId_routeType_eventTs_idx" ON "wallet_investigation_paths"("investigationId", "routeType", "eventTs");
CREATE INDEX "wallet_investigation_paths_destinationChain_destinationAddress_idx" ON "wallet_investigation_paths"("destinationChain", "destinationAddress");
CREATE UNIQUE INDEX "wallet_investigation_members_investigationId_chain_address_key" ON "wallet_investigation_members"("investigationId", "chain", "address");
CREATE INDEX "wallet_investigation_members_entityKey_relationshipConfidence_idx" ON "wallet_investigation_members"("entityKey", "relationshipConfidence");
CREATE INDEX "wallet_investigation_members_chain_address_idx" ON "wallet_investigation_members"("chain", "address");
CREATE UNIQUE INDEX "wallet_investigation_deployments_investigationId_deploymentKey_key" ON "wallet_investigation_deployments"("investigationId", "deploymentKey");
CREATE INDEX "wallet_investigation_deployments_chain_tokenAddress_buyTs_idx" ON "wallet_investigation_deployments"("chain", "tokenAddress", "buyTs");
CREATE INDEX "wallet_investigation_deployments_buyerAddress_buyTs_idx" ON "wallet_investigation_deployments"("buyerAddress", "buyTs");

ALTER TABLE "wallet_investigation_chain_coverage" ADD CONSTRAINT "wallet_investigation_chain_coverage_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "wallet_investigations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wallet_investigation_paths" ADD CONSTRAINT "wallet_investigation_paths_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "wallet_investigations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wallet_investigation_members" ADD CONSTRAINT "wallet_investigation_members_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "wallet_investigations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wallet_investigation_deployments" ADD CONSTRAINT "wallet_investigation_deployments_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "wallet_investigations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
