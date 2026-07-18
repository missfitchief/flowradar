CREATE TYPE "IntelligenceSignalLevel" AS ENUM ('WATCH', 'STRONG_WATCH', 'HIGH_CONVICTION');

CREATE TABLE "intelligence_clusters" (
    "id" TEXT NOT NULL,
    "clusterKey" TEXT NOT NULL,
    "entityKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "confidence" DOUBLE PRECISION NOT NULL,
    "walletCount" INTEGER NOT NULL DEFAULT 0,
    "firstDiscoveredAt" TIMESTAMP(3) NOT NULL,
    "lastEvidenceAt" TIMESTAMP(3) NOT NULL,
    "evidenceJson" JSONB NOT NULL,
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "intelligence_clusters_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wallet_intelligence_profiles" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "address" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "entityKey" TEXT,
    "role" TEXT NOT NULL,
    "evidenceScore" DOUBLE PRECISION NOT NULL,
    "historicalAlphaScore" DOUBLE PRECISION NOT NULL,
    "wakeUpPotential" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "tier" TEXT NOT NULL,
    "discoverySource" TEXT NOT NULL,
    "lastDiscoverySource" TEXT NOT NULL,
    "firstDiscoveredAt" TIMESTAMP(3) NOT NULL,
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "lastActivityAt" TIMESTAMP(3),
    "monitoringPriority" "MonitoringPriority" NOT NULL,
    "reasonAdded" TEXT NOT NULL,
    "observationCount" INTEGER NOT NULL DEFAULT 0,
    "independentSignals" INTEGER NOT NULL DEFAULT 0,
    "evidenceSignals" TEXT[],
    "supportingEvidenceJson" JSONB NOT NULL,
    "contradictingEvidenceJson" JSONB NOT NULL,
    "scoreVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wallet_intelligence_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wallet_intelligence_observations" (
    "id" TEXT NOT NULL,
    "observationKey" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "investigationId" TEXT,
    "discoverySource" TEXT NOT NULL,
    "entityKey" TEXT,
    "role" TEXT NOT NULL,
    "evidenceScore" DOUBLE PRECISION NOT NULL,
    "historicalAlphaScore" DOUBLE PRECISION NOT NULL,
    "wakeUpPotential" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "previousConfidence" DOUBLE PRECISION,
    "confidenceDelta" DOUBLE PRECISION NOT NULL,
    "tier" TEXT NOT NULL,
    "independentSignals" INTEGER NOT NULL,
    "evidenceSignals" TEXT[],
    "supportingEvidenceJson" JSONB NOT NULL,
    "contradictingEvidenceJson" JSONB NOT NULL,
    "reasonJson" JSONB NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "scoreVersion" INTEGER NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wallet_intelligence_observations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intelligence_cluster_observations" (
    "id" TEXT NOT NULL,
    "observationKey" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "investigationId" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "walletCount" INTEGER NOT NULL,
    "supportingEvidenceJson" JSONB NOT NULL,
    "contradictingEvidenceJson" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "intelligence_cluster_observations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intelligence_cluster_merges" (
    "id" TEXT NOT NULL,
    "mergeKey" TEXT NOT NULL,
    "fromClusterId" TEXT NOT NULL,
    "intoClusterId" TEXT NOT NULL,
    "investigationId" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "evidenceJson" JSONB NOT NULL,
    "mergedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "intelligence_cluster_merges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wallet_intelligence_events" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "clusterKey" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "sourceEventId" TEXT,
    "txHash" TEXT,
    "counterpartyAddress" TEXT,
    "tokenAddress" TEXT,
    "amountUsd" DECIMAL(24,4),
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "evidenceJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wallet_intelligence_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "token_quality_assessments" (
    "id" TEXT NOT NULL,
    "assessmentKey" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "coverage" TEXT NOT NULL,
    "liquidityUsd" DECIMAL(24,4),
    "marketCapUsd" DECIMAL(24,4),
    "holderCount" INTEGER,
    "riskPenalty" DOUBLE PRECISION,
    "holderDistribution" TEXT NOT NULL,
    "deployerQuality" TEXT NOT NULL,
    "ownershipStatus" TEXT NOT NULL,
    "lpStatus" TEXT NOT NULL,
    "tradingBehavior" TEXT NOT NULL,
    "checksJson" JSONB NOT NULL,
    "reasonCodes" TEXT[],
    "assessedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "token_quality_assessments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intelligence_signals" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "level" "IntelligenceSignalLevel" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "activatedAt" TIMESTAMP(3) NOT NULL,
    "clusterKeys" TEXT[],
    "entityKeys" TEXT[],
    "walletAddresses" TEXT[],
    "sourceEventIds" TEXT[],
    "reasons" TEXT[],
    "evidenceJson" JSONB NOT NULL,
    "historySupportJson" JSONB NOT NULL,
    "explanation" TEXT NOT NULL,
    "qualityAssessmentId" TEXT,
    "engineVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "intelligence_signals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intelligence_buy_candidates" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "qualityAssessmentId" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasonCodes" TEXT[],
    "evidenceJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "intelligence_buy_candidates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intelligence_lifecycle_runs" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "sinceObservedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "profilesTracked" INTEGER NOT NULL DEFAULT 0,
    "eventsProcessed" INTEGER NOT NULL DEFAULT 0,
    "dormantAwakenings" INTEGER NOT NULL DEFAULT 0,
    "signalsCreated" INTEGER NOT NULL DEFAULT 0,
    "buyCandidatesCreated" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "metadataJson" JSONB NOT NULL,
    CONSTRAINT "intelligence_lifecycle_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "intelligence_clusters_clusterKey_key" ON "intelligence_clusters"("clusterKey");
CREATE INDEX "intelligence_clusters_entityKey_idx" ON "intelligence_clusters"("entityKey");
CREATE INDEX "intelligence_clusters_status_lastEvidenceAt_idx" ON "intelligence_clusters"("status", "lastEvidenceAt");
CREATE UNIQUE INDEX "wallet_intelligence_profiles_walletId_key" ON "wallet_intelligence_profiles"("walletId");
CREATE UNIQUE INDEX "wallet_intelligence_profiles_chain_address_key" ON "wallet_intelligence_profiles"("chain", "address");
CREATE INDEX "wallet_intelligence_profiles_clusterId_confidence_idx" ON "wallet_intelligence_profiles"("clusterId", "confidence");
CREATE INDEX "wallet_intelligence_profiles_monitoringPriority_lastObservedAt_idx" ON "wallet_intelligence_profiles"("monitoringPriority", "lastObservedAt");
CREATE INDEX "wallet_intelligence_profiles_tier_historicalAlphaScore_idx" ON "wallet_intelligence_profiles"("tier", "historicalAlphaScore");
CREATE UNIQUE INDEX "wallet_intelligence_observations_observationKey_key" ON "wallet_intelligence_observations"("observationKey");
CREATE INDEX "wallet_intelligence_observations_profileId_observedAt_idx" ON "wallet_intelligence_observations"("profileId", "observedAt");
CREATE INDEX "wallet_intelligence_observations_investigationId_idx" ON "wallet_intelligence_observations"("investigationId");
CREATE UNIQUE INDEX "intelligence_cluster_observations_observationKey_key" ON "intelligence_cluster_observations"("observationKey");
CREATE INDEX "intelligence_cluster_observations_clusterId_observedAt_idx" ON "intelligence_cluster_observations"("clusterId", "observedAt");
CREATE UNIQUE INDEX "intelligence_cluster_merges_mergeKey_key" ON "intelligence_cluster_merges"("mergeKey");
CREATE INDEX "intelligence_cluster_merges_fromClusterId_idx" ON "intelligence_cluster_merges"("fromClusterId");
CREATE INDEX "intelligence_cluster_merges_intoClusterId_idx" ON "intelligence_cluster_merges"("intoClusterId");
CREATE UNIQUE INDEX "wallet_intelligence_events_eventKey_key" ON "wallet_intelligence_events"("eventKey");
CREATE INDEX "wallet_intelligence_events_profileId_occurredAt_idx" ON "wallet_intelligence_events"("profileId", "occurredAt");
CREATE INDEX "wallet_intelligence_events_clusterKey_eventType_occurredAt_idx" ON "wallet_intelligence_events"("clusterKey", "eventType", "occurredAt");
CREATE INDEX "wallet_intelligence_events_chain_tokenAddress_occurredAt_idx" ON "wallet_intelligence_events"("chain", "tokenAddress", "occurredAt");
CREATE UNIQUE INDEX "token_quality_assessments_assessmentKey_key" ON "token_quality_assessments"("assessmentKey");
CREATE INDEX "token_quality_assessments_chain_tokenAddress_assessedAt_idx" ON "token_quality_assessments"("chain", "tokenAddress", "assessedAt");
CREATE INDEX "token_quality_assessments_passed_score_idx" ON "token_quality_assessments"("passed", "score");
CREATE UNIQUE INDEX "intelligence_signals_dedupeKey_key" ON "intelligence_signals"("dedupeKey");
CREATE INDEX "intelligence_signals_level_activatedAt_idx" ON "intelligence_signals"("level", "activatedAt");
CREATE INDEX "intelligence_signals_chain_tokenAddress_activatedAt_idx" ON "intelligence_signals"("chain", "tokenAddress", "activatedAt");
CREATE INDEX "intelligence_signals_clusterKeys_idx" ON "intelligence_signals"("clusterKeys");
CREATE UNIQUE INDEX "intelligence_buy_candidates_dedupeKey_key" ON "intelligence_buy_candidates"("dedupeKey");
CREATE UNIQUE INDEX "intelligence_buy_candidates_signalId_key" ON "intelligence_buy_candidates"("signalId");
CREATE INDEX "intelligence_buy_candidates_status_createdAt_idx" ON "intelligence_buy_candidates"("status", "createdAt");
CREATE INDEX "intelligence_buy_candidates_chain_tokenAddress_idx" ON "intelligence_buy_candidates"("chain", "tokenAddress");
CREATE INDEX "intelligence_lifecycle_runs_startedAt_idx" ON "intelligence_lifecycle_runs"("startedAt");
CREATE INDEX "intelligence_lifecycle_runs_status_idx" ON "intelligence_lifecycle_runs"("status");

ALTER TABLE "intelligence_clusters" ADD CONSTRAINT "intelligence_clusters_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "intelligence_clusters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "wallet_intelligence_profiles" ADD CONSTRAINT "wallet_intelligence_profiles_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wallet_intelligence_profiles" ADD CONSTRAINT "wallet_intelligence_profiles_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "intelligence_clusters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wallet_intelligence_observations" ADD CONSTRAINT "wallet_intelligence_observations_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "wallet_intelligence_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "intelligence_cluster_observations" ADD CONSTRAINT "intelligence_cluster_observations_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "intelligence_clusters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "intelligence_cluster_merges" ADD CONSTRAINT "intelligence_cluster_merges_fromClusterId_fkey" FOREIGN KEY ("fromClusterId") REFERENCES "intelligence_clusters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "intelligence_cluster_merges" ADD CONSTRAINT "intelligence_cluster_merges_intoClusterId_fkey" FOREIGN KEY ("intoClusterId") REFERENCES "intelligence_clusters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wallet_intelligence_events" ADD CONSTRAINT "wallet_intelligence_events_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "wallet_intelligence_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "intelligence_signals" ADD CONSTRAINT "intelligence_signals_qualityAssessmentId_fkey" FOREIGN KEY ("qualityAssessmentId") REFERENCES "token_quality_assessments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "intelligence_buy_candidates" ADD CONSTRAINT "intelligence_buy_candidates_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "intelligence_signals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "intelligence_buy_candidates" ADD CONSTRAINT "intelligence_buy_candidates_qualityAssessmentId_fkey" FOREIGN KEY ("qualityAssessmentId") REFERENCES "token_quality_assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
