import { prisma } from "@/lib/db";
import { AttributionPolicy, DEFAULT_ATTRIBUTION_POLICY } from "@/lib/outcomes/attributionEngine";
import { AnalysisUnit, buildAnalysisUnit } from "./analysisUnit";
import { classifyAssignmentCandidates } from "./eligibility";
import {
  GMVStats,
  IncrementalGMVResult,
  ObservedDifferenceResult,
  RecoveryRateStats,
  SampleSizeInput,
  SampleSizeResult,
  SensitivityBounds,
  computeGMVStats,
  computeIncrementalGMV,
  computeObservedDifference,
  computeRecoveryRateStats,
  computeRequiredSampleSize,
  computeUnknownSensitivity,
} from "./statistics";
import { AssignmentRecord, ExperimentWindowRecord } from "./types";
import { AssignmentValidityContext, ExperimentValidityResult, evaluateExperimentValidity } from "./validity";

/**
 * The Experiment Result Orchestrator (Phase 24 Step 2C) - the ONLY file in
 * the measurement layer that touches Prisma. Its entire job is: load one
 * experiment's real data, reshape it into the plain domain types the pure
 * layers already expect, call those layers in the approved order
 * (Assignment -> Maturation/Eligibility -> Analysis Unit -> Validity ->
 * Statistical Engine), and assemble the result. It contains NO statistical
 * formulas, NO eligibility/maturity logic, and NO validity rules of its
 * own - every one of those already lives in eligibility.ts, analysisUnit.ts,
 * statistics.ts, and validity.ts respectively.
 *
 * Deliberately does NOT persist anything - the result is returned as a
 * plain in-memory typed object (Phase 24 Step 2 Section: "DO NOT persist
 * ExperimentResult yet"). No new schema, no migration - this file only
 * reads existing tables (Experiment, ExperimentAssignment, RevenueRiskEvent,
 * Decision, Execution, Outcome).
 */

/** Deterministic, hand-maintained version tags (Phase 24 Step 1 Section 22:
 * "Use deterministic code constants," never an LLM-generated version).
 * Kept here rather than inside eligibility.ts/statistics.ts/validity.ts
 * themselves so those already-tested, frozen pure modules are not touched
 * to add this - see the accompanying report for why this is a deliberate,
 * documented simplification rather than each module self-declaring its
 * own version. */
export const ELIGIBILITY_LOGIC_VERSION = "eligibility-v1";
export const STATISTICAL_METHOD_VERSION = "statistics-v1";
export const VALIDITY_LOGIC_VERSION = "validity-v1";

export type ExperimentResultOutcome =
  | { status: "experiment_not_found" }
  | { status: "computed"; result: ExperimentAnalysisResult };

export type ExperimentAnalysisResult = {
  experimentId: string;
  /** Experiment.status as read at calculation time (Phase 24 Step 4) -
   * exposed so a persistence layer can derive the resultKind (INTERIM vs.
   * FINAL) lifecycle axis without a second query; this module still never
   * uses it to influence eligibility/validity/statistics itself. */
  experimentStatus: "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";
  /** ISO 8601. When this specific computation ran - never itself a claim
   * about when the underlying data was collected. */
  calculatedAt: string;
  eligibilityLogicVersion: string;
  statisticalMethodVersion: string;
  validityLogicVersion: string;
  confidenceLevel: number;
  validity: ExperimentValidityResult;
  treatment: { recoveryRate: RecoveryRateStats; gmv: GMVStats; sensitivity: SensitivityBounds };
  control: { recoveryRate: RecoveryRateStats; gmv: GMVStats; sensitivity: SensitivityBounds };
  /** Explicitly OBSERVED_TREATMENT_CONTROL_DIFFERENCE - never itself a
   * causal claim; combine with `validity.status` to decide whether an
   * incremental interpretation is even supportable. */
  observedDifference: ObservedDifferenceResult;
  incrementalGMV: IncrementalGMVResult;
  /** Null when the caller supplied no sample-size configuration - never a
   * fabricated default (Phase 24 Step 1/2 Section 13/15). */
  sampleSize: SampleSizeResult | null;
};

export type ComputeExperimentResultOptions = {
  now?: Date;
  /** Passed straight to validity.ts - null means "no minimum configured,"
   * never silently assumed to be zero or satisfied. */
  minimumAnalyzableSamplePerArm?: number | null;
  /** Only computed when supplied - see statistics.ts's computeRequiredSampleSize. */
  sampleSizeConfig?: SampleSizeInput;
  /** Overrides the attribution window policy used for maturity
   * classification - defaults to the SAME production policy
   * outcomeService.ts already uses, for consistency (Phase 24 Step 2's
   * own eligibility.ts design rationale). */
  attributionPolicy?: AttributionPolicy;
};

