ALTER TABLE "mass_transaction_events" ADD COLUMN "actorAddress" TEXT;
CREATE INDEX "mass_transaction_events_actorAddress_ts_idx" ON "mass_transaction_events"("actorAddress", "ts");
