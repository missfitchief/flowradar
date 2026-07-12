-- Additive: post_entry_behaviors (dormancy Task 10, shadow-only).
CREATE TABLE "post_entry_behaviors" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "entryTs" TIMESTAMP(3) NOT NULL,
    "primaryClass" TEXT NOT NULL,
    "labels" TEXT[] NOT NULL DEFAULT '{}',
    "buyCount" INTEGER NOT NULL DEFAULT 0,
    "sellCount" INTEGER NOT NULL DEFAULT 0,
    "exitRatio" DOUBLE PRECISION,
    "timeToFirstSellSec" INTEGER,
    "fullExitSec" INTEGER,
    "outboundTokenTransfers" INTEGER NOT NULL DEFAULT 0,
    "outboundToLinked" INTEGER NOT NULL DEFAULT 0,
    "outboundToService" INTEGER NOT NULL DEFAULT 0,
    "outboundUnknown" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL,
    "dataComplete" BOOLEAN NOT NULL DEFAULT false,
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "receiptsJson" JSONB NOT NULL,
    "caveats" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_entry_behaviors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "post_entry_behaviors_chain_walletAddress_tokenAddress_key" ON "post_entry_behaviors"("chain", "walletAddress", "tokenAddress");
CREATE INDEX "post_entry_behaviors_primaryClass_idx" ON "post_entry_behaviors"("primaryClass");
CREATE INDEX "post_entry_behaviors_chain_walletAddress_idx" ON "post_entry_behaviors"("chain", "walletAddress");
