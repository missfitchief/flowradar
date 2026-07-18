-- eventId is the authoritative provider-scoped identity. Different canonical
-- sources may legitimately assign the same eventIndex to one tx.
DROP INDEX "mass_transaction_events_chain_txHash_eventIndex_key";
CREATE INDEX "mass_transaction_events_chain_txHash_eventIndex_idx" ON "mass_transaction_events"("chain", "txHash", "eventIndex");
