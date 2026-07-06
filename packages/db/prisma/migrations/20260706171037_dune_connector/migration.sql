-- CreateEnum
CREATE TYPE "DuneQueryPurpose" AS ENUM ('token_overlap', 'token_traders', 'smart_wallet_candidates', 'funding_links', 'entity_cluster_research');

-- CreateEnum
CREATE TYPE "DuneResultFormat" AS ENUM ('json', 'csv');

-- CreateEnum
CREATE TYPE "TokenOverlapSearchStatus" AS ENUM ('queued', 'running', 'done', 'failed');

-- CreateTable
CREATE TABLE "dune_query_sources" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "purpose" "DuneQueryPurpose" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "resultFormat" "DuneResultFormat" NOT NULL DEFAULT 'json',
    "lastExecutionId" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'idle',
    "creditsEstimate" INTEGER,
    "parametersJson" JSONB,
    "outputSchemaJson" JSONB,
    "notes" TEXT,

    CONSTRAINT "dune_query_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_overlap_searches" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "tokenAddresses" TEXT[],
    "params" JSONB NOT NULL,
    "status" "TokenOverlapSearchStatus" NOT NULL DEFAULT 'queued',
    "rowsReturned" INTEGER,
    "usedCachedResult" BOOLEAN,
    "truncated" BOOLEAN,
    "executionId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_overlap_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_overlap_wallet_results" (
    "id" TEXT NOT NULL,
    "searchId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "tokensOverlapCount" INTEGER NOT NULL,
    "totalBuyUsd" DECIMAL(20,4),
    "totalSellUsd" DECIMAL(20,4),
    "estimatedPnlUsd" DECIMAL(20,4),
    "firstBuyTime" TIMESTAMP(3),
    "buyCount" INTEGER,
    "sellCount" INTEGER,
    "entryMarketCapUsd" DECIMAL(20,4),
    "overlapGroupId" TEXT,
    "txHashesSample" TEXT[],

    CONSTRAINT "token_overlap_wallet_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_overlap_group_results" (
    "id" TEXT NOT NULL,
    "searchId" TEXT NOT NULL,
    "overlapGroupId" TEXT NOT NULL,
    "walletCount" INTEGER NOT NULL,
    "walletAddresses" TEXT[],
    "sharedTokenCount" INTEGER NOT NULL,

    CONSTRAINT "token_overlap_group_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dune_query_sources_name_key" ON "dune_query_sources"("name");

-- CreateIndex
CREATE INDEX "token_overlap_searches_status_idx" ON "token_overlap_searches"("status");

-- CreateIndex
CREATE INDEX "token_overlap_wallet_results_searchId_idx" ON "token_overlap_wallet_results"("searchId");

-- CreateIndex
CREATE INDEX "token_overlap_group_results_searchId_idx" ON "token_overlap_group_results"("searchId");

-- AddForeignKey
ALTER TABLE "token_overlap_wallet_results" ADD CONSTRAINT "token_overlap_wallet_results_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "token_overlap_searches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_overlap_group_results" ADD CONSTRAINT "token_overlap_group_results_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "token_overlap_searches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
