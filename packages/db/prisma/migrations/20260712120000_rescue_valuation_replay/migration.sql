-- Additive: product-rescue sprint — honest trade valuation backfill columns,
-- Wallet DNA quality metrics, golden-cohort membership and no-lookahead
-- historical replay events. SHADOW-ONLY analytics.

-- Trade valuation backfill (mirrors money_flow_edges' Wave-A honest-valuation
-- pattern): valuedUsd NULL == unavailable; valuationSource labels the
-- hierarchy level used; backfill only ever touches rows whose legacy
-- amountUsd was 0-for-unpriced (reversal = re-zero where valuationSource set).
ALTER TABLE "wallet_token_trades" ADD COLUMN "valuedUsd" DECIMAL(24,4);
ALTER TABLE "wallet_token_trades" ADD COLUMN "valuationSource" TEXT;
ALTER TABLE "wallet_token_trades" ADD COLUMN "valuationConfidence" DOUBLE PRECISION;
CREATE INDEX "wallet_token_trades_valuationSource_idx" ON "wallet_token_trades"("valuationSource");

-- Wallet DNA quality metrics (all nullable — NULL == not mathematically
-- supported by the covered data, never fabricated).
ALTER TABLE "wallet_dna_profiles" ADD COLUMN "avgReturn" DOUBLE PRECISION;
ALTER TABLE "wallet_dna_profiles" ADD COLUMN "medianReturn" DOUBLE PRECISION;
ALTER TABLE "wallet_dna_profiles" ADD COLUMN "totalRealizedPnlUsd" DECIMAL(24,4);
ALTER TABLE "wallet_dna_profiles" ADD COLUMN "repeatRunnerCount" INTEGER;
ALTER TABLE "wallet_dna_profiles" ADD COLUMN "repeatRunnerRate" DOUBLE PRECISION;
ALTER TABLE "wallet_dna_profiles" ADD COLUMN "medianEntryMcapUsd" DECIMAL(24,4);
ALTER TABLE "wallet_dna_profiles" ADD COLUMN "fastDumpRate" DOUBLE PRECISION;
ALTER TABLE "wallet_dna_profiles" ADD COLUMN "deadRugExposureRate" DOUBLE PRECISION;

-- Golden cohort: deterministic product-validation selection with receipts.
CREATE TABLE "golden_cohort_members" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    -- token | wallet | control_token
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "selectionMetricsJson" JSONB NOT NULL,
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "selectedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "golden_cohort_members_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "golden_cohort_members_chain_kind_key_key" ON "golden_cohort_members"("chain", "kind", "key");
CREATE INDEX "golden_cohort_members_kind_idx" ON "golden_cohort_members"("kind");

-- No-lookahead historical replay events: what the system would have shown at
-- T (evidence strictly <= T), with the later outcome recorded SEPARATELY.
CREATE TABLE "replay_signal_events" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "mint" TEXT NOT NULL,
    -- runner | control
    "cohortKind" TEXT NOT NULL,
    "eventTs" TIMESTAMP(3) NOT NULL,
    -- signal | no_signal (the best evaluation point when nothing qualified)
    "eventKind" TEXT NOT NULL,
    "scoreAtEvent" DOUBLE PRECISION NOT NULL,
    "stateAtEvent" TEXT NOT NULL,
    "independentEntitiesAtEvent" INTEGER NOT NULL DEFAULT 0,
    "buyersAtEvent" INTEGER NOT NULL DEFAULT 0,
    "dormantReactivationsAtEvent" INTEGER NOT NULL DEFAULT 0,
    "fundedPathsAtEvent" INTEGER NOT NULL DEFAULT 0,
    "kolContaminationAtEvent" INTEGER NOT NULL DEFAULT 0,
    "evidenceAsOfJson" JSONB NOT NULL,
    "mcapAtSignalUsd" DECIMAL(24,4),
    "mcapH1Usd" DECIMAL(24,4),
    "mcapH6Usd" DECIMAL(24,4),
    "mcapH24Usd" DECIMAL(24,4),
    "mcapD3Usd" DECIMAL(24,4),
    "mcapD7Usd" DECIMAL(24,4),
    "maxLaterMcapUsd" DECIMAL(24,4),
    "maxDrawdownPct" DOUBLE PRECISION,
    -- true_positive | false_positive | miss | true_negative
    "classification" TEXT NOT NULL,
    "outcomeJson" JSONB NOT NULL,
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "caveats" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "replay_signal_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "replay_signal_events_chain_mint_eventKind_key" ON "replay_signal_events"("chain", "mint", "eventKind");
CREATE INDEX "replay_signal_events_classification_idx" ON "replay_signal_events"("classification");
CREATE INDEX "replay_signal_events_cohortKind_idx" ON "replay_signal_events"("cohortKind");
