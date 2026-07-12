-- Additive: working-loop milestone — capital outflow paths (direct/multi-hop/
-- bridge/CEX evidence tiers), receiver enrollments (observation_only) and
-- automatic token-candidate scores (SHADOW ranking, never FlowScore).

CREATE TABLE "capital_outflow_paths" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "sourceWallet" TEXT NOT NULL,
    "sourceEntityKey" TEXT NOT NULL,
    "destinationAddress" TEXT NOT NULL,
    "destinationType" TEXT NOT NULL,
    "evidenceTier" TEXT NOT NULL,
    "hops" INTEGER NOT NULL,
    "transferCount" INTEGER NOT NULL DEFAULT 0,
    "knownValueUsd" DECIMAL(24,4),
    "unknownValueLegs" INTEGER NOT NULL DEFAULT 0,
    "firstTransferTs" TIMESTAMP(3) NOT NULL,
    "lastTransferTs" TIMESTAMP(3) NOT NULL,
    "bridgeProtocol" TEXT,
    "receiverRelationshipTier" TEXT,
    "receiverClassAtReceipt" TEXT NOT NULL,
    "pathJson" JSONB NOT NULL,
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "receiptsJson" JSONB NOT NULL,
    "caveats" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capital_outflow_paths_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "capital_outflow_paths_chain_sourceWallet_destinationAddres_key" ON "capital_outflow_paths"("chain", "sourceWallet", "destinationAddress", "evidenceTier");
CREATE INDEX "capital_outflow_paths_destinationAddress_idx" ON "capital_outflow_paths"("destinationAddress");
CREATE INDEX "capital_outflow_paths_sourceEntityKey_idx" ON "capital_outflow_paths"("sourceEntityKey");
CREATE INDEX "capital_outflow_paths_evidenceTier_idx" ON "capital_outflow_paths"("evidenceTier");

CREATE TABLE "receiver_enrollments" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "receiverAddress" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'observation_only',
    "receiverClass" TEXT NOT NULL,
    "sourceEntityKeys" TEXT[] NOT NULL DEFAULT '{}',
    "sourceWallets" TEXT[] NOT NULL DEFAULT '{}',
    "evidenceTiers" TEXT[] NOT NULL DEFAULT '{}',
    "firstReceiptTs" TIMESTAMP(3) NOT NULL,
    "totalKnownInflowUsd" DECIMAL(24,4),
    "unknownValueLegs" INTEGER NOT NULL DEFAULT 0,
    "deploymentsJson" JSONB NOT NULL,
    "deployedTokenCount" INTEGER NOT NULL DEFAULT 0,
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "receiptsJson" JSONB NOT NULL,
    "caveats" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receiver_enrollments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receiver_enrollments_chain_receiverAddress_key" ON "receiver_enrollments"("chain", "receiverAddress");
CREATE INDEX "receiver_enrollments_receiverClass_idx" ON "receiver_enrollments"("receiverClass");

CREATE TABLE "token_candidate_scores" (
    "id" TEXT NOT NULL,
    "chain" "ChainId" NOT NULL,
    "mint" TEXT NOT NULL,
    "currentMcapUsd" DECIMAL(20,4),
    "currentMcapTs" TIMESTAMP(3),
    "qualifiedEntityCount" INTEGER NOT NULL DEFAULT 0,
    "independentEntityCount" INTEGER NOT NULL DEFAULT 0,
    "qualifiedBuyerCount" INTEGER NOT NULL DEFAULT 0,
    "linkedAddressCount" INTEGER NOT NULL DEFAULT 0,
    "receiverDeployments" INTEGER NOT NULL DEFAULT 0,
    "dormantReactivations" INTEGER NOT NULL DEFAULT 0,
    "fundedPathCount" INTEGER NOT NULL DEFAULT 0,
    "altWalletEvidenceCount" INTEGER NOT NULL DEFAULT 0,
    "nonCohortBuyerCount" INTEGER NOT NULL DEFAULT 0,
    "kolContamination" INTEGER NOT NULL DEFAULT 0,
    "behaviorMixJson" JSONB,
    "state" TEXT NOT NULL,
    "stateBasis" TEXT NOT NULL,
    "stealthEngineState" TEXT,
    "stealthEngineBucketTs" TIMESTAMP(3),
    "score" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "buyersJson" JSONB NOT NULL,
    "fundingPathsJson" JSONB,
    "reasonCodes" TEXT[] NOT NULL DEFAULT '{}',
    "receiptsJson" JSONB NOT NULL,
    "caveats" TEXT[] NOT NULL DEFAULT '{}',
    "engineVersion" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_candidate_scores_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "token_candidate_scores_chain_mint_key" ON "token_candidate_scores"("chain", "mint");
CREATE INDEX "token_candidate_scores_state_idx" ON "token_candidate_scores"("state");
CREATE INDEX "token_candidate_scores_score_idx" ON "token_candidate_scores"("score");
