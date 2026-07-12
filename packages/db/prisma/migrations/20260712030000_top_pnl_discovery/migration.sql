-- Additive: top-PnL discovery pipeline (runner-mining scope correction) —
-- token_top_pnl_candidates + per-mint provider fetch state + wallet DNA.
-- SHADOW-ONLY / OBSERVATION-ONLY: never read by FlowScore/signals/eligibility.

CREATE TABLE "token_top_pnl_candidates" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "mint" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "providerRank" INTEGER,
    "claimedRealizedPnlUsd" DECIMAL(24,4),
    "claimedUnrealizedPnlUsd" DECIMAL(24,4),
    "claimedTotalPnlUsd" DECIMAL(24,4),
    "claimedBoughtUsd" DECIMAL(24,4),
    "claimedSoldUsd" DECIMAL(24,4),
    "claimedRemainingUsd" DECIMAL(24,4),
    "claimedRoi" DOUBLE PRECISION,
    "claimedTradeCount" INTEGER,
    "providerTags" TEXT[] NOT NULL DEFAULT '{}',
    "providerTimeFrame" TEXT,
    "providerJson" JSONB,
    "localBuyCount" INTEGER NOT NULL DEFAULT 0,
    "localSellCount" INTEGER NOT NULL DEFAULT 0,
    "localBoughtUsd" DECIMAL(24,4),
    "localSoldUsd" DECIMAL(24,4),
    "localRealizedProxyUsd" DECIMAL(24,4),
    "localFirstBuyTs" TIMESTAMP(3),
    "localFirstSellTs" TIMESTAMP(3),
    "localLastSellTs" TIMESTAMP(3),
    "localUnpricedTrades" INTEGER NOT NULL DEFAULT 0,
    "validation" TEXT NOT NULL,
    "coverage" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "receiptsJson" JSONB NOT NULL,
    "caveats" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_top_pnl_candidates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "token_top_pnl_candidates_chain_mint_walletAddress_source_key" ON "token_top_pnl_candidates"("chain", "mint", "walletAddress", "source");
CREATE INDEX "token_top_pnl_candidates_mint_idx" ON "token_top_pnl_candidates"("mint");
CREATE INDEX "token_top_pnl_candidates_walletAddress_idx" ON "token_top_pnl_candidates"("walletAddress");
CREATE INDEX "token_top_pnl_candidates_validation_idx" ON "token_top_pnl_candidates"("validation");

CREATE TABLE "top_pnl_fetch_states" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'birdeye_top_traders',
    "status" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "fetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "top_pnl_fetch_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "top_pnl_fetch_states_mint_provider_key" ON "top_pnl_fetch_states"("mint", "provider");
CREATE INDEX "top_pnl_fetch_states_status_idx" ON "top_pnl_fetch_states"("status");

CREATE TABLE "wallet_dna_profiles" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'observation_only',
    "tokensEntered" INTEGER NOT NULL DEFAULT 0,
    "runnersEntered" INTEGER NOT NULL DEFAULT 0,
    "completedPositions" INTEGER NOT NULL DEFAULT 0,
    "openPositions" INTEGER NOT NULL DEFAULT 0,
    "unpricedPositions" INTEGER NOT NULL DEFAULT 0,
    "winCount" INTEGER NOT NULL DEFAULT 0,
    "lossCount" INTEGER NOT NULL DEFAULT 0,
    "winRate" DOUBLE PRECISION,
    "evUsdPerCompletedPosition" DOUBLE PRECISION,
    "oneWinnerDependence" DOUBLE PRECISION,
    "outcomeMixJson" JSONB,
    "dormancySummaryJson" JSONB,
    "fundingSummaryJson" JSONB,
    "postEntryMixJson" JSONB,
    "negativeEvidenceJson" JSONB,
    "discoveryJson" JSONB,
    "coverage" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "receiptsJson" JSONB NOT NULL,
    "caveats" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_dna_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallet_dna_profiles_chain_walletAddress_key" ON "wallet_dna_profiles"("chain", "walletAddress");
CREATE INDEX "wallet_dna_profiles_coverage_idx" ON "wallet_dna_profiles"("coverage");
