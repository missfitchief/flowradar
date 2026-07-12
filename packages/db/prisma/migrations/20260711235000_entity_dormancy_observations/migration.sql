-- Additive: entity_dormancy_observations (dormancy Task 8, shadow-only).
CREATE TABLE "entity_dormancy_observations" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "anchorKey" TEXT NOT NULL,
    "eventTs" TIMESTAMP(3) NOT NULL,
    "entityClass" TEXT NOT NULL,
    "addressClass" TEXT NOT NULL,
    "linkedWalletsConsidered" INTEGER NOT NULL,
    "linkedWalletsActive" INTEGER NOT NULL,
    "serviceNodesExcluded" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasonCodes" TEXT[],
    "linksJson" JSONB NOT NULL,
    "receiptsJson" JSONB NOT NULL,
    "caveats" TEXT[],
    "engineVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_dormancy_observations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "entity_dormancy_observations_chain_walletAddress_eventKind_key" ON "entity_dormancy_observations"("chain", "walletAddress", "eventKind", "anchorKey");
CREATE INDEX "entity_dormancy_observations_entityClass_idx" ON "entity_dormancy_observations"("entityClass");
CREATE INDEX "entity_dormancy_observations_chain_walletAddress_idx" ON "entity_dormancy_observations"("chain", "walletAddress");
