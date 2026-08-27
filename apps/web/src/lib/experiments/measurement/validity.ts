import { AnalysisUnit } from "./analysisUnit";
import { ExperimentGroupValue } from "./types";

/**
 * The Experiment Validity Engine (Phase 24 Step 2B).
 *
 * Pure, deterministic, DB-independent. Answers ONLY "can this experiment's
 * observed data be treated as a valid experiment result" - it never
 * computes a recovery rate, a confidence interval, or an incremental GMV
 * estimate (those belong to statistics.ts) and it never decides whether
 * treatment "won." Validity and statistical significance are deliberately
 * kept as separate concepts throughout this module - an experiment can be
 * VALID and still statistically inconclusive, or INVALID regardless of how
 * large an observed difference looks.
 *
 * Consumes AnalysisUnit[] (analysisUnit.ts's already-aggregated randomized
 * units - one row per ExperimentAssignment, per Phase 23's assignment
 * model) rather than rebuilding anything from raw candidates - this module
 * does not import eligibility.ts or re-derive maturity/eligibility logic;
 * it only reads the SUMMARY signals AnalysisUnit already exposes
 * (`exclusionReasons`, `maturedUnknownCandidateCount`, `status`, `arm`).
 */

export type ValiditySeverity = "ERROR" | "WARNING" | "INFO";

export type ValidityCheck = {
  code: string;
  severity: ValiditySeverity;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
};

export type ExperimentValidityStatus = "VALID" | "INVALID" | "INSUFFICIENT_DATA";

export type ExperimentValidityResult = {
  experimentId: string;
  status: ExperimentValidityStatus;
  checks: ValidityCheck[];
};

/**
 * One AnalysisUnit plus the one piece of context AnalysisUnit itself does
 * not carry: which experiment its underlying ExperimentAssignment actually
 * belongs to (Section 16: experiment identity isolation). This is a new,
 * validity-local type - analysisUnit.ts itself is not modified to add this
 * field, since AnalysisUnit is already a stable, tested, frozen output.
 */
export type AssignmentValidityContext = {
  analysisUnit: AnalysisUnit;
  experimentId: string;
};

export type ExperimentValidityInput = {
  experimentId: string;
  /** Experiment.status - a plain string rather than importing the Prisma
   * enum, keeping this module free of any Prisma dependency. */
  experimentStatus: "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";
  /** Experiment.treatmentAllocationPercent. Optional/nullable here even
   * though the real schema field is required, so this module can validate
   * its own input completeness rather than assume a caller always
   * supplies it correctly. */
  treatmentAllocationPercent: number | null;
  /** Caller-supplied minimum ANALYZABLE units required per arm before a
   * result may be treated as adequately sampled. Section 15/22 of Phase 24
   * Step 1: never invented here - null means "no minimum was configured,"
   * a materially different, explicitly distinguished situation from
   * "a minimum was configured and not met." */
  minimumAnalyzableSamplePerArm: number | null;
  assignments: AssignmentValidityContext[];
};

const VALID_STATUSES: readonly string[] = ["DRAFT", "RUNNING", "PAUSED", "COMPLETED"];
const VALID_ARMS: readonly ExperimentGroupValue[] = ["CONTROL", "TREATMENT"];

function countUnitsWithReason(units: AnalysisUnit[], reason: string): number {
  return units.filter((u) => u.exclusionReasons.includes(reason as AnalysisUnit["exclusionReasons"][number])).length;
}

/**
 * Groups assignment contexts by their logical unit key (unitType+unitKey)
 * - the only way to detect a duplicate ExperimentAssignment row or an
 * arm-inconsistency across rows, both of which require comparing ACROSS
 * the whole input population rather than looking at one unit in isolation.
 */
