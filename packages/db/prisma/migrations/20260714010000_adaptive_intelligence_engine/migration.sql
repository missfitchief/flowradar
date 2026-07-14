ALTER TABLE "intelligence_signals"
  ADD COLUMN "lifecycleStage" TEXT NOT NULL DEFAULT 'WATCH',
  ADD COLUMN "entityIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "scoreDecompositionJson" JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN "entryMarketJson" JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN "rejectionReceiptJson" JSONB,
  ADD COLUMN "independentEntityCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "independentCapitalRootCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "coreWalletCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "peripheralWalletCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "outcomeStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "ruleVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "modelVersion" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "intelligence_entities" (
  "id" TEXT NOT NULL,
  "entityKey" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "identityConfidence" DOUBLE PRECISION NOT NULL,
  "currentRelevance" DOUBLE PRECISION NOT NULL,
  "historicalAlphaScore" DOUBLE PRECISION NOT NULL,
  "historicalAlphaConfidence" DOUBLE PRECISION NOT NULL,
  "wakeUpPotential" DOUBLE PRECISION NOT NULL,
  "evidenceFreshness" DOUBLE PRECISION NOT NULL,
  "monitoringPriority" "MonitoringPriority" NOT NULL,
  "chains" "ChainId"[] NOT NULL,
  "clusterKeys" TEXT[] NOT NULL,
  "coreWalletCount" INTEGER NOT NULL DEFAULT 0,
  "peripheralWalletCount" INTEGER NOT NULL DEFAULT 0,
  "tokenCount" INTEGER NOT NULL DEFAULT 0,
  "signalCount" INTEGER NOT NULL DEFAULT 0,
  "outcomeCount" INTEGER NOT NULL DEFAULT 0,
  "firstDiscoveredAt" TIMESTAMP(3) NOT NULL,
  "lastEvidenceAt" TIMESTAMP(3) NOT NULL,
  "lastCoreActivityAt" TIMESTAMP(3),
  "lastActivityAt" TIMESTAMP(3),
  "dormantSince" TIMESTAMP(3),
  "provenanceJson" JSONB NOT NULL,
  "currentVersion" INTEGER NOT NULL DEFAULT 1,
  "mergedIntoId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "intelligence_entities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intelligence_entity_memberships" (
  "id" TEXT NOT NULL,
  "membershipKey" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "evidenceScore" DOUBLE PRECISION NOT NULL,
  "identityConfidence" DOUBLE PRECISION NOT NULL,
  "currentRelevance" DOUBLE PRECISION NOT NULL,
  "evidenceFreshness" DOUBLE PRECISION NOT NULL,
  "independentSignalCount" INTEGER NOT NULL,
  "evidenceTypes" TEXT[] NOT NULL,
  "supportingEvidenceJson" JSONB NOT NULL,
  "contradictingEvidenceJson" JSONB NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL,
  "lastConfirmedAt" TIMESTAMP(3) NOT NULL,
  "lastObservedAt" TIMESTAMP(3) NOT NULL,
  "staleAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "intelligence_entity_memberships_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intelligence_entity_versions" (
  "id" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "cause" TEXT NOT NULL,
  "identityConfidence" DOUBLE PRECISION NOT NULL,
  "currentRelevance" DOUBLE PRECISION NOT NULL,
  "historicalAlphaScore" DOUBLE PRECISION NOT NULL,
  "historicalAlphaConfidence" DOUBLE PRECISION NOT NULL,
  "wakeUpPotential" DOUBLE PRECISION NOT NULL,
  "evidenceFreshness" DOUBLE PRECISION NOT NULL,
  "coreWalletRefs" TEXT[] NOT NULL,
  "peripheralWalletRefs" TEXT[] NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "provenanceJson" JSONB NOT NULL,
  "ruleVersion" INTEGER NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intelligence_entity_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intelligence_entity_decay_snapshots" (
  "id" TEXT NOT NULL,
  "snapshotKey" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "identityConfidence" DOUBLE PRECISION NOT NULL,
  "currentRelevance" DOUBLE PRECISION NOT NULL,
  "historicalAlphaScore" DOUBLE PRECISION NOT NULL,
  "wakeUpPotential" DOUBLE PRECISION NOT NULL,
  "evidenceFreshness" DOUBLE PRECISION NOT NULL,
  "previousJson" JSONB NOT NULL,
  "halfLivesJson" JSONB NOT NULL,
  "reasonCodes" TEXT[] NOT NULL,
  "policyVersion" INTEGER NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intelligence_entity_decay_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intelligence_entity_actions" (
  "id" TEXT NOT NULL,
  "actionKey" TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "sourceEntityIds" TEXT[] NOT NULL,
  "targetEntityIds" TEXT[] NOT NULL,
  "membershipIds" TEXT[] NOT NULL,
  "independentEvidenceTypes" TEXT[] NOT NULL,
  "beforeJson" JSONB NOT NULL,
  "afterJson" JSONB NOT NULL,
  "reasons" TEXT[] NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "rollbackJson" JSONB NOT NULL,
  "ruleVersion" INTEGER NOT NULL,
  "proposedAt" TIMESTAMP(3) NOT NULL,
  "appliedAt" TIMESTAMP(3),
  "rolledBackAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intelligence_entity_actions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intelligence_signal_outcomes" (
  "id" TEXT NOT NULL,
  "signalId" TEXT NOT NULL,
  "horizon" TEXT NOT NULL,
  "targetAt" TIMESTAMP(3) NOT NULL,
  "evaluatedAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL,
  "coverage" TEXT NOT NULL,
  "entryPriceUsd" DECIMAL(24,12),
  "referencePriceUsd" DECIMAL(24,12),
  "entryMarketCapUsd" DECIMAL(24,4),
  "referenceMarketCapUsd" DECIMAL(24,4),
  "realizedReturnPct" DOUBLE PRECISION,
  "maxReturnPct" DOUBLE PRECISION,
  "maxDrawdownPct" DOUBLE PRECISION,
  "timeToPeakMinutes" INTEGER,
  "liquidityRetentionPct" DOUBLE PRECISION,
  "volumeContinuation" TEXT NOT NULL,
  "holderContinuation" TEXT NOT NULL,
  "rugPullDetected" BOOLEAN NOT NULL DEFAULT false,
  "tradingHalted" BOOLEAN NOT NULL DEFAULT false,
  "lpRemoved" BOOLEAN NOT NULL DEFAULT false,
  "survivalStatus" TEXT NOT NULL,
  "earlyLateLabel" TEXT NOT NULL,
  "sourceSnapshotIds" TEXT[] NOT NULL,
  "receiptJson" JSONB NOT NULL,
  "evaluatorVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "intelligence_signal_outcomes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intelligence_signal_outcome_labels" (
  "id" TEXT NOT NULL,
  "signalId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "basisHorizon" TEXT NOT NULL,
  "rationale" TEXT[] NOT NULL,
  "metricsJson" JSONB NOT NULL,
  "labelVersion" INTEGER NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "intelligence_signal_outcome_labels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intelligence_model_versions" (
  "id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "weightsJson" JSONB NOT NULL,
  "thresholdsJson" JSONB NOT NULL,
  "trainingWindowJson" JSONB NOT NULL,
  "validationWindowJson" JSONB NOT NULL,
  "holdoutWindowJson" JSONB NOT NULL,
  "metricsJson" JSONB NOT NULL,
  "source" TEXT NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intelligence_model_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intelligence_weight_proposals" (
  "id" TEXT NOT NULL,
  "proposalKey" TEXT NOT NULL,
  "baseModelVersion" INTEGER NOT NULL,
  "candidateModelVersion" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "proposedWeightsJson" JSONB NOT NULL,
  "reasons" TEXT[] NOT NULL,
  "trainingMetricsJson" JSONB NOT NULL,
  "validationMetricsJson" JSONB NOT NULL,
  "holdoutMetricsJson" JSONB NOT NULL,
  "precisionDelta" DOUBLE PRECISION,
  "falsePositiveDelta" DOUBLE PRECISION,
  "sampleSize" INTEGER NOT NULL,
  "evaluatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intelligence_weight_proposals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intelligence_replay_runs" (
  "id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "trainingFrom" TIMESTAMP(3),
  "trainingTo" TIMESTAMP(3),
  "validationFrom" TIMESTAMP(3),
  "validationTo" TIMESTAMP(3),
  "holdoutFrom" TIMESTAMP(3),
  "holdoutTo" TIMESTAMP(3),
  "signalsConsidered" INTEGER NOT NULL DEFAULT 0,
  "signalsEvaluated" INTEGER NOT NULL DEFAULT 0,
  "noLookaheadViolations" INTEGER NOT NULL DEFAULT 0,
  "modelVersion" INTEGER NOT NULL,
  "ruleVersion" INTEGER NOT NULL,
  "metricsJson" JSONB NOT NULL,
  "dataQualityJson" JSONB NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intelligence_replay_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intelligence_backfill_runs" (
  "id" TEXT NOT NULL,
  "backfillType" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "cursorJson" JSONB NOT NULL,
  "scannedCount" INTEGER NOT NULL DEFAULT 0,
  "createdCount" INTEGER NOT NULL DEFAULT 0,
  "updatedCount" INTEGER NOT NULL DEFAULT 0,
  "unknownCount" INTEGER NOT NULL DEFAULT 0,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "errorsJson" JSONB NOT NULL,
  "ruleVersion" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intelligence_backfill_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "intelligence_entities_entityKey_key" ON "intelligence_entities"("entityKey");
CREATE INDEX "intelligence_entities_status_monitoringPriority_idx" ON "intelligence_entities"("status", "monitoringPriority");
CREATE INDEX "intelligence_entities_historicalAlphaScore_identityConfidence_idx" ON "intelligence_entities"("historicalAlphaScore", "identityConfidence");
CREATE INDEX "intelligence_entities_lastCoreActivityAt_idx" ON "intelligence_entities"("lastCoreActivityAt");
CREATE UNIQUE INDEX "intelligence_entity_memberships_membershipKey_key" ON "intelligence_entity_memberships"("membershipKey");
CREATE UNIQUE INDEX "intelligence_entity_memberships_entityId_profileId_key" ON "intelligence_entity_memberships"("entityId", "profileId");
CREATE INDEX "intelligence_entity_memberships_profileId_status_idx" ON "intelligence_entity_memberships"("profileId", "status");
CREATE INDEX "intelligence_entity_memberships_entityId_scope_status_idx" ON "intelligence_entity_memberships"("entityId", "scope", "status");
CREATE INDEX "intelligence_entity_memberships_identityConfidence_evidenceFreshness_idx" ON "intelligence_entity_memberships"("identityConfidence", "evidenceFreshness");
CREATE UNIQUE INDEX "intelligence_entity_versions_entityId_version_key" ON "intelligence_entity_versions"("entityId", "version");
CREATE INDEX "intelligence_entity_versions_entityId_observedAt_idx" ON "intelligence_entity_versions"("entityId", "observedAt");
CREATE UNIQUE INDEX "intelligence_entity_decay_snapshots_snapshotKey_key" ON "intelligence_entity_decay_snapshots"("snapshotKey");
CREATE INDEX "intelligence_entity_decay_snapshots_entityId_computedAt_idx" ON "intelligence_entity_decay_snapshots"("entityId", "computedAt");
CREATE UNIQUE INDEX "intelligence_entity_actions_actionKey_key" ON "intelligence_entity_actions"("actionKey");
CREATE INDEX "intelligence_entity_actions_actionType_status_proposedAt_idx" ON "intelligence_entity_actions"("actionType", "status", "proposedAt");
CREATE INDEX "intelligence_entity_actions_sourceEntityIds_idx" ON "intelligence_entity_actions"("sourceEntityIds");
CREATE UNIQUE INDEX "intelligence_signal_outcomes_signalId_horizon_key" ON "intelligence_signal_outcomes"("signalId", "horizon");
CREATE INDEX "intelligence_signal_outcomes_horizon_status_evaluatedAt_idx" ON "intelligence_signal_outcomes"("horizon", "status", "evaluatedAt");
CREATE INDEX "intelligence_signal_outcomes_signalId_targetAt_idx" ON "intelligence_signal_outcomes"("signalId", "targetAt");
CREATE UNIQUE INDEX "intelligence_signal_outcome_labels_signalId_key" ON "intelligence_signal_outcome_labels"("signalId");
CREATE INDEX "intelligence_signal_outcome_labels_label_computedAt_idx" ON "intelligence_signal_outcome_labels"("label", "computedAt");
CREATE UNIQUE INDEX "intelligence_model_versions_version_key" ON "intelligence_model_versions"("version");
CREATE INDEX "intelligence_model_versions_status_version_idx" ON "intelligence_model_versions"("status", "version");
CREATE UNIQUE INDEX "intelligence_weight_proposals_proposalKey_key" ON "intelligence_weight_proposals"("proposalKey");
CREATE INDEX "intelligence_weight_proposals_status_createdAt_idx" ON "intelligence_weight_proposals"("status", "createdAt");
CREATE INDEX "intelligence_replay_runs_status_startedAt_idx" ON "intelligence_replay_runs"("status", "startedAt");
CREATE INDEX "intelligence_backfill_runs_backfillType_status_startedAt_idx" ON "intelligence_backfill_runs"("backfillType", "status", "startedAt");

ALTER TABLE "intelligence_entities" ADD CONSTRAINT "intelligence_entities_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "intelligence_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "intelligence_entity_memberships" ADD CONSTRAINT "intelligence_entity_memberships_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "intelligence_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "intelligence_entity_memberships" ADD CONSTRAINT "intelligence_entity_memberships_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "wallet_intelligence_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "intelligence_entity_versions" ADD CONSTRAINT "intelligence_entity_versions_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "intelligence_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "intelligence_entity_decay_snapshots" ADD CONSTRAINT "intelligence_entity_decay_snapshots_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "intelligence_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "intelligence_signal_outcomes" ADD CONSTRAINT "intelligence_signal_outcomes_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "intelligence_signals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "intelligence_signal_outcome_labels" ADD CONSTRAINT "intelligence_signal_outcome_labels_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "intelligence_signals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
