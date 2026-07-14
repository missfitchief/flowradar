CREATE TABLE "core_wallet_seed_imports" (
  "id" TEXT NOT NULL,
  "importKey" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "policyVersion" INTEGER NOT NULL,
  "scoreThreshold" DOUBLE PRECISION NOT NULL,
  "sourceFiles" TEXT[] NOT NULL,
  "sourceHashes" TEXT[] NOT NULL,
  "totalRows" INTEGER NOT NULL,
  "candidateRows" INTEGER NOT NULL,
  "acceptedRows" INTEGER NOT NULL,
  "uniqueWallets" INTEGER NOT NULL,
  "rejectedRows" INTEGER NOT NULL,
  "duplicateRows" INTEGER NOT NULL,
  "profilesCreated" INTEGER NOT NULL DEFAULT 0,
  "profilesUpdated" INTEGER NOT NULL DEFAULT 0,
  "singletonClustersCreated" INTEGER NOT NULL DEFAULT 0,
  "monitoringEnrolled" INTEGER NOT NULL DEFAULT 0,
  "entitiesProjected" INTEGER NOT NULL DEFAULT 0,
  "guardrailJson" JSONB NOT NULL,
  "errorsJson" JSONB NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "core_wallet_seed_imports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core_wallet_seed_records" (
  "id" TEXT NOT NULL,
  "recordKey" TEXT NOT NULL,
  "importId" TEXT NOT NULL,
  "sourceFile" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "sourceSheet" TEXT,
  "sourceRow" INTEGER NOT NULL,
  "chain" "ChainId",
  "address" TEXT,
  "sourceScore" DOUBLE PRECISION,
  "sourceTier" TEXT,
  "sourceStatus" TEXT,
  "sourceLabel" TEXT,
  "sourceAddedAt" TIMESTAMP(3),
  "sourceLastActiveAt" TIMESTAMP(3),
  "rawJson" JSONB NOT NULL,
  "decision" TEXT NOT NULL,
  "reasonCodes" TEXT[] NOT NULL,
  "walletId" TEXT,
  "profileId" TEXT,
  "clusterId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "core_wallet_seed_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "core_wallet_seed_imports_importKey_key" ON "core_wallet_seed_imports"("importKey");
CREATE INDEX "core_wallet_seed_imports_status_startedAt_idx" ON "core_wallet_seed_imports"("status", "startedAt");
CREATE UNIQUE INDEX "core_wallet_seed_records_recordKey_key" ON "core_wallet_seed_records"("recordKey");
CREATE INDEX "core_wallet_seed_records_importId_decision_idx" ON "core_wallet_seed_records"("importId", "decision");
CREATE INDEX "core_wallet_seed_records_chain_address_idx" ON "core_wallet_seed_records"("chain", "address");
CREATE INDEX "core_wallet_seed_records_sourceScore_idx" ON "core_wallet_seed_records"("sourceScore");
ALTER TABLE "core_wallet_seed_records" ADD CONSTRAINT "core_wallet_seed_records_importId_fkey"
  FOREIGN KEY ("importId") REFERENCES "core_wallet_seed_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
