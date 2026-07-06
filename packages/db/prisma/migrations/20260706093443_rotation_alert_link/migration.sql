-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "rotationSignalId" TEXT;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rotationSignalId_fkey" FOREIGN KEY ("rotationSignalId") REFERENCES "profit_rotation_signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
