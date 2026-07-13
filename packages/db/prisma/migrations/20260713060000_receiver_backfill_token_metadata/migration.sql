-- Additive: live-recovery sprint — receiver post-receipt backfill + token metadata.

CREATE TABLE "receiver_activity_backfills" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "receiverAddress" TEXT NOT NULL,
    "sourceEntityKey" TEXT NOT NULL,
    "sourceWallets" TEXT[] NOT NULL DEFAULT '{}',
    "firstReceiptTs" TIMESTAMP(3) NOT NULL,
    "backfillStart" TIMESTAMP(3) NOT NULL,
    "backfillEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "hasLiveWalletRow" BOOLEAN NOT NULL DEFAULT false,
    "postReceiptTxObserved" INTEGER NOT NULL DEFAULT 0,
    "postReceiptEdges" INTEGER NOT NULL DEFAULT 0,
    "firstActivityTs" TIMESTAMP(3),
    "firstBuyTs" TIMESTAMP(3),
    "firstBuyMint" TEXT,
    "fundingToBuyDelaySec" INTEGER,
    "boughtKnownUsd" DECIMAL(24,4),
    "entryMcapUsd" DECIMAL(24,4),
    "receiverClass" TEXT,
    "relationshipTier" TEXT,
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "receiptsJson" JSONB NOT NULL,
    "caveats" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "receiver_activity_backfills_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "receiver_activity_backfills_chain_receiverAddress_key" ON "receiver_activity_backfills"("chain", "receiverAddress");
CREATE INDEX "receiver_activity_backfills_status_idx" ON "receiver_activity_backfills"("status");

CREATE TABLE "token_metadata" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "mint" TEXT NOT NULL,
    "name" TEXT,
    "symbol" TEXT,
    "logoUri" TEXT,
    "source" TEXT NOT NULL,
    "availability" TEXT NOT NULL,
    "lastError" TEXT,
    "fetchedAt" TIMESTAMP(3),
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "token_metadata_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "token_metadata_chain_mint_key" ON "token_metadata"("chain", "mint");
CREATE INDEX "token_metadata_availability_idx" ON "token_metadata"("availability");
