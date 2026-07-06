-- AlterTable
ALTER TABLE "token_market_snapshots" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'ingest';
