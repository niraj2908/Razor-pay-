-- AlterTable
ALTER TABLE "executions" ADD COLUMN     "recoveredPaymentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "executions_recoveredPaymentId_key" ON "executions"("recoveredPaymentId");

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_recoveredPaymentId_fkey" FOREIGN KEY ("recoveredPaymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

