-- Additive: funding_reactivation_paths (dormancy Task 9, shadow-only).
CREATE TABLE "funding_reactivation_paths" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "anchorKey" TEXT NOT NULL,
    "eventTs" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "directFunderAddress" TEXT,
    "directFundingTs" TIMESTAMP(3),
    "directFundingAsset" TEXT,
    "directFundingValuedUsd" DECIMAL(20,4),
    "directFundingTxHash" TEXT,
    "firstFunderAddress" TEXT,
    "firstFundingTs" TIMESTAMP(3),
    "firstFundingTxHash" TEXT,
    "fundingToEventDelaySec" INTEGER,
    "pathDepth" INTEGER NOT NULL DEFAULT 0,
    "nodesExplored" INTEGER NOT NULL DEFAULT 0,
    "pathTruncated" BOOLEAN NOT NULL DEFAULT false,
    "pathJson" JSONB NOT NULL,
    "funderRelationshipTier" TEXT,
    "funderRelationshipConfidence" DOUBLE PRECISION,
    "repeatFundingCount" INTEGER NOT NULL DEFAULT 0,
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "receiptsJson" JSONB NOT NULL,
    "caveats" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "funding_reactivation_paths_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "funding_reactivation_paths_chain_walletAddress_eventKind_a_key" ON "funding_reactivation_paths"("chain", "walletAddress", "eventKind", "anchorKey");
CREATE INDEX "funding_reactivation_paths_status_idx" ON "funding_reactivation_paths"("status");
CREATE INDEX "funding_reactivation_paths_directFunderAddress_idx" ON "funding_reactivation_paths"("directFunderAddress");
