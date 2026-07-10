-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('observation_only', 'signal_eligible', 'public_kol', 'public_promoter', 'copytrader', 'bot_or_service', 'excluded');

-- AlterEnum
ALTER TYPE "StatsSource" ADD VALUE 'synthetic';

-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "status" "WalletStatus" NOT NULL DEFAULT 'observation_only';

-- CreateIndex
CREATE INDEX "wallets_status_idx" ON "wallets"("status");

-- Backfill (Phase 0, feat/pre-public-accumulation): map the legacy boolean
-- pair onto the status taxonomy. Order matters — exclusion wins over watch.
-- Everything else keeps the column default 'observation_only'.
UPDATE "wallets" SET "status" = 'signal_eligible' WHERE "isWatched" = true AND "isExcluded" = false;
UPDATE "wallets" SET "status" = 'excluded' WHERE "isExcluded" = true;
