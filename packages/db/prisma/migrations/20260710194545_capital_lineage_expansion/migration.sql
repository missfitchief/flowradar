-- CreateEnum
CREATE TYPE "WalletRelationshipKind" AS ENUM ('first_funder', 'direct_funding', 'repeated_transfer', 'fresh_wallet_activation', 'service_interrupted', 'unknown');

-- CreateEnum
CREATE TYPE "ExpansionPriority" AS ENUM ('first_funder', 'direct_high_value', 'fresh_activation', 'post_funding_buy', 'bridge_correlated', 'repeated_transfer', 'profit_rotation', 'weak');

-- CreateEnum
CREATE TYPE "ExpansionNodeStatus" AS ENUM ('pending', 'in_progress', 'done', 'skipped');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MonitoringPriority" ADD VALUE 'strong_link';
ALTER TYPE "MonitoringPriority" ADD VALUE 'probable_link';

-- CreateTable
CREATE TABLE "wallet_relationships" (
    "id" TEXT NOT NULL,
    "lineageRootId" TEXT NOT NULL,
    "walletAId" TEXT NOT NULL,
    "walletBId" TEXT NOT NULL,
    "kind" "WalletRelationshipKind" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "interactionCount" INTEGER NOT NULL DEFAULT 1,
    "valueTransferredUsd" DECIMAL(20,4) NOT NULL,
    "evidence" JSONB NOT NULL,

    CONSTRAINT "wallet_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lineage_expansion_nodes" (
    "id" TEXT NOT NULL,
    "lineageRootId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "depth" INTEGER NOT NULL,
    "priority" "ExpansionPriority" NOT NULL,
    "status" "ExpansionNodeStatus" NOT NULL DEFAULT 'pending',
    "stopReason" TEXT,
    "discoveredVia" TEXT NOT NULL,
    "cursor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lineage_expansion_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallet_relationships_walletBId_idx" ON "wallet_relationships"("walletBId");

-- CreateIndex
CREATE INDEX "wallet_relationships_lineageRootId_kind_idx" ON "wallet_relationships"("lineageRootId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_relationships_lineageRootId_walletAId_walletBId_kind_key" ON "wallet_relationships"("lineageRootId", "walletAId", "walletBId", "kind");

-- CreateIndex
CREATE INDEX "lineage_expansion_nodes_status_priority_idx" ON "lineage_expansion_nodes"("status", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "lineage_expansion_nodes_lineageRootId_walletAddress_key" ON "lineage_expansion_nodes"("lineageRootId", "walletAddress");

-- AddForeignKey
ALTER TABLE "wallet_relationships" ADD CONSTRAINT "wallet_relationships_lineageRootId_fkey" FOREIGN KEY ("lineageRootId") REFERENCES "lineage_roots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_relationships" ADD CONSTRAINT "wallet_relationships_walletAId_fkey" FOREIGN KEY ("walletAId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_relationships" ADD CONSTRAINT "wallet_relationships_walletBId_fkey" FOREIGN KEY ("walletBId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lineage_expansion_nodes" ADD CONSTRAINT "lineage_expansion_nodes_lineageRootId_fkey" FOREIGN KEY ("lineageRootId") REFERENCES "lineage_roots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
