ALTER TYPE "ChainId" ADD VALUE IF NOT EXISTS 'ETHEREUM';
ALTER TYPE "ChainId" ADD VALUE IF NOT EXISTS 'BASE';
ALTER TYPE "ChainId" ADD VALUE IF NOT EXISTS 'ARBITRUM';

ALTER TABLE "top_pnl_fetch_states" ADD COLUMN "chain" "ChainId" NOT NULL DEFAULT 'SOLANA';
DROP INDEX IF EXISTS "top_pnl_fetch_states_mint_provider_key";
CREATE UNIQUE INDEX "top_pnl_fetch_states_chain_mint_provider_key"
  ON "top_pnl_fetch_states"("chain", "mint", "provider");

CREATE TABLE "historical_token_universe" (
  "id" TEXT NOT NULL,
  "chain" "ChainId" NOT NULL,
  "tokenAddress" TEXT NOT NULL,
  "sources" TEXT[] NOT NULL,
  "historicalWinnerStatus" TEXT NOT NULL,
  "athMcapUsd" DECIMAL(24,4),
  "athTs" TIMESTAMP(3),
  "coverage" TEXT NOT NULL,
  "processingStatus" TEXT NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "nextRetryAt" TIMESTAMP(3),
  "lastProcessedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "historical_token_universe_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "historical_token_universe_chain_tokenAddress_key" ON "historical_token_universe"("chain", "tokenAddress");
CREATE INDEX "historical_token_universe_historicalWinnerStatus_processingStatus_idx" ON "historical_token_universe"("historicalWinnerStatus", "processingStatus");
CREATE INDEX "historical_token_universe_chain_processingStatus_idx" ON "historical_token_universe"("chain", "processingStatus");

CREATE TABLE "profitable_wallet_discovery_runs" (
  "id" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "universeConsidered" INTEGER NOT NULL DEFAULT 0,
  "tokensProcessed" INTEGER NOT NULL DEFAULT 0,
  "tokensPartial" INTEGER NOT NULL DEFAULT 0,
  "tokensUnavailable" INTEGER NOT NULL DEFAULT 0,
  "localCandidates" INTEGER NOT NULL DEFAULT 0,
  "providerCandidates" INTEGER NOT NULL DEFAULT 0,
  "walletsObserved" INTEGER NOT NULL DEFAULT 0,
  "retryableFailures" INTEGER NOT NULL DEFAULT 0,
  "peakHeapBytes" BIGINT NOT NULL DEFAULT 0,
  "throughputPerSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "error" TEXT,
  "metadataJson" JSONB NOT NULL,
  CONSTRAINT "profitable_wallet_discovery_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "profitable_wallet_discovery_runs_startedAt_idx" ON "profitable_wallet_discovery_runs"("startedAt");
CREATE INDEX "profitable_wallet_discovery_runs_status_idx" ON "profitable_wallet_discovery_runs"("status");

CREATE TABLE "unified_entities" (
  "id" TEXT NOT NULL,
  "entityKey" TEXT NOT NULL,
  "chains" "ChainId"[] NOT NULL,
  "memberCount" INTEGER NOT NULL DEFAULT 0,
  "confidence" DOUBLE PRECISION NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "caveats" TEXT[] NOT NULL,
  "engineVersion" INTEGER NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "unified_entities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unified_entities_entityKey_key" ON "unified_entities"("entityKey");
CREATE INDEX "unified_entities_memberCount_idx" ON "unified_entities"("memberCount");

CREATE TABLE "unified_entity_addresses" (
  "id" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "chain" "ChainId" NOT NULL,
  "address" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "evidenceTier" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "observationOnly" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "unified_entity_addresses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unified_entity_addresses_chain_address_key" ON "unified_entity_addresses"("chain", "address");
CREATE INDEX "unified_entity_addresses_entityId_role_idx" ON "unified_entity_addresses"("entityId", "role");
ALTER TABLE "unified_entity_addresses" ADD CONSTRAINT "unified_entity_addresses_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "unified_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "operator_watches" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetKey" TEXT NOT NULL,
  "chain" "ChainId",
  "alertTypes" TEXT[] NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "operator_watches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "operator_watches_userId_chatId_targetType_targetKey_key" ON "operator_watches"("userId", "chatId", "targetType", "targetKey");
CREATE INDEX "operator_watches_active_updatedAt_idx" ON "operator_watches"("active", "updatedAt");

CREATE TABLE "operator_watch_alerts" (
  "id" TEXT NOT NULL,
  "watchId" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "alertType" TEXT NOT NULL,
  "payloadJson" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),
  "lastError" TEXT,
  CONSTRAINT "operator_watch_alerts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "operator_watch_alerts_watchId_eventKey_alertType_key" ON "operator_watch_alerts"("watchId", "eventKey", "alertType");
CREATE INDEX "operator_watch_alerts_status_createdAt_idx" ON "operator_watch_alerts"("status", "createdAt");
ALTER TABLE "operator_watch_alerts" ADD CONSTRAINT "operator_watch_alerts_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "operator_watches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "operator_sessions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "workflow" TEXT NOT NULL,
  "stateJson" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "operator_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "operator_sessions_userId_expiresAt_idx" ON "operator_sessions"("userId", "expiresAt");

CREATE TABLE "telegram_bot_cursors" (
  "botKey" TEXT NOT NULL,
  "nextUpdateId" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "telegram_bot_cursors_pkey" PRIMARY KEY ("botKey")
);
