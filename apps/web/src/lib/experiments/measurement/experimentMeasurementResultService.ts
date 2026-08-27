import type { ExperimentMeasurementResult, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ExperimentAnalysisResult } from "./experimentResultService";
import { ComposedMeasurementResult, MinimumPracticalEffect, composeMeasurementResult } from "./resultStatus";

/**
 * The Experiment Measurement Result Persistence Service (Phase 24 Step 4).
 *
 * A thin persistence boundary around an ALREADY-COMPUTED
 * ExperimentAnalysisResult (experimentResultService.ts). This file
 * contains NO statistical formulas, NO eligibility/validity logic, makes
 * NO Razorpay calls, and never touches Outcome/ExperimentAssignment/
 * Payment/Decision/Execution/RevenueRiskEvent - it only reads the
 * already-computed result object and writes ONE new,
 * immutable ExperimentMeasurementResult row (plus its AuditEvent).
 *
 *   computeExperimentResult()  ->  ExperimentAnalysisResult
 *                                        |
 *                                        v
 *                              persistExperimentResult()
 *                                        |
 *                                        v
 *                            ExperimentMeasurementResult (DB)
 *
 * Immutability: once a row is created it is NEVER updated - a
 * recalculation always produces a new row (a new `version`), enforced
 * structurally by this file never calling `.update()` on this model
 * anywhere.
 */

/**
 * Against real PostgreSQL, Prisma's P2002 `meta.target` for a NAMED
 * compound unique constraint (via `@@unique(..., map: "...")`) is reported
 * as the ARRAY OF SCHEMA FIELD NAMES the constraint covers - never the raw
 * SQL constraint name string - confirmed empirically against the real
 * database (e.g. "Unique constraint failed on the fields:
 * (`experimentId`,`version`)"). The two constraints below are distinguished
 * by their field SETS, not by name string matching.
 */
const VERSION_CONSTRAINT_FIELDS = ["experimentId", "version"];
const CALC_IDENTITY_CONSTRAINT_FIELDS = [
  "experimentId",
  "statisticalMethodVersion",
  "eligibilityLogicVersion",
  "validityLogicVersion",
  "dataCutoffAt",
];
const MAX_VERSION_RETRIES = 5;

export type PersistedExperimentMeasurementResult = ExperimentMeasurementResult;

export type PersistExperimentResultOutcome =
  | { status: "created"; record: PersistedExperimentMeasurementResult }
  | { status: "existing"; record: PersistedExperimentMeasurementResult }
  | { status: "rejected"; reason: "not_computed" };

function isUniqueConstraintViolation(error: unknown): error is { code: string; meta?: { target?: string | string[] } } {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002";
}

function violatesConstraint(error: { meta?: { target?: string | string[] } }, fields: string[]): boolean {
  const target = error.meta?.target;
  if (!target) return false;
  if (Array.isArray(target)) {
    return target.length === fields.length && fields.every((f) => target.includes(f));
  }
  // Defensive fallback for a connector/version that reports the raw
  // constraint name as a string instead of a field array.
  return fields.every((f) => target.includes(f));
}

function extractValidityCheckDetails(result: ExperimentAnalysisResult, code: string): Record<string, unknown> | undefined {
  return result.validity.checks.find((c) => c.code === code)?.details;
}

/**
 * Reads maturity directly from validity.ts's own "immature_observations"
 * check (a details field, not a re-derivation of any eligibility/analysis-
 * unit logic) - this is DATA the validity engine already computed, not
 * LOGIC being duplicated here.
 */
function isFullyMatured(result: ExperimentAnalysisResult): boolean {
  const details = extractValidityCheckDetails(result, "immature_observations");
  const notYetMatureCount = (details?.notYetMatureCount as number | undefined) ?? 0;
  const missingOutcomePastWindowCount = (details?.missingOutcomePastWindowCount as number | undefined) ?? 0;
  return notYetMatureCount === 0 && missingOutcomePastWindowCount === 0;
}

function extractUnknownOnlyUnitCount(result: ExperimentAnalysisResult): { treatment: number; control: number } {
  return {
    treatment: result.treatment.sensitivity.unknownOnlyUnitCount,
    control: result.control.sensitivity.unknownOnlyUnitCount,
  };
}

