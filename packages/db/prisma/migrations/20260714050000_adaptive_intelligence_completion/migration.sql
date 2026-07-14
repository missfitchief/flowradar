ALTER TYPE "IntelligenceSignalLevel" ADD VALUE IF NOT EXISTS 'OPPORTUNITY';

ALTER TABLE "intelligence_entities"
  ADD COLUMN "historicalTokenAddresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "strongestEvidenceJson" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "counterEvidenceJson" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "wallet_intelligence_profiles"
  ADD COLUMN "sourceScore" DOUBLE PRECISION,
  ADD COLUMN "rawHistoricalAlphaScore" DOUBLE PRECISION NOT NULL DEFAULT 35,
  ADD COLUMN "sampleAdjustedAlphaScore" DOUBLE PRECISION NOT NULL DEFAULT 35,
  ADD COLUMN "alphaConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "alphaSampleSize" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "alphaCalibrationJson" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "intelligenceStatus" TEXT NOT NULL DEFAULT 'inactive_low_value';

ALTER TABLE "wallet_intelligence_observations"
  ADD COLUMN "sourceScore" DOUBLE PRECISION,
  ADD COLUMN "rawHistoricalAlphaScore" DOUBLE PRECISION NOT NULL DEFAULT 35,
  ADD COLUMN "sampleAdjustedAlphaScore" DOUBLE PRECISION NOT NULL DEFAULT 35,
  ADD COLUMN "alphaConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "alphaSampleSize" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "alphaCalibrationJson" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "intelligenceStatus" TEXT NOT NULL DEFAULT 'inactive_low_value';

ALTER TABLE "intelligence_signals"
  ADD COLUMN "featureSnapshotJson" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "intelligence_model_versions"
  ADD COLUMN "approvedBy" TEXT,
  ADD COLUMN "supersededAt" TIMESTAMP(3);

ALTER TABLE "intelligence_weight_proposals"
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "approvedBy" TEXT;

UPDATE "wallet_intelligence_profiles"
SET "rawHistoricalAlphaScore" = "historicalAlphaScore",
    "sampleAdjustedAlphaScore" = "historicalAlphaScore",
    "alphaSampleSize" = GREATEST("observationCount", 0),
    "alphaConfidence" = CASE
      WHEN "observationCount" <= 0 THEN 0
      ELSE 1 - EXP(-"observationCount"::DOUBLE PRECISION / 18)
    END,
    "intelligenceStatus" = CASE
      WHEN "lastActivityAt" IS NOT NULL AND "lastActivityAt" < NOW() - INTERVAL '30 days' AND ("historicalAlphaScore" >= 45 OR "wakeUpPotential" >= 50) THEN 'dormant_high_value'
      WHEN "lastActivityAt" IS NOT NULL AND "lastActivityAt" < NOW() - INTERVAL '30 days' THEN 'dormant_alpha'
      WHEN "historicalAlphaScore" >= 45 THEN 'active_alpha'
      ELSE 'inactive_low_value'
    END;

UPDATE "wallet_intelligence_observations"
SET "rawHistoricalAlphaScore" = "historicalAlphaScore",
    "sampleAdjustedAlphaScore" = "historicalAlphaScore";

UPDATE "wallet_intelligence_profiles" p
SET "sourceScore" = seed.max_score
FROM (
  SELECT "profileId", MAX("sourceScore") AS max_score
  FROM "core_wallet_seed_records"
  WHERE "profileId" IS NOT NULL AND "sourceScore" IS NOT NULL
  GROUP BY "profileId"
) seed
WHERE p.id = seed."profileId";

UPDATE "wallet_intelligence_observations" o
SET "sourceScore" = p."sourceScore",
    "alphaConfidence" = p."alphaConfidence",
    "alphaSampleSize" = p."alphaSampleSize",
    "intelligenceStatus" = p."intelligenceStatus"
FROM "wallet_intelligence_profiles" p
WHERE o."profileId" = p.id;
