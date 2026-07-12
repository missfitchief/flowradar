-- Codex Batch-A review (minor): the dormancy tables' array receipt columns
-- must never be NULL — a NULL list would be a third state distinct from
-- 'empty', and every writer (Prisma scalar lists) always provides a value.
-- Defensive backfill first (expected 0 rows), then DEFAULT + NOT NULL.
-- Strictly additive: no data loss, no key/behavior change.

UPDATE "wallet_activity_classifications" SET "reasonCodes" = '{}' WHERE "reasonCodes" IS NULL;
ALTER TABLE "wallet_activity_classifications" ALTER COLUMN "reasonCodes" SET DEFAULT '{}';
ALTER TABLE "wallet_activity_classifications" ALTER COLUMN "reasonCodes" SET NOT NULL;

UPDATE "address_dormancy_observations" SET "caveats" = '{}' WHERE "caveats" IS NULL;
ALTER TABLE "address_dormancy_observations" ALTER COLUMN "caveats" SET DEFAULT '{}';
ALTER TABLE "address_dormancy_observations" ALTER COLUMN "caveats" SET NOT NULL;

UPDATE "entity_dormancy_observations" SET "reasonCodes" = '{}' WHERE "reasonCodes" IS NULL;
ALTER TABLE "entity_dormancy_observations" ALTER COLUMN "reasonCodes" SET DEFAULT '{}';
ALTER TABLE "entity_dormancy_observations" ALTER COLUMN "reasonCodes" SET NOT NULL;

UPDATE "entity_dormancy_observations" SET "caveats" = '{}' WHERE "caveats" IS NULL;
ALTER TABLE "entity_dormancy_observations" ALTER COLUMN "caveats" SET DEFAULT '{}';
ALTER TABLE "entity_dormancy_observations" ALTER COLUMN "caveats" SET NOT NULL;
