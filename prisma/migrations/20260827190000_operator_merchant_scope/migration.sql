-- AlterTable
ALTER TABLE "operators" ADD COLUMN     "merchantId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "operators_merchantId_idx" ON "operators"("merchantId");

-- AddForeignKey
ALTER TABLE "operators" ADD CONSTRAINT "operators_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
