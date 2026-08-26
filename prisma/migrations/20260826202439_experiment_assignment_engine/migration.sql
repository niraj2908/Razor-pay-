-- AlterEnum
ALTER TYPE "ExperimentStatus" ADD VALUE 'PAUSED';

-- AlterTable
ALTER TABLE "experiment_assignments" ADD COLUMN     "assignmentAlgorithm" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "experiments" ADD COLUMN     "treatmentAllocationPercent" INTEGER NOT NULL;
