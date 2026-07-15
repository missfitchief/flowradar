-- Durable Alchemy Notify delivery receipts and chain-level subscription state.
CREATE TABLE "alchemy_webhook_receipts" (
    "id" TEXT NOT NULL,
    "webhookEventId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "providerCreatedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL,
    "normalizedEvents" INTEGER NOT NULL DEFAULT 0,
    "persistedEvents" INTEGER NOT NULL DEFAULT 0,
    "duplicateEvents" INTEGER NOT NULL DEFAULT 0,
    "eligibilityStatus" TEXT,
    "rejectionReason" TEXT,
    "trackerRunId" TEXT,
    "error" TEXT,
    "metadataJson" JSONB NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "alchemy_webhook_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "alchemy_webhook_subscription_states" (
    "chain" "ChainId" NOT NULL,
    "webhookId" TEXT,
    "network" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "desiredAddressCount" INTEGER NOT NULL DEFAULT 0,
    "remoteAddressCount" INTEGER,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "metadataJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "alchemy_webhook_subscription_states_pkey" PRIMARY KEY ("chain")
);

CREATE UNIQUE INDEX "alchemy_webhook_receipts_webhookEventId_key" ON "alchemy_webhook_receipts"("webhookEventId");
CREATE INDEX "alchemy_webhook_receipts_chain_receivedAt_idx" ON "alchemy_webhook_receipts"("chain", "receivedAt");
CREATE INDEX "alchemy_webhook_receipts_status_receivedAt_idx" ON "alchemy_webhook_receipts"("status", "receivedAt");
CREATE INDEX "alchemy_webhook_subscription_states_status_updatedAt_idx" ON "alchemy_webhook_subscription_states"("status", "updatedAt");
