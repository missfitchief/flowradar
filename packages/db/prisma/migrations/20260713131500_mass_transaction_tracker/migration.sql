CREATE TABLE "mass_transaction_events" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "chain" "ChainId" NOT NULL,
  "txHash" TEXT NOT NULL,
  "eventIndex" INTEGER NOT NULL,
  "blockOrSlot" BIGINT NOT NULL,
  "ts" TIMESTAMP(3) NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "fromAddress" TEXT NOT NULL,
  "toAddress" TEXT NOT NULL,
  "assetAddress" TEXT,
  "assetSymbol" TEXT,
  "assetDecimals" INTEGER,
  "amountToken" TEXT NOT NULL,
  "amountUsd" DECIMAL(24,4),
  "programOrContract" TEXT,
  "provider" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "bridgeProtocol" TEXT,
  "officialMessageId" TEXT,
  "bridgeJson" JSONB,
  "relevanceCategory" TEXT NOT NULL,
  "relevanceScore" DOUBLE PRECISION NOT NULL,
  "reasonCodes" TEXT[] NOT NULL,
  "safeEntityLink" BOOLEAN NOT NULL DEFAULT false,
  "enrollmentCandidate" BOOLEAN NOT NULL DEFAULT false,
  "sourceEntityKey" TEXT,
  "sourceRole" TEXT,
  "metadataJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mass_transaction_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mass_transaction_events_eventId_key" ON "mass_transaction_events"("eventId");
CREATE UNIQUE INDEX "mass_transaction_events_chain_txHash_eventIndex_key" ON "mass_transaction_events"("chain", "txHash", "eventIndex");
CREATE INDEX "mass_transaction_events_fromAddress_ts_idx" ON "mass_transaction_events"("fromAddress", "ts");
CREATE INDEX "mass_transaction_events_toAddress_ts_idx" ON "mass_transaction_events"("toAddress", "ts");
CREATE INDEX "mass_transaction_events_officialMessageId_idx" ON "mass_transaction_events"("officialMessageId");
CREATE INDEX "mass_transaction_events_sourceEntityKey_ts_idx" ON "mass_transaction_events"("sourceEntityKey", "ts");
CREATE INDEX "mass_transaction_events_relevanceCategory_ts_idx" ON "mass_transaction_events"("relevanceCategory", "ts");

CREATE TABLE "mass_bridge_correlations" (
  "id" TEXT NOT NULL,
  "correlationId" TEXT NOT NULL,
  "protocol" TEXT NOT NULL,
  "officialMessageId" TEXT,
  "sourceEventId" TEXT NOT NULL,
  "destinationEventId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "reasonCodes" TEXT[] NOT NULL,
  "correlatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mass_bridge_correlations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mass_bridge_correlations_correlationId_key" ON "mass_bridge_correlations"("correlationId");
CREATE UNIQUE INDEX "mass_bridge_correlations_sourceEventId_destinationEventId_key" ON "mass_bridge_correlations"("sourceEventId", "destinationEventId");
CREATE INDEX "mass_bridge_correlations_officialMessageId_idx" ON "mass_bridge_correlations"("officialMessageId");
CREATE INDEX "mass_bridge_correlations_status_idx" ON "mass_bridge_correlations"("status");

CREATE TABLE "mass_tracker_traces" (
  "id" TEXT NOT NULL,
  "traceId" TEXT NOT NULL,
  "sourceEntityKey" TEXT NOT NULL,
  "sourceRole" TEXT NOT NULL,
  "sourceWallet" TEXT NOT NULL,
  "terminalWallet" TEXT NOT NULL,
  "tokenBought" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "eventIds" TEXT[] NOT NULL,
  "bridgeCorrelationIds" TEXT[] NOT NULL,
  "fundingToBuyDelaySec" INTEGER NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "reasonCodes" TEXT[] NOT NULL,
  "grantsEligibility" BOOLEAN NOT NULL DEFAULT false,
  "computedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mass_tracker_traces_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mass_tracker_traces_traceId_key" ON "mass_tracker_traces"("traceId");
CREATE INDEX "mass_tracker_traces_sourceEntityKey_computedAt_idx" ON "mass_tracker_traces"("sourceEntityKey", "computedAt");
CREATE INDEX "mass_tracker_traces_tokenBought_computedAt_idx" ON "mass_tracker_traces"("tokenBought", "computedAt");

CREATE TABLE "mass_tracker_runs" (
  "id" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "inputEvents" INTEGER NOT NULL DEFAULT 0,
  "persistedEvents" INTEGER NOT NULL DEFAULT 0,
  "duplicateEvents" INTEGER NOT NULL DEFAULT 0,
  "relevantEvents" INTEGER NOT NULL DEFAULT 0,
  "receiversEnrolled" INTEGER NOT NULL DEFAULT 0,
  "bridgePairsVerified" INTEGER NOT NULL DEFAULT 0,
  "tracesBuilt" INTEGER NOT NULL DEFAULT 0,
  "batches" INTEGER NOT NULL DEFAULT 0,
  "retryAttempts" INTEGER NOT NULL DEFAULT 0,
  "providerErrors" INTEGER NOT NULL DEFAULT 0,
  "peakHeapBytes" BIGINT NOT NULL DEFAULT 0,
  "throughputPerSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "error" TEXT,
  "metadataJson" JSONB NOT NULL,
  CONSTRAINT "mass_tracker_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "mass_tracker_runs_startedAt_idx" ON "mass_tracker_runs"("startedAt");
CREATE INDEX "mass_tracker_runs_status_idx" ON "mass_tracker_runs"("status");
