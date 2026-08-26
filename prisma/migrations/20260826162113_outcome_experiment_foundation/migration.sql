-- CreateEnum
CREATE TYPE "OutcomeStatus" AS ENUM ('PENDING', 'RECOVERED', 'NOT_RECOVERED');

-- CreateEnum
CREATE TYPE "AttributionStatus" AS ENUM ('NATURAL_RECOVERY', 'INTERVENTION_RECOVERY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ExperimentStatus" AS ENUM ('DRAFT', 'RUNNING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AssignmentUnit" AS ENUM ('CUSTOMER', 'CANDIDATE');

-- DropForeignKey
ALTER TABLE "experiment_assignments" DROP CONSTRAINT "experiment_assignments_revenueRiskEventId_fkey";

-- DropForeignKey
ALTER TABLE "outcomes" DROP CONSTRAINT "outcomes_revenueRiskEventId_fkey";

-- DropIndex
DROP INDEX "experiment_assignments_revenueRiskEventId_key";

-- DropIndex
DROP INDEX "outcomes_revenueRiskEventId_idx";

-- AlterTable
ALTER TABLE "experiment_assignments" DROP COLUMN "group",
DROP COLUMN "revenueRiskEventId",
ADD COLUMN     "arm" "ExperimentGroup" NOT NULL,
ADD COLUMN     "eligibilityVersion" TEXT NOT NULL,
ADD COLUMN     "unitKey" TEXT NOT NULL,
ADD COLUMN     "unitType" "AssignmentUnit" NOT NULL;

-- AlterTable
ALTER TABLE "experiments" ADD COLUMN     "controlDefinition" TEXT NOT NULL DEFAULT 'no_intervention',
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "hypothesis" TEXT,
ADD COLUMN     "trafficAllocationPercent" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "treatmentDefinition" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "version" TEXT NOT NULL,
ALTER COLUMN "startedAt" DROP NOT NULL,
ALTER COLUMN "startedAt" DROP DEFAULT,
DROP COLUMN "status",
ADD COLUMN     "status" "ExperimentStatus" NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "outcomes" DROP COLUMN "attributedIncremental",
DROP COLUMN "recovered",
DROP COLUMN "revenueRiskEventId",
ADD COLUMN     "attributionPolicyVersion" TEXT NOT NULL,
ADD COLUMN     "attributionStatus" "AttributionStatus",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "decisionId" TEXT NOT NULL,
ADD COLUMN     "evidencePaymentEventId" TEXT,
ADD COLUMN     "executionId" TEXT,
ADD COLUMN     "paymentId" TEXT NOT NULL,
ADD COLUMN     "status" "OutcomeStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "revenue_risk_events" ADD COLUMN     "experimentAssignmentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "experiment_assignments_experimentId_unitType_unitKey_key" ON "experiment_assignments"("experimentId", "unitType", "unitKey");

-- CreateIndex
CREATE UNIQUE INDEX "outcomes_decisionId_key" ON "outcomes"("decisionId");

-- CreateIndex
CREATE UNIQUE INDEX "outcomes_executionId_key" ON "outcomes"("executionId");

-- CreateIndex
CREATE INDEX "outcomes_paymentId_idx" ON "outcomes"("paymentId");

-- CreateIndex
CREATE INDEX "outcomes_status_idx" ON "outcomes"("status");

-- CreateIndex
CREATE INDEX "revenue_risk_events_experimentAssignmentId_idx" ON "revenue_risk_events"("experimentAssignmentId");

-- AddForeignKey
ALTER TABLE "revenue_risk_events" ADD CONSTRAINT "revenue_risk_events_experimentAssignmentId_fkey" FOREIGN KEY ("experimentAssignmentId") REFERENCES "experiment_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_evidencePaymentEventId_fkey" FOREIGN KEY ("evidencePaymentEventId") REFERENCES "payment_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

