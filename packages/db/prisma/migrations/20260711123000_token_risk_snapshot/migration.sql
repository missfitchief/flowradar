-- CreateEnum
CREATE TYPE "RiskSnapshotStatus" AS ENUM ('ok', 'unavailable', 'throttled', 'error');

-- CreateTable
CREATE TABLE "token_risk_snapshots" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3),
    "status" "RiskSnapshotStatus" NOT NULL,
    "flags" JSONB NOT NULL,
    "penalty" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "errorCategory" TEXT,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "nextRefreshAt" TIMESTAMP(3) NOT NULL,
    "sourceVersion" INTEGER NOT NULL DEFAULT 1,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "token_risk_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "token_risk_snapshots_tokenId_key" ON "token_risk_snapshots"("tokenId");
CREATE UNIQUE INDEX "token_risk_snapshots_chain_tokenAddress_key" ON "token_risk_snapshots"("chain", "tokenAddress");
CREATE INDEX "token_risk_snapshots_nextRefreshAt_idx" ON "token_risk_snapshots"("nextRefreshAt");
CREATE INDEX "token_risk_snapshots_status_idx" ON "token_risk_snapshots"("status");

-- AddForeignKey
ALTER TABLE "token_risk_snapshots" ADD CONSTRAINT "token_risk_snapshots_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
