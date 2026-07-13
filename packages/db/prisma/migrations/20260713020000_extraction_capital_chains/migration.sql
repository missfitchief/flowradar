-- Additive: finish-pipeline sprint — per-token top-PnL extraction status +
-- real capital chains (staging / deployment / profit rotation).

CREATE TABLE "top_pnl_extraction_status" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "mint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "hasTokenRow" BOOLEAN NOT NULL DEFAULT false,
    "hasLocalTrades" BOOLEAN NOT NULL DEFAULT false,
    "walletCount" INTEGER NOT NULL DEFAULT 0,
    "locallyVerified" INTEGER NOT NULL DEFAULT 0,
    "providerOnly" INTEGER NOT NULL DEFAULT 0,
    "incomplete" INTEGER NOT NULL DEFAULT 0,
    "providerFetchState" TEXT,
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "receiptsJson" JSONB NOT NULL,
    "engineVersion" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "top_pnl_extraction_status_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "top_pnl_extraction_status_chain_mint_key" ON "top_pnl_extraction_status"("chain", "mint");
CREATE INDEX "top_pnl_extraction_status_status_idx" ON "top_pnl_extraction_status"("status");

CREATE TABLE "capital_chains" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceEntityKey" TEXT NOT NULL,
    "sourceWallet" TEXT NOT NULL,
    "receiverWallet" TEXT,
    "route" TEXT NOT NULL,
    "evidenceTier" TEXT NOT NULL,
    "knownValueUsd" DECIMAL(24,4),
    "fundingTs" TIMESTAMP(3),
    "tokenBought" TEXT,
    "tokenBoughtSymbol" TEXT,
    "entryMcapUsd" DECIMAL(24,4),
    "fundingToBuyDelaySec" INTEGER,
    "sourceToken" TEXT,
    "realizedProfitUsd" DECIMAL(24,4),
    "receiverClass" TEXT,
    "relationshipTier" TEXT,
    "independentEntitiesOnToken" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "receiptsJson" JSONB NOT NULL,
    "caveats" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "capital_chains_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "capital_chains_dedupeKey_key" ON "capital_chains"("dedupeKey");
CREATE INDEX "capital_chains_kind_idx" ON "capital_chains"("kind");
CREATE INDEX "capital_chains_tokenBought_idx" ON "capital_chains"("tokenBought");
CREATE INDEX "capital_chains_sourceEntityKey_idx" ON "capital_chains"("sourceEntityKey");
