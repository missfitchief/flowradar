-- CreateTable
CREATE TABLE "external_confluence_sources" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "apiKeyEnvName" TEXT,
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 30,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "metadataJson" JSONB,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_confluence_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_confluence_snapshots" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT,
    "chain" "ChainId" NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "sourceId" TEXT,
    "provider" TEXT NOT NULL,
    "snapshotType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dataJson" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupeKey" TEXT NOT NULL,
    "metadataJson" JSONB,

    CONSTRAINT "token_confluence_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "external_confluence_sources_name_key" ON "external_confluence_sources"("name");

-- CreateIndex
CREATE INDEX "token_confluence_snapshots_tokenId_idx" ON "token_confluence_snapshots"("tokenId");

-- CreateIndex
CREATE INDEX "token_confluence_snapshots_chain_tokenAddress_idx" ON "token_confluence_snapshots"("chain", "tokenAddress");

-- CreateIndex
CREATE INDEX "token_confluence_snapshots_provider_snapshotType_idx" ON "token_confluence_snapshots"("provider", "snapshotType");

-- CreateIndex
CREATE INDEX "token_confluence_snapshots_observedAt_idx" ON "token_confluence_snapshots"("observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "token_confluence_snapshots_sourceId_tokenAddress_snapshotTy_key" ON "token_confluence_snapshots"("sourceId", "tokenAddress", "snapshotType", "dedupeKey");

-- AddForeignKey
ALTER TABLE "token_confluence_snapshots" ADD CONSTRAINT "token_confluence_snapshots_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_confluence_snapshots" ADD CONSTRAINT "token_confluence_snapshots_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "external_confluence_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
