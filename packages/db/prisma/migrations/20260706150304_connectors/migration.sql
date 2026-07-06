-- CreateEnum
CREATE TYPE "CandidateValidationStatus" AS ENUM ('pending', 'validating', 'promoted', 'rejected');

-- CreateTable
CREATE TABLE "external_wallet_sources" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "chainSupport" TEXT[],
    "apiKeyEnvName" TEXT NOT NULL,
    "rateLimitPerMinute" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "metadataJson" JSONB,

    CONSTRAINT "external_wallet_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_wallets" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRank" INTEGER,
    "claimedPnlUsd" DECIMAL(20,4),
    "claimedWinRate" DOUBLE PRECISION,
    "claimedTradeCount" INTEGER,
    "claimedRoi" DOUBLE PRECISION,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "validationStatus" "CandidateValidationStatus" NOT NULL DEFAULT 'pending',
    "validationConfidence" INTEGER,
    "promotedWalletId" TEXT,
    "rejectionReason" TEXT,
    "metadataJson" JSONB,

    CONSTRAINT "candidate_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "external_wallet_sources_name_key" ON "external_wallet_sources"("name");

-- CreateIndex
CREATE INDEX "candidate_wallets_validationStatus_idx" ON "candidate_wallets"("validationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_wallets_walletAddress_chain_source_key" ON "candidate_wallets"("walletAddress", "chain", "source");

-- AddForeignKey
ALTER TABLE "candidate_wallets" ADD CONSTRAINT "candidate_wallets_promotedWalletId_fkey" FOREIGN KEY ("promotedWalletId") REFERENCES "wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
