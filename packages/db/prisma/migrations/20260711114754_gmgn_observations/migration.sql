-- CreateTable
CREATE TABLE "gmgn_observations" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "sourceCommand" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "activityType" TEXT,
    "side" TEXT,
    "amountToken" DECIMAL(38,18),
    "amountUsd" DECIMAL(20,4),
    "providerPnlUsd" DECIMAL(20,4),
    "providerWinRate" DOUBLE PRECISION,
    "providerTradeCount" INTEGER,
    "rawClassification" JSONB,
    "isKolTagged" BOOLEAN NOT NULL DEFAULT false,
    "isPromoterTagged" BOOLEAN NOT NULL DEFAULT false,
    "activityTs" TIMESTAMP(3),
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "cursor" TEXT,
    "dataQuality" TEXT NOT NULL DEFAULT 'complete',
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gmgn_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gmgn_observations_walletAddress_idx" ON "gmgn_observations"("walletAddress");

-- CreateIndex
CREATE INDEX "gmgn_observations_tokenAddress_idx" ON "gmgn_observations"("tokenAddress");

-- CreateIndex
CREATE INDEX "gmgn_observations_sourceCommand_retrievedAt_idx" ON "gmgn_observations"("sourceCommand", "retrievedAt");

-- CreateIndex
CREATE UNIQUE INDEX "gmgn_observations_dedupeKey_key" ON "gmgn_observations"("dedupeKey");
