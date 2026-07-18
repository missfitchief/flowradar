-- Additive: wallet_activity_classifications (dormancy Task 6, shadow-only).
CREATE TABLE "wallet_activity_classifications" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "sourceTable" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "eventRole" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "counterpartyAddress" TEXT,
    "eventTs" TIMESTAMP(3) NOT NULL,
    "usd" DECIMAL(20,4),
    "classification" TEXT NOT NULL,
    "meaningful" BOOLEAN NOT NULL,
    "reasonCodes" TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "receiptsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_activity_classifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallet_activity_classifications_sourceTable_sourceId_walle_key" ON "wallet_activity_classifications"("sourceTable", "sourceId", "walletAddress");
CREATE INDEX "wallet_activity_classifications_chain_walletAddress_meanin_idx" ON "wallet_activity_classifications"("chain", "walletAddress", "meaningful", "eventTs");
CREATE INDEX "wallet_activity_classifications_classification_idx" ON "wallet_activity_classifications"("classification");