function extractExclusionSummary(result: ExperimentAnalysisResult): { excludedUnitsTotal: number; reasonCounts: Record<string, unknown> } {
  const details = extractValidityCheckDetails(result, "excluded_assignments_summary");
  return {
    excludedUnitsTotal: (details?.excludedCount as number | undefined) ?? 0,
    reasonCounts: (details?.reasonCounts as Record<string, unknown> | undefined) ?? {},
  };
}

function extractTotalAssignments(result: ExperimentAnalysisResult): number {
  const details = extractValidityCheckDetails(result, "excluded_assignments_summary");
  return (details?.totalUnits as number | undefined) ?? 0;
}

/** Maps an already-computed, in-memory result into the exact row shape
 * Prisma expects - pure data transformation, no calculation. */
function toRowData(
  result: ExperimentAnalysisResult,
  composed: ComposedMeasurementResult,
  minimumPracticalEffect: MinimumPracticalEffect,
  version: number
) {
  const { treatment, control, observedDifference, incrementalGMV } = result;
  const unknownOnly = extractUnknownOnlyUnitCount(result);
  const exclusion = extractExclusionSummary(result);

  const observedDiff =
    observedDifference.status === "computed"
      ? {
          observedDifference: observedDifference.observedDifference,
          observedDifferenceLower: observedDifference.confidenceInterval.lower,
          observedDifferenceUpper: observedDifference.confidenceInterval.upper,
        }
      : { observedDifference: null, observedDifferenceLower: null, observedDifferenceUpper: null };

  const gmvEstimate =
    incrementalGMV.status === "computed"
      ? {
          estimatedCounterfactualTreatmentGMVPaise: incrementalGMV.estimatedCounterfactualTreatmentGMV,
          estimatedIncrementalGMVPaise: incrementalGMV.estimatedIncrementalGMV,
        }
      : { estimatedCounterfactualTreatmentGMVPaise: null, estimatedIncrementalGMVPaise: null };

  return {
    experimentId: result.experimentId,
    version,
    resultKind: composed.resultKind,
    resultStatus: composed.resultStatus,
    calculatedAt: new Date(result.calculatedAt),
    dataCutoffAt: new Date(result.calculatedAt), // the engine's `now` serves as both today - see report
    statisticalMethodVersion: result.statisticalMethodVersion,
    eligibilityLogicVersion: result.eligibilityLogicVersion,
    validityLogicVersion: result.validityLogicVersion,
    confidenceLevel: result.confidenceLevel,
    minimumPracticalEffectRateDifference: minimumPracticalEffect?.minimumRateDifference ?? null,

    totalAssignments: extractTotalAssignments(result),
    treatmentAnalyzableUnits: treatment.recoveryRate.analyzableUnits,
    treatmentSuccessUnits: treatment.recoveryRate.successes,
    treatmentRate: treatment.recoveryRate.rate,
    treatmentRateLower: treatment.recoveryRate.confidenceInterval.status === "computed" ? treatment.recoveryRate.confidenceInterval.lower : null,
    treatmentRateUpper: treatment.recoveryRate.confidenceInterval.status === "computed" ? treatment.recoveryRate.confidenceInterval.upper : null,
    treatmentRecoveredGMVPaise: treatment.gmv.recoveredGMV,

    controlAnalyzableUnits: control.recoveryRate.analyzableUnits,
    controlSuccessUnits: control.recoveryRate.successes,
    controlRate: control.recoveryRate.rate,
    controlRateLower: control.recoveryRate.confidenceInterval.status === "computed" ? control.recoveryRate.confidenceInterval.lower : null,
    controlRateUpper: control.recoveryRate.confidenceInterval.status === "computed" ? control.recoveryRate.confidenceInterval.upper : null,
    controlRecoveredGMVPaise: control.gmv.recoveredGMV,

    ...observedDiff,
    ...gmvEstimate,

    treatmentUnknownOnlyUnits: unknownOnly.treatment,
    controlUnknownOnlyUnits: unknownOnly.control,
    excludedUnitsTotal: exclusion.excludedUnitsTotal,
    exclusionReasonCounts: exclusion.reasonCounts as Prisma.InputJsonValue,
    validityChecks: result.validity.checks as unknown as Prisma.InputJsonValue,
  };
}

