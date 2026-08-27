-- AlterTable
ALTER TABLE "experiments" ADD COLUMN     "merchantId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "experiments_merchantId_idx" ON "experiments"("merchantId");

-- AddForeignKey
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
