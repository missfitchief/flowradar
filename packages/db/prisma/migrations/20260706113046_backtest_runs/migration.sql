-- CreateTable
CREATE TABLE "backtest_runs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "syntheticEvidence" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "backtest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backtest_runs_kind_startedAt_idx" ON "backtest_runs"("kind", "startedAt");
