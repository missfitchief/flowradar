-- Additive: runner-mining universe/cohort/entry tables (shadow-only analytics).
CREATE TABLE "token_lifecycles" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "tokenId" TEXT,
    "enteredUniverseAt" TIMESTAMP(3) NOT NULL,
    "sourcesJson" JSONB NOT NULL,
    "coverage" TEXT NOT NULL,
    "seriesPointCount" INTEGER NOT NULL DEFAULT 0,
    "firstObservedAt" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3),
    "runnerClass" TEXT,
    "athMcapUsd" DECIMAL(20,4),
    "athTs" TIMESTAMP(3),
    "baselineMcapUsd" DECIMAL(20,4),
    "outcomeLabels" JSONB,
    "confidence" TEXT,
    "evidenceJson" JSONB,
    "classifiedAt" TIMESTAMP(3),
    "engineVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "token_lifecycles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "token_lifecycles_mint_key" ON "token_lifecycles"("mint");
CREATE INDEX "token_lifecycles_coverage_idx" ON "token_lifecycles"("coverage");
CREATE INDEX "token_lifecycles_runnerClass_idx" ON "token_lifecycles"("runnerClass");

CREATE TABLE "cohort_matches" (
    "id" TEXT NOT NULL,
    "runnerMint" TEXT NOT NULL,
    "controlMint" TEXT,
    "status" TEXT NOT NULL,
    "tier" TEXT,
    "distance" DOUBLE PRECISION,
    "featuresJson" JSONB NOT NULL,
    "excludedJson" JSONB,
    "confidence" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cohort_matches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cohort_matches_runnerMint_key" ON "cohort_matches"("runnerMint");
CREATE INDEX "cohort_matches_status_idx" ON "cohort_matches"("status");

CREATE TABLE "early_buyer_entries" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "cohort" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "blockOrSlot" BIGINT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "entryMcapUsd" DECIMAL(20,4),
    "band" TEXT NOT NULL,
    "buyerRank" INTEGER NOT NULL,
    "confidence" TEXT NOT NULL,
    "sourceJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "early_buyer_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "early_buyer_entries_mint_txHash_walletAddress_key" ON "early_buyer_entries"("mint", "txHash", "walletAddress");
CREATE INDEX "early_buyer_entries_mint_idx" ON "early_buyer_entries"("mint");
CREATE INDEX "early_buyer_entries_band_idx" ON "early_buyer_entries"("band");
