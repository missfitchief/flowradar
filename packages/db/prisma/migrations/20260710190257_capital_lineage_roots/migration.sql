-- CreateEnum
CREATE TYPE "MonitoringPriority" AS ENUM ('fresh_receiver_hot', 'root_permanent', 'standard', 'weak_cold');

-- CreateTable
CREATE TABLE "lineage_roots" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "label" TEXT,
    "fileProvenance" TEXT,
    "permanent" BOOLEAN NOT NULL DEFAULT true,
    "firstImportedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenInImportAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lineage_roots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitoring_subscriptions" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "priority" "MonitoringPriority" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    "lineageRootId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitoring_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lineage_roots_walletId_key" ON "lineage_roots"("walletId");

-- CreateIndex
CREATE INDEX "lineage_roots_source_idx" ON "lineage_roots"("source");

-- CreateIndex
CREATE INDEX "monitoring_subscriptions_priority_active_idx" ON "monitoring_subscriptions"("priority", "active");

-- CreateIndex
CREATE UNIQUE INDEX "monitoring_subscriptions_walletId_priority_key" ON "monitoring_subscriptions"("walletId", "priority");

-- AddForeignKey
ALTER TABLE "lineage_roots" ADD CONSTRAINT "lineage_roots_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_subscriptions" ADD CONSTRAINT "monitoring_subscriptions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_subscriptions" ADD CONSTRAINT "monitoring_subscriptions_lineageRootId_fkey" FOREIGN KEY ("lineageRootId") REFERENCES "lineage_roots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