/**
 * Persists one already-computed ExperimentAnalysisResult as an immutable
 * ExperimentMeasurementResult snapshot.
 *
 * Idempotency: if a row already exists for this exact calculation identity
 * (experimentId + all three algorithm versions + dataCutoffAt), that
 * EXISTING row is returned - never a duplicate, never re-created. This is
 * checked structurally via the database's own unique constraint (create ->
 * P2002 -> fetch existing), never a check-then-insert race.
 *
 * Concurrency / versioning: `version` is optimistically computed as
 * (current max version for this experiment) + 1, immediately before the
 * insert attempt. If a concurrent writer wins that exact version number
 * first, THIS write's `create()` fails with P2002 on the
 * (experimentId, version) unique constraint - never silently overwriting
 * anything - and is retried with a freshly-read next version, up to
 * MAX_VERSION_RETRIES times. The database constraint, not this retry loop,
 * is what actually prevents two rows from ever sharing a version; the loop
 * only makes a losing writer's operation eventually succeed instead of
 * failing outright under real contention.
 *
 * The new row and its AuditEvent are created as two sequential writes - the
 * SAME pattern already established by experimentService.ts/outcomeService.ts
 * (create -> P2002 -> fetch existing, then a separate auditEvent.create),
 * never wrapped in prisma.$transaction(). This is a deliberate consistency
 * choice, not an oversight: an interactive $transaction() was tried first
 * and produced real, reproducible hangs under concurrent load against the
 * project's Supabase pooler connection (see integration test run history) -
 * the two-write pattern is what the rest of this codebase already uses
 * successfully for the identical "idempotent create + paired audit event"
 * shape, so this file now matches it instead of introducing a second,
 * differently-behaved mechanism.
 */
export async function persistExperimentResult(
  result: ExperimentAnalysisResult | { status: "experiment_not_found" },
  minimumPracticalEffect: MinimumPracticalEffect
): Promise<PersistExperimentResultOutcome> {
  if (!("experimentId" in result)) {
    return { status: "rejected", reason: "not_computed" };
  }

  const fullyMatured = isFullyMatured(result);
  const composed = composeMeasurementResult({
    experimentStatus: result.experimentStatus,
    validityStatus: result.validity.status,
    observedDifference: result.observedDifference,
    minimumPracticalEffect,
    fullyMatured,
  });

  for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
    const latest = await prisma.experimentMeasurementResult.findFirst({
      where: { experimentId: result.experimentId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const nextVersion = (latest?.version ?? 0) + 1;
    const data = toRowData(result, composed, minimumPracticalEffect, nextVersion);

    try {
      const created = await prisma.experimentMeasurementResult.create({ data });
      await prisma.auditEvent.create({
        data: {
          entityType: "ExperimentMeasurementResult",
          entityId: created.id,
          action: "experiment_measurement_result.created",
          actorType: "SYSTEM",
          details: {
            experimentId: created.experimentId,
            version: created.version,
            resultKind: created.resultKind,
            resultStatus: created.resultStatus,
            statisticalMethodVersion: created.statisticalMethodVersion,
            dataCutoffAt: created.dataCutoffAt,
          },
        },
      });
      return { status: "created", record: created };
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
      if (violatesConstraint(error, CALC_IDENTITY_CONSTRAINT_FIELDS)) {
        // The exact same calculation was already persisted - idempotent,
        // return the existing row rather than creating a duplicate.
        const existing = await prisma.experimentMeasurementResult.findUniqueOrThrow({
          where: {
            calcIdentityKey: {
              experimentId: result.experimentId,
              statisticalMethodVersion: result.statisticalMethodVersion,
              eligibilityLogicVersion: result.eligibilityLogicVersion,
              validityLogicVersion: result.validityLogicVersion,
              dataCutoffAt: new Date(result.calculatedAt),
            },
          },
        });
        return { status: "existing", record: existing };
      }
      if (violatesConstraint(error, VERSION_CONSTRAINT_FIELDS)) {
        // A concurrent writer claimed this exact version number first for
        // a DIFFERENT calculation - retry with a freshly-read next version.
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `persistExperimentResult: failed to allocate a version for experiment ${result.experimentId} after ${MAX_VERSION_RETRIES} attempts`
  );
}

export { composeMeasurementResult } from "./resultStatus";
export type { MinimumPracticalEffect } from "./resultStatus";
