-- AlterEnum
ALTER TYPE "MonitoringPriority" ADD VALUE 'cold_archive';

-- AlterTable
ALTER TABLE "monitoring_subscriptions" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "hotUntil" TIMESTAMP(3),
ADD COLUMN     "lastPolledAt" TIMESTAMP(3),
ADD COLUMN     "nextPollAt" TIMESTAMP(3),
ADD COLUMN     "pollCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "monitoring_subscriptions_active_nextPollAt_idx" ON "monitoring_subscriptions"("active", "nextPollAt");
