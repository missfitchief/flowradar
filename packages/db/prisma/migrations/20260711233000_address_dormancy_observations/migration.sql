-- Additive: address_dormancy_observations (dormancy Task 7, shadow-only).
CREATE TABLE "address_dormancy_observations" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "anchorKey" TEXT NOT NULL,
    "eventTs" TIMESTAMP(3) NOT NULL,
    "overallClass" TEXT NOT NULL,
    "maxCoveredDormantDays" INTEGER,
    "coverageStartTs" TIMESTAMP(3),
    "meaningfulEventCount" INTEGER NOT NULL,
    "windowsJson" JSONB NOT NULL,
    "receiptsJson" JSONB NOT NULL,
    "caveats" TEXT[],
    "engineVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "address_dormancy_observations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "address_dormancy_observations_chain_walletAddress_eventKin_key" ON "address_dormancy_observations"("chain", "walletAddress", "eventKind", "anchorKey");
CREATE INDEX "address_dormancy_observations_overallClass_idx" ON "address_dormancy_observations"("overallClass");
CREATE INDEX "address_dormancy_observations_chain_walletAddress_idx" ON "address_dormancy_observations"("chain", "walletAddress");
