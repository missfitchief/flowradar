-- independentEntitiesOnToken: unknown must be NULL, never 0.
ALTER TABLE "capital_chains" ALTER COLUMN "independentEntitiesOnToken" DROP NOT NULL;
ALTER TABLE "capital_chains" ALTER COLUMN "independentEntitiesOnToken" DROP DEFAULT;
