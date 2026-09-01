-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "errorReason" TEXT,
ADD COLUMN     "errorSource" TEXT,
ADD COLUMN     "errorStep" TEXT;