function groupByLogicalUnit(assignments: AssignmentValidityContext[]): Map<string, AssignmentValidityContext[]> {
  const groups = new Map<string, AssignmentValidityContext[]>();
  for (const a of assignments) {
    const key = `${a.analysisUnit.unitType}:${a.analysisUnit.unitKey}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(a);
    } else {
      groups.set(key, [a]);
    }
  }
  return groups;
}

/**
 * Runs every structural/experimental validity check and returns a
 * structured, itemized result. Never throws for ordinary experiment
 * invalidity - every failure mode is reported as a typed check, never a
 * generic error, and VALID/INVALID/INSUFFICIENT_DATA are deliberately
 * three distinct outcomes (Phase 24 Step 1 Section 23) rather than a
 * boolean.
 */
export function evaluateExperimentValidity(input: ExperimentValidityInput): ExperimentValidityResult {
  const checks: ValidityCheck[] = [];
  const units = input.assignments.map((a) => a.analysisUnit);
  const logicalGroups = groupByLogicalUnit(input.assignments);

  // 1. Experiment status.
  const statusKnown = VALID_STATUSES.includes(input.experimentStatus);
  checks.push({
    code: "experiment_status_known",
    severity: "INFO",
    passed: statusKnown,
    message: statusKnown
      ? `Experiment status is ${input.experimentStatus}.`
      : `Experiment status "${input.experimentStatus}" is not a recognized ExperimentStatus value.`,
    details: { status: input.experimentStatus },
  });
  if (!statusKnown) {
    checks.push({
      code: "experiment_status_invalid",
      severity: "ERROR",
      passed: false,
      message: `Cannot validate an experiment with an unrecognized status "${input.experimentStatus}".`,
    });
  }
  const draftWithAssignments = input.experimentStatus === "DRAFT" && units.length > 0;
  checks.push({
    code: "experiment_not_draft_with_assignments",
    severity: "ERROR",
    passed: !draftWithAssignments,
    message: draftWithAssignments
      ? "Experiment status is DRAFT but assignments already exist - DRAFT experiments must never have assignments (Phase 23's own invariant)."
      : "No DRAFT-with-assignments contradiction detected.",
    details: { assignmentCount: units.length },
  });

  // 2/3. Treatment/control arm exists. Missing entirely is a DATA VOLUME
  // signal ("too early," or an extreme allocation skew), not a structural
  // defect - WARNING, contributing to INSUFFICIENT_DATA, never INVALID.
  const treatmentUnits = units.filter((u) => u.arm === "TREATMENT");
  const controlUnits = units.filter((u) => u.arm === "CONTROL");
  checks.push({
    code: "treatment_arm_exists",
    severity: "WARNING",
    passed: treatmentUnits.length > 0,
    message: treatmentUnits.length > 0 ? `${treatmentUnits.length} TREATMENT unit(s) found.` : "No TREATMENT units found at all.",
    details: { count: treatmentUnits.length },
  });
  checks.push({
    code: "control_arm_exists",
    severity: "WARNING",
    passed: controlUnits.length > 0,
    message: controlUnits.length > 0 ? `${controlUnits.length} CONTROL unit(s) found.` : "No CONTROL units found at all.",
    details: { count: controlUnits.length },
  });

  // 4. Assignment uniqueness - more than one ExperimentAssignment row for
  // the same logical (unitType, unitKey) is a real DB-constraint failure
  // if ever observed (Phase 23 Step 5's unique constraint should make this
  // impossible) - ERROR, structurally INVALID if found.
  const duplicateGroups = [...logicalGroups.values()].filter((g) => g.length > 1);
  checks.push({
    code: "assignment_uniqueness",
    severity: "ERROR",
    passed: duplicateGroups.length === 0,
    message:
      duplicateGroups.length === 0
        ? "No duplicate assignments detected."
        : `${duplicateGroups.length} unit(s) have more than one ExperimentAssignment row.`,
    details: { duplicateUnitKeys: duplicateGroups.map((g) => g[0].analysisUnit.unitKey) },
  });

  // 5. Assignment-before-decision - evidenced entirely via eligibility.ts's
  // own "assignment_after_decision" exclusion reason; never re-derived
  // from raw timestamps here.
  const assignmentAfterDecisionCount = countUnitsWithReason(units, "assignment_after_decision");
  checks.push({
    code: "assignment_before_decision",
    severity: "ERROR",
    passed: assignmentAfterDecisionCount === 0,
    message:
      assignmentAfterDecisionCount === 0
        ? "No assignment-after-decision timing violations detected."
        : `${assignmentAfterDecisionCount} unit(s) have a candidate whose assignment occurred after its decision.`,
    details: { affectedUnits: assignmentAfterDecisionCount },
  });

  // 6. Randomization integrity - every unit carries a recognized arm value
  // and no candidate was classified with an unrecognized one.
  const invalidArmValueCount = countUnitsWithReason(units, "invalid_assignment");
  const allArmsRecognized = units.every((u) => VALID_ARMS.includes(u.arm));
  checks.push({
    code: "randomization_integrity",
    severity: "ERROR",
    passed: invalidArmValueCount === 0 && allArmsRecognized,
    message:
      invalidArmValueCount === 0 && allArmsRecognized
        ? "Every assignment carries a recognized CONTROL/TREATMENT arm."
        : "One or more assignments carry an unrecognized arm value.",
    details: { invalidArmValueCount },
  });

  // 7. Control contamination - the most important check in this module.
  // Never reassigns arm; only flags.
  const controlContaminationCount = countUnitsWithReason(units, "control_contamination");
  checks.push({
    code: "control_contamination",
    severity: "ERROR",
    passed: controlContaminationCount === 0,
    message:
      controlContaminationCount === 0
        ? "No CONTROL contamination detected."
        : `${controlContaminationCount} CONTROL unit(s) show evidence of an Execution row - contaminated, never reassigned to TREATMENT.`,
    details: { affectedUnits: controlContaminationCount },
  });

  // 8. Treatment assignment inconsistency - the same logical unit
  // appearing with more than one DISTINCT arm across rows, which the
  // input data can prove directly by inspection (Phase 23's assignment
  // arm is otherwise immutable once persisted).
  const armInconsistentGroups = [...logicalGroups.values()].filter((g) => new Set(g.map((a) => a.analysisUnit.arm)).size > 1);
  checks.push({
    code: "treatment_arm_consistency",
    severity: "ERROR",
    passed: armInconsistentGroups.length === 0,
    message:
      armInconsistentGroups.length === 0
        ? "No arm-inconsistent assignments detected."
        : `${armInconsistentGroups.length} unit(s) appear with more than one distinct arm value across assignment rows.`,
    details: { affectedUnitKeys: armInconsistentGroups.map((g) => g[0].analysisUnit.unitKey) },
  });

  // 9. Immature observations - never a failure; reported for transparency.
  const notYetMatureCount = countUnitsWithReason(units, "outcome_not_mature");
  const missingOutcomePastWindowCount = countUnitsWithReason(units, "missing_outcome_past_window");
  checks.push({
    code: "immature_observations",
    severity: "INFO",
    passed: true,
    message: `${notYetMatureCount} unit(s) not yet mature (window open); ${missingOutcomePastWindowCount} unit(s) past window with no terminal outcome (data-completeness gap).`,
    details: { notYetMatureCount, missingOutcomePastWindowCount },
  });

  // 10. Unknown outcomes - never converted to success/failure; reported.
  const unknownOnlyUnitCount = units.filter((u) => u.status === "NOT_ANALYZABLE" && u.maturedUnknownCandidateCount > 0).length;
  checks.push({
    code: "unknown_outcomes",
    severity: "INFO",
    passed: true,
    message: `${unknownOnlyUnitCount} unit(s) excluded from the primary analysis solely due to unresolved (UNKNOWN) attribution.`,
    details: { unknownOnlyUnitCount },
  });

  // 11. Invalid/excluded assignments - a full summary, never a silent drop.
  const excludedUnits = units.filter((u) => u.status === "NOT_ANALYZABLE");
  const reasonCounts: Record<string, number> = {};
  for (const u of excludedUnits) {
    for (const reason of u.exclusionReasons) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }
  checks.push({
    code: "excluded_assignments_summary",
    severity: "INFO",
    passed: true,
    message: `${excludedUnits.length} of ${units.length} unit(s) are currently NOT_ANALYZABLE.`,
    details: { excludedCount: excludedUnits.length, totalUnits: units.length, reasonCounts },
  });

  // 12. Minimum analyzable sample - "not enough data" kept distinct from
  // "invalid." An unconfigured minimum is a WARNING (we cannot declare
  // sufficiency, not that the experiment is broken); a configured-but-unmet
  // minimum is likewise a WARNING (a sample-size shortfall is a data-volume
  // fact, not a structural defect) - both flow into INSUFFICIENT_DATA,
  // never INVALID, on their own.
  const analyzableTreatmentCount = treatmentUnits.filter((u) => u.status === "ANALYZABLE").length;
  const analyzableControlCount = controlUnits.filter((u) => u.status === "ANALYZABLE").length;
  if (input.minimumAnalyzableSamplePerArm === null) {
    checks.push({
      code: "sample_size_not_configured",
      severity: "WARNING",
      passed: false,
      message: "No minimum analyzable sample size was configured - sample sufficiency cannot be declared, not that the sample is insufficient.",
      details: { analyzableTreatmentCount, analyzableControlCount },
    });
  } else {
    const minimum = input.minimumAnalyzableSamplePerArm;
    const meetsMinimum = analyzableTreatmentCount >= minimum && analyzableControlCount >= minimum;
    checks.push({
      code: meetsMinimum ? "sample_size_meets_minimum" : "sample_size_below_minimum",
      severity: meetsMinimum ? "INFO" : "WARNING",
      passed: meetsMinimum,
      message: meetsMinimum
        ? `Both arms meet the configured minimum of ${minimum} analyzable units.`
        : `At least one arm is below the configured minimum of ${minimum} analyzable units.`,
      details: { minimum, analyzableTreatmentCount, analyzableControlCount },
    });
  }

  // 13. Allocation sanity - validates the CONFIGURED percentage's own
  // mathematical bounds only (0 < percent < 100 for a real two-arm
  // comparison; any specific split, e.g. 1/99 or 90/10, is accepted per
  // Phase 23). A statistical realized-vs-expected mismatch test (sample
  // ratio mismatch / chi-square) is deliberately NOT implemented here -
  // that is a statistical formula and belongs in statistics.ts, not this
  // structural layer (see the accompanying report for this boundary call).
  if (input.treatmentAllocationPercent === null) {
    checks.push({
      code: "allocation_not_configured",
      severity: "WARNING",
      passed: false,
      message: "No treatmentAllocationPercent was supplied - allocation sanity cannot be verified.",
    });
  } else {
    const allocationInBounds = input.treatmentAllocationPercent > 0 && input.treatmentAllocationPercent < 100;
    checks.push({
      code: "allocation_sanity",
      severity: "ERROR",
      passed: allocationInBounds,
      message: allocationInBounds
        ? `Configured allocation (${input.treatmentAllocationPercent}% treatment) is a valid two-arm split.`
        : `Configured allocation (${input.treatmentAllocationPercent}%) does not describe a real two-arm comparison.`,
      details: { treatmentAllocationPercent: input.treatmentAllocationPercent },
    });
  }

  // 14. Analysis-unit integrity - no assignmentId appears more than once
  // (a distinct failure mode from #4's unitKey-level duplicate check - this
  // one catches a caller/query bug producing the same row twice).
  const assignmentIdCounts = new Map<string, number>();
  for (const u of units) {
    assignmentIdCounts.set(u.assignmentId, (assignmentIdCounts.get(u.assignmentId) ?? 0) + 1);
  }
  const duplicateAssignmentIds = [...assignmentIdCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  checks.push({
    code: "analysis_unit_integrity",
    severity: "ERROR",
    passed: duplicateAssignmentIds.length === 0,
    message:
      duplicateAssignmentIds.length === 0
        ? "Every analysis unit maps to exactly one assignment."
        : `${duplicateAssignmentIds.length} assignmentId(s) appear more than once in the input.`,
    details: { duplicateAssignmentIds },
  });

  // 15. Intention-to-treat integrity - a contaminated CONTROL unit must
  // never show as TREATMENT; the analysis arm is always the assignment arm.
  const ittViolations = units.filter((u) => u.exclusionReasons.includes("control_contamination") && u.arm !== "CONTROL");
  checks.push({
    code: "intention_to_treat_integrity",
    severity: "ERROR",
    passed: ittViolations.length === 0,
    message:
      ittViolations.length === 0
        ? "Every contaminated observation retains its original CONTROL assignment arm."
        : `${ittViolations.length} contaminated unit(s) do not show the expected CONTROL arm - possible arm reassignment.`,
    details: { violationCount: ittViolations.length },
  });

  // 16. Experiment identity isolation.
  const foreignAssignments = input.assignments.filter((a) => a.experimentId !== input.experimentId);
  checks.push({
    code: "experiment_isolation",
    severity: "ERROR",
    passed: foreignAssignments.length === 0,
    message:
      foreignAssignments.length === 0
        ? "Every assignment belongs to the requested experiment."
        : `${foreignAssignments.length} assignment(s) belong to a different experiment and must not be included in this analysis.`,
    details: { foreignAssignmentCount: foreignAssignments.length },
  });

  // Documented limitation (Section on assignment timing): execution-before-
  // outcome ordering cannot be verified from aggregated AnalysisUnit data -
  // only assignment-before-decision (check #5) is provable from what this
  // module receives. Reported explicitly rather than silently assumed.
  checks.push({
    code: "execution_before_outcome_timing_unprovable",
    severity: "INFO",
    passed: true,
    message:
      "Execution-before-outcome timing cannot be verified from aggregated analysis-unit data; only assignment-before-decision timing is provable from the available input.",
    details: { provable: false },
  });

  const hasError = checks.some((c) => c.severity === "ERROR" && !c.passed);
  const hasUnresolvedSampleQuestion = checks.some(
    (c) => !c.passed && (c.code === "sample_size_not_configured" || c.code === "sample_size_below_minimum" || c.code === "allocation_not_configured")
  );
  const hasNoData = units.length === 0;

  let status: ExperimentValidityStatus;
  if (hasError) {
    status = "INVALID";
  } else if (hasNoData || hasUnresolvedSampleQuestion || treatmentUnits.length === 0 || controlUnits.length === 0) {
    status = "INSUFFICIENT_DATA";
  } else {
    status = "VALID";
  }

  return { experimentId: input.experimentId, status, checks };
}
