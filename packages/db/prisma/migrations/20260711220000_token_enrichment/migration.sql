-- Additive: Birdeye historical enrichment evidence (shadow-only analytics).
CREATE TABLE "token_enrichments" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'birdeye',
    "ohlcvStartTs" TIMESTAMP(3),
    "ohlcvEndTs" TIMESTAMP(3),
    "candleCount" INTEGER NOT NULL DEFAULT 0,
    "candlesJson" JSONB,
    "supplyJson" JSONB,
    "athMcapUsd" DECIMAL(24,4),
    "athTs" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "receiptsJson" JSONB NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastSuccessAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "token_enrichments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "token_enrichments_mint_key" ON "token_enrichments"("mint");
CREATE INDEX "token_enrichments_status_idx" ON "token_enrichments"("status");
