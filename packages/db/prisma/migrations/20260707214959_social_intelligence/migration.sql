-- CreateTable
CREATE TABLE "social_sources" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalId" TEXT,
    "inviteLink" TEXT,
    "notes" TEXT,
    "trustTier" TEXT NOT NULL DEFAULT 'medium',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "chainSupport" "ChainId"[],
    "apiKeyEnvName" TEXT,
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 30,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadataJson" JSONB,

    CONSTRAINT "social_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_mentions" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalPostId" TEXT NOT NULL,
    "authorHash" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chain" "ChainId" NOT NULL,
    "contentSnippet" TEXT NOT NULL,
    "normalizedSnippet" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "mentionType" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "tokenSymbol" TEXT,
    "tokenUrl" TEXT,
    "tokenId" TEXT,
    "confidence" INTEGER NOT NULL,
    "spamScore" INTEGER NOT NULL DEFAULT 0,
    "spamReason" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "metadataJson" JSONB,

    CONSTRAINT "social_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_sources_name_key" ON "social_sources"("name");

-- CreateIndex
CREATE INDEX "social_mentions_tokenId_idx" ON "social_mentions"("tokenId");

-- CreateIndex
CREATE INDEX "social_mentions_chain_tokenAddress_idx" ON "social_mentions"("chain", "tokenAddress");

-- CreateIndex
CREATE INDEX "social_mentions_postedAt_idx" ON "social_mentions"("postedAt");

-- CreateIndex
CREATE INDEX "social_mentions_contentHash_idx" ON "social_mentions"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "social_mentions_sourceId_dedupeKey_key" ON "social_mentions"("sourceId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "social_mentions" ADD CONSTRAINT "social_mentions_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "social_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_mentions" ADD CONSTRAINT "social_mentions_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;
