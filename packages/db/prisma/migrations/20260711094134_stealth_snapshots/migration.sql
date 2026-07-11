-- CreateEnum
CREATE TYPE "StealthState" AS ENUM ('WATCHING', 'STEALTH_ACCUMULATION', 'EARLY_INDEPENDENT_CONFIRMATION', 'PUBLIC_KOL_ARRIVAL', 'CROWD_EXPANSION', 'DISTRIBUTION_RISK', 'INVALIDATED');

-- CreateTable
CREATE TABLE "stealth_snapshots" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "state" "StealthState" NOT NULL,
    "previousState" "StealthState",
    "stateChanged" BOOLEAN NOT NULL,
    "stealthScore" DOUBLE PRECISION NOT NULL,
    "metrics" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "explanation" TEXT NOT NULL,
    "invalidationReasons" JSONB NOT NULL,
    "bucketTs" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stealth_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stealth_snapshots_state_bucketTs_idx" ON "stealth_snapshots"("state", "bucketTs");

-- CreateIndex
CREATE INDEX "stealth_snapshots_tokenId_computedAt_idx" ON "stealth_snapshots"("tokenId", "computedAt");

-- CreateIndex
CREATE UNIQUE INDEX "stealth_snapshots_tokenId_bucketTs_key" ON "stealth_snapshots"("tokenId", "bucketTs");

-- AddForeignKey
ALTER TABLE "stealth_snapshots" ADD CONSTRAINT "stealth_snapshots_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
