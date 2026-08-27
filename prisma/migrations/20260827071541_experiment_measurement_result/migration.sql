-- CreateEnum
CREATE TYPE "MeasurementResultKind" AS ENUM ('INTERIM', 'FINAL');

-- CreateEnum
CREATE TYPE "MeasurementResultStatus" AS ENUM ('INSUFFICIENT_DATA', 'INVALID', 'VALID_INCONCLUSIVE', 'VALID_EFFECT');

-- CreateTable
CREATE TABLE "experiment_measurement_results" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "resultKind" "MeasurementResultKind" NOT NULL,
    "resultStatus" "MeasurementResultStatus" NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calculatedAt" TIMESTAMP(3) NOT NULL,
    "dataCutoffAt" TIMESTAMP(3) NOT NULL,
    "statisticalMethodVersion" TEXT NOT NULL,
    "eligibilityLogicVersion" TEXT NOT NULL,
    "validityLogicVersion" TEXT NOT NULL,
    "confidenceLevel" DOUBLE PRECISION NOT NULL,
    "minimumPracticalEffectRateDifference" DOUBLE PRECISION,
    "totalAssignments" INTEGER NOT NULL,
    "treatmentAnalyzableUnits" INTEGER NOT NULL,
    "treatmentSuccessUnits" INTEGER NOT NULL,
    "treatmentRate" DOUBLE PRECISION,
    "treatmentRateLower" DOUBLE PRECISION,
    "treatmentRateUpper" DOUBLE PRECISION,
    "treatmentRecoveredGMVPaise" INTEGER NOT NULL,
    "controlAnalyzableUnits" INTEGER NOT NULL,
    "controlSuccessUnits" INTEGER NOT NULL,
    "controlRate" DOUBLE PRECISION,
    "controlRateLower" DOUBLE PRECISION,
    "controlRateUpper" DOUBLE PRECISION,
    "controlRecoveredGMVPaise" INTEGER NOT NULL,
    "observedDifference" DOUBLE PRECISION,
    "observedDifferenceLower" DOUBLE PRECISION,
    "observedDifferenceUpper" DOUBLE PRECISION,
    "estimatedCounterfactualTreatmentGMVPaise" INTEGER,
    "estimatedIncrementalGMVPaise" INTEGER,
    "treatmentUnknownOnlyUnits" INTEGER NOT NULL,
    "controlUnknownOnlyUnits" INTEGER NOT NULL,
    "excludedUnitsTotal" INTEGER NOT NULL,
    "exclusionReasonCounts" JSONB NOT NULL,
    "validityChecks" JSONB NOT NULL,

    CONSTRAINT "experiment_measurement_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "experiment_measurement_results_experimentId_generatedAt_idx" ON "experiment_measurement_results"("experimentId", "generatedAt");

-- CreateIndex
CREATE INDEX "experiment_measurement_results_experimentId_resultKind_idx" ON "experiment_measurement_results"("experimentId", "resultKind");

-- CreateIndex
CREATE INDEX "experiment_measurement_results_resultStatus_idx" ON "experiment_measurement_results"("resultStatus");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_measurement_results_version_key" ON "experiment_measurement_results"("experimentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_measurement_results_calc_identity_key" ON "experiment_measurement_results"("experimentId", "statisticalMethodVersion", "eligibilityLogicVersion", "validityLogicVersion", "dataCutoffAt");

-- AddForeignKey
ALTER TABLE "experiment_measurement_results" ADD CONSTRAINT "experiment_measurement_results_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "experiments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
