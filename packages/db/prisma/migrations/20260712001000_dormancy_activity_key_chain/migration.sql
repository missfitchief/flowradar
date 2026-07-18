-- Codex Batch-A review (Important): a cross-chain edge can carry the SAME
-- textual address on both sides, so the (sourceTable, sourceId, walletAddress)
-- key collided across chains — the second perspective silently overwrote the
-- first. Widen the idempotency key with chain (strictly additive: existing
-- rows already carry chain; widening a unique key can only reduce collisions).
DROP INDEX "wallet_activity_classifications_sourceTable_sourceId_walle_key";
CREATE UNIQUE INDEX "wallet_activity_classifications_sourceTable_sourceId_wa_key" ON "wallet_activity_classifications"("sourceTable", "sourceId", "walletAddress", "chain");
