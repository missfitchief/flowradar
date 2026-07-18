-- Production operations telemetry only. None of these tables feed scoring,
-- entity membership, signal eligibility, or alert policy.
CREATE TABLE "provider_health_events" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "chain" "ChainId",
  "capability" TEXT NOT NULL,
  "scope" TEXT,
  "outcome" TEXT NOT NULL,
  "latencyMs" INTEGER NOT NULL,
  "rateLimited" BOOLEAN NOT NULL DEFAULT false,
  "timedOut" BOOLEAN NOT NULL DEFAULT false,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_health_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "provider_cursor_checkpoints" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "chain" "ChainId" NOT NULL,
  "scope" TEXT NOT NULL,
  "previousCursor" TEXT,
  "nextCursor" TEXT,
  "decision" TEXT NOT NULL,
  "eventCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_cursor_checkpoints_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "runtime_heartbeats" (
  "component" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "pid" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "heartbeatAt" TIMESTAMP(3) NOT NULL,
  "lastSuccessAt" TIMESTAMP(3),
  "lastError" TEXT,
  "metadataJson" JSONB NOT NULL,
  CONSTRAINT "runtime_heartbeats_pkey" PRIMARY KEY ("component")
);

CREATE TABLE "production_integrity_runs" (
  "id" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "warningCount" INTEGER NOT NULL DEFAULT 0,
  "checksJson" JSONB NOT NULL,
  CONSTRAINT "production_integrity_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "provider_health_events_provider_occurredAt_idx" ON "provider_health_events"("provider", "occurredAt");
CREATE INDEX "provider_health_events_outcome_occurredAt_idx" ON "provider_health_events"("outcome", "occurredAt");
CREATE INDEX "provider_health_events_chain_capability_occurredAt_idx" ON "provider_health_events"("chain", "capability", "occurredAt");
CREATE INDEX "provider_cursor_checkpoints_provider_chain_scope_createdAt_idx" ON "provider_cursor_checkpoints"("provider", "chain", "scope", "createdAt");
CREATE INDEX "provider_cursor_checkpoints_decision_createdAt_idx" ON "provider_cursor_checkpoints"("decision", "createdAt");
CREATE INDEX "runtime_heartbeats_status_heartbeatAt_idx" ON "runtime_heartbeats"("status", "heartbeatAt");
CREATE INDEX "production_integrity_runs_startedAt_idx" ON "production_integrity_runs"("startedAt");
CREATE INDEX "production_integrity_runs_status_startedAt_idx" ON "production_integrity_runs"("status", "startedAt");
