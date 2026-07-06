-- AlterTable
ALTER TABLE "backtest_results" ADD COLUMN     "basis" TEXT,
ADD COLUMN     "evaluatedAt" TIMESTAMP(3),
ADD COLUMN     "hit10x" BOOLEAN,
ADD COLUMN     "hit2x" BOOLEAN,
ADD COLUMN     "hit5x" BOOLEAN,
ADD COLUMN     "hitPlus50" BOOLEAN,
ADD COLUMN     "outcomeLabel" TEXT,
ADD COLUMN     "timeToPeakMin" INTEGER;
