-- Additive: discovery sprint — evidence-backed wallet roles + entity DNA.

CREATE TABLE "wallet_role_assignments" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "evidenceTier" TEXT NOT NULL,
    "entityKey" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "receiptsJson" JSONB NOT NULL,
    "caveats" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wallet_role_assignments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "wallet_role_assignments_chain_walletAddress_role_key" ON "wallet_role_assignments"("chain", "walletAddress", "role");
CREATE INDEX "wallet_role_assignments_role_idx" ON "wallet_role_assignments"("role");
CREATE INDEX "wallet_role_assignments_entityKey_idx" ON "wallet_role_assignments"("entityKey");

CREATE TABLE "entity_dna_profiles" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "entityKey" TEXT NOT NULL,
    "memberWallets" TEXT[] NOT NULL DEFAULT '{}',
    "memberCount" INTEGER NOT NULL DEFAULT 1,
    "rootWallet" TEXT,
    "linkEvidenceJson" JSONB NOT NULL,
    "runnersInvolved" INTEGER NOT NULL DEFAULT 0,
    "completedPositions" INTEGER NOT NULL DEFAULT 0,
    "winCount" INTEGER NOT NULL DEFAULT 0,
    "lossCount" INTEGER NOT NULL DEFAULT 0,
    "unresolvedPositions" INTEGER NOT NULL DEFAULT 0,
    "winRate" DOUBLE PRECISION,
    "evUsdPerCompletedPosition" DOUBLE PRECISION,
    "avgReturn" DOUBLE PRECISION,
    "medianReturn" DOUBLE PRECISION,
    "totalRealizedPnlUsd" DECIMAL(24,4),
    "repeatRunnerCount" INTEGER,
    "oneWinnerDependence" DOUBLE PRECISION,
    "dormantReactivations" INTEGER NOT NULL DEFAULT 0,
    "fundedEntries" INTEGER NOT NULL DEFAULT 0,
    "stagedCapitalUsd" DECIMAL(24,4),
    "undeployedReceivers" INTEGER NOT NULL DEFAULT 0,
    "deployedReceivers" INTEGER NOT NULL DEFAULT 0,
    "coverage" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "receiptsJson" JSONB NOT NULL,
    "caveats" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "entity_dna_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "entity_dna_profiles_chain_entityKey_key" ON "entity_dna_profiles"("chain", "entityKey");
CREATE INDEX "entity_dna_profiles_memberCount_idx" ON "entity_dna_profiles"("memberCount");
