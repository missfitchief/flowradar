-- Additive: dormant_runner_candidates (dormancy Task 12, shadow-only,
-- observation-only — NEVER feeds FlowScore/signals/eligibility).
CREATE TABLE "dormant_runner_candidates" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "entityKey" TEXT NOT NULL,
    "memberWallets" TEXT[] NOT NULL DEFAULT '{}',
    "pattern" TEXT NOT NULL,
    "dormantEntryEvents" INTEGER NOT NULL DEFAULT 0,
    "sideWalletActivationEvents" INTEGER NOT NULL DEFAULT 0,
    "freshFundingEvents" INTEGER NOT NULL DEFAULT 0,
    "distinctRunnerTokens" INTEGER NOT NULL DEFAULT 0,
    "eventsJson" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "receiptsJson" JSONB NOT NULL,
    "caveats" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dormant_runner_candidates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dormant_runner_candidates_chain_entityKey_key" ON "dormant_runner_candidates"("chain", "entityKey");
CREATE INDEX "dormant_runner_candidates_pattern_idx" ON "dormant_runner_candidates"("pattern");
