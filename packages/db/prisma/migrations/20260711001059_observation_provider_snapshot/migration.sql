-- AlterTable
ALTER TABLE "wallet_relationships" ADD COLUMN     "unknownValueTxCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "observation_provider_snapshot" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "pnlUsd" DECIMAL(20,4),
    "winRate" DOUBLE PRECISION,
    "tradeCount" INTEGER,
    "avgTradeSizeUsd" DECIMAL(20,4),
    "providerClaimed" BOOLEAN NOT NULL DEFAULT true,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "observation_provider_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "observation_provider_snapshot_walletId_idx" ON "observation_provider_snapshot"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "observation_provider_snapshot_walletId_source_window_key" ON "observation_provider_snapshot"("walletId", "source", "window");

-- AddForeignKey
ALTER TABLE "observation_provider_snapshot" ADD CONSTRAINT "observation_provider_snapshot_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
