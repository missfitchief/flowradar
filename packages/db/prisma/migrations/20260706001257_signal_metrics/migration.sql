-- AlterTable
ALTER TABLE "signals" ADD COLUMN     "metrics" JSONB NOT NULL DEFAULT '{}';
