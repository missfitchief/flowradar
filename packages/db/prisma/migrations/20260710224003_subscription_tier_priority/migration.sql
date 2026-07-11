-- DropIndex
DROP INDEX "monitoring_subscriptions_active_nextPollAt_idx";

-- AlterTable
ALTER TABLE "monitoring_subscriptions" ADD COLUMN     "tierPriority" INTEGER NOT NULL DEFAULT 99;

-- CreateIndex
CREATE INDEX "monitoring_subscriptions_active_tierPriority_nextPollAt_idx" ON "monitoring_subscriptions"("active", "tierPriority", "nextPollAt");

-- Backfill tierPriority from the tier (0=highest). Must match @flowradar/core
-- tierRank order: fresh_receiver_hot, root_permanent, strong_link,
-- probable_link, standard, weak_cold, cold_archive.
UPDATE "monitoring_subscriptions" SET "tierPriority" = CASE "priority"
  WHEN 'fresh_receiver_hot' THEN 0
  WHEN 'root_permanent' THEN 1
  WHEN 'strong_link' THEN 2
  WHEN 'probable_link' THEN 3
  WHEN 'standard' THEN 4
  WHEN 'weak_cold' THEN 5
  WHEN 'cold_archive' THEN 6
  ELSE 99 END;