/**
 * Loads one experiment's assignments, candidates, decisions, executions,
 * and outcomes with exactly two deliberate queries (Section 24's query
 * discipline: no N+1) - one for the Experiment row, one for its
 * ExperimentAssignments with a nested `include` graph that Prisma resolves
 * as a small, fixed number of joined queries regardless of row count, never
 * one query per assignment or per candidate. Never reads PaymentEvent
 * payloads or any raw webhook data.
 */
export async function computeExperimentResult(
  experimentId: string,
  confidenceLevel: number,
  options: ComputeExperimentResultOptions = {}
): Promise<ExperimentResultOutcome> {
  const now = options.now ?? new Date();
  const attributionPolicy = options.attributionPolicy ?? DEFAULT_ATTRIBUTION_POLICY;
  const minimumAnalyzableSamplePerArm = options.minimumAnalyzableSamplePerArm ?? null;

  const experiment = await prisma.experiment.findUnique({ where: { id: experimentId } });
  if (!experiment) {
    return { status: "experiment_not_found" };
  }

  const assignmentRows = await prisma.experimentAssignment.findMany({
    where: { experimentId },
    include: {
      revenueRiskEvents: {
        include: {
          decisions: {
            include: { executions: true, outcome: true },
          },
        },
      },
    },
  });

  const experimentWindow: ExperimentWindowRecord = { startedAt: experiment.startedAt, endedAt: experiment.endedAt };

  const units: AnalysisUnit[] = [];
  const validityAssignments: AssignmentValidityContext[] = [];

  for (const row of assignmentRows) {
    const record: AssignmentRecord = {
      id: row.id,
      unitType: row.unitType,
      unitKey: row.unitKey,
      arm: row.arm,
      assignedAt: row.assignedAt,
      candidates: row.revenueRiskEvents.map((riskEvent) => {
        // By construction (candidateBuilder.ts creates exactly one Decision
        // per RevenueRiskEvent today), this is normally a single-element
        // array - sorted by decidedAt to stay deterministic regardless of
        // DB return order on the rare/future case of more than one.
        const decision = [...riskEvent.decisions].sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime())[0] ?? null;
        // Execution.decisionId is @unique, so at most one - no sort needed.
        const execution = decision?.executions[0] ?? null;
        const outcome = decision?.outcome ?? null;

        return {
          revenueRiskEventId: riskEvent.id,
          decision: decision ? { id: decision.id, decidedAt: decision.decidedAt } : null,
          execution: execution ? { status: execution.status, actionType: execution.actionType } : null,
          outcome: outcome
            ? { status: outcome.status, attributionStatus: outcome.attributionStatus, recoveredAmount: outcome.recoveredAmount }
            : null,
        };
      }),
    };

    const classifications = classifyAssignmentCandidates(experimentWindow, record, now, attributionPolicy);
    const analysisUnit = buildAnalysisUnit(record, classifications);
    units.push(analysisUnit);
    // row.experimentId (the row's OWN actual database value), not
    // experiment.id - so validity's isolation check verifies what the
    // database actually returned, not merely what we assume the query
    // filter guaranteed.
    validityAssignments.push({ analysisUnit, experimentId: row.experimentId });
  }

  const validity = evaluateExperimentValidity({
    experimentId: experiment.id,
    experimentStatus: experiment.status,
    treatmentAllocationPercent: experiment.treatmentAllocationPercent,
    minimumAnalyzableSamplePerArm,
    assignments: validityAssignments,
  });

  const treatmentRecoveryRate = computeRecoveryRateStats(units, "TREATMENT", confidenceLevel);
  const controlRecoveryRate = computeRecoveryRateStats(units, "CONTROL", confidenceLevel);
  const treatmentGMV = computeGMVStats(units, "TREATMENT");
  const controlGMV = computeGMVStats(units, "CONTROL");

  const result: ExperimentAnalysisResult = {
    experimentId: experiment.id,
    experimentStatus: experiment.status,
    calculatedAt: now.toISOString(),
    eligibilityLogicVersion: ELIGIBILITY_LOGIC_VERSION,
    statisticalMethodVersion: STATISTICAL_METHOD_VERSION,
    validityLogicVersion: VALIDITY_LOGIC_VERSION,
    confidenceLevel,
    validity,
    treatment: {
      recoveryRate: treatmentRecoveryRate,
      gmv: treatmentGMV,
      sensitivity: computeUnknownSensitivity(units, "TREATMENT"),
    },
    control: {
      recoveryRate: controlRecoveryRate,
      gmv: controlGMV,
      sensitivity: computeUnknownSensitivity(units, "CONTROL"),
    },
    observedDifference: computeObservedDifference(treatmentRecoveryRate, controlRecoveryRate),
    incrementalGMV: computeIncrementalGMV(treatmentGMV, controlGMV),
    sampleSize: options.sampleSizeConfig ? computeRequiredSampleSize(options.sampleSizeConfig) : null,
  };

  return { status: "computed", result };
}
