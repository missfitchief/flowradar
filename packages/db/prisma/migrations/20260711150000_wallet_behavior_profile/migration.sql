-- Additive: wallet_behavior_profiles (behavior reconstruction, shadow-only).
CREATE TABLE "wallet_behavior_profiles" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "engineVersion" INTEGER NOT NULL,
    "dataQuality" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "profileJson" JSONB NOT NULL,
    "classifierJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_behavior_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallet_behavior_profiles_chain_walletAddress_key" ON "wallet_behavior_profiles"("chain", "walletAddress");
CREATE INDEX "wallet_behavior_profiles_dataQuality_idx" ON "wallet_behavior_profiles"("dataQuality");
