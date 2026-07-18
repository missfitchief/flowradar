-- Additive: repeat_runner_candidates (dormancy Task 11, shadow-only,
-- observation-only — NEVER feeds FlowScore/signals/eligibility).
CREATE TABLE "repeat_runner_candidates" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "entityKey" TEXT NOT NULL,
    "memberWallets" TEXT[] NOT NULL DEFAULT '{}',
    "entityAdjusted" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "runnersEntered" INTEGER NOT NULL DEFAULT 0,
    "distinctRunnersEntered" INTEGER NOT NULL DEFAULT 0,
    "controlsEntered" INTEGER NOT NULL DEFAULT 0,
    "otherTokensEntered" INTEGER NOT NULL DEFAULT 0,
    "oneWinnerDependence" DOUBLE PRECISION,
    "behaviorQualityJson" JSONB,
    "negativeEvidenceJson" JSONB,
    "score" DOUBLE PRECISION,
    "scoreBasis" TEXT[] NOT NULL DEFAULT '{}',
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "receiptsJson" JSONB NOT NULL,
    "caveats" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repeat_runner_candidates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "repeat_runner_candidates_chain_entityKey_key" ON "repeat_runner_candidates"("chain", "entityKey");
CREATE INDEX "repeat_runner_candidates_status_idx" ON "repeat_runner_candidates"("status");
