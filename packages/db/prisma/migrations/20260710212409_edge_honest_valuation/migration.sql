-- CreateEnum
CREATE TYPE "ValuationStatus" AS ENUM ('exact_provider_historical', 'nearest_prior_snapshot', 'stablecoin_nominal', 'current_price_estimate', 'unavailable', 'not_applicable');

-- AlterTable
ALTER TABLE "money_flow_edges" ADD COLUMN     "assetMint" TEXT,
ADD COLUMN     "priceTimestamp" TIMESTAMP(3),
ADD COLUMN     "priceUsd" DECIMAL(24,12),
ADD COLUMN     "valuationAgeSeconds" INTEGER,
ADD COLUMN     "valuationConfidence" DOUBLE PRECISION,
ADD COLUMN     "valuationReason" TEXT,
ADD COLUMN     "valuationSource" TEXT,
ADD COLUMN     "valuationStatus" "ValuationStatus",
ADD COLUMN     "valuedUsd" DECIMAL(20,4);

-- CreateIndex
CREATE INDEX "money_flow_edges_valuationStatus_idx" ON "money_flow_edges"("valuationStatus");
