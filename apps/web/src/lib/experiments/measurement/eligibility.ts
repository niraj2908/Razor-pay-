import {
  AttributionPolicy,
  DEFAULT_ATTRIBUTION_POLICY,
  isAttributionWindowClosed,
} from "@/lib/outcomes/attributionEngine";
import {
  AssignmentRecord,
  CandidateOutcomeRecord,
  CandidateRecord,
  ExperimentGroupValue,
  ExperimentWindowRecord,
} from "./types";

/**
 * Eligibility & Maturation (Phase 24 Step 2, Section 2/3).
 *
 * Pure, DB-independent. Classifies every candidate reachable from an
 * ExperimentAssignment as ANALYZABLE or NOT_ANALYZABLE with an explicit,
 * data-provable reason - never silently dropped, never fabricated.
 *
 * Maturity reuses the EXISTING, unmodified attribution window policy
 * (outcomes/attributionEngine.ts) rather than inventing a second window -
 * that policy is already the authoritative answer to "how long do we wait
 * before concluding a payment will not recover," and using a different
 * number here would create an inconsistency between what Outcome.status
 * already says and what measurement independently guesses. The only place
 * this module needs the policy directly (rather than just reading
 * Outcome.status) is the "no Outcome row exists yet" edge case, where it
 * must distinguish ordinary in-window silence from a processing gap.
 */

export type MaturityClassification =
  | "NOT_YET_MATURE" // window still open; genuinely too early to know
  | "MATURED_SUCCESS" // RECOVERED with a resolved (non-UNKNOWN) attribution
  | "MATURED_FAILURE" // NOT_RECOVERED; window closed with no recovery
  | "MATURED_UNKNOWN"; // RECOVERED but attributionStatus=UNKNOWN - Section 16

/** Maturity is undefined entirely - the candidate never reached a point
 * where "how long has it been" is even a meaningful question (e.g. it has
 * no Decision at all yet). */
export type IndeterminateMaturity = "INDETERMINATE";

/**
 * Every reason is provable from data already in the schema (Section 2: "do
 * not invent database fields," "if a reason cannot be proven from existing
 * data, do not fabricate it"). Two deliberate substitutions from the task's
 * example list, both documented:
 *  - "experiment not RUNNING at assignment" has no stored STATUS HISTORY to
 *    check against (only Experiment.status's *current* value) - the
 *    provable proxy is whether assignedAt falls within
 *    [Experiment.startedAt, Experiment.endedAt ?? now), which is what
 *    `assignment_outside_experiment_window` actually checks.
 *  - "invalid payment/outcome relationship" is not implemented as a
 *    separate reason: given how the orchestrator queries data (Outcome is
 *    always read AS the candidate's own Decision's outcome relation), a
 *    mismatched relationship is structurally unreachable, not a real
 *    data-provable condition - fabricating a check for it would violate
 *    the "do not invent" rule as surely as fabricating the reason itself.
 */
export type NotAnalyzableReason =
  | "missing_candidate" // the assignment has zero reachable RevenueRiskEvents
  | "missing_decision" // the candidate has no Decision row
  | "invalid_assignment" // arm is not a recognized ExperimentGroup value (defensive; unreachable via the enum, kept for the same belt-and-suspenders reason isUniqueConstraintViolation-style guards exist elsewhere in this codebase)
  | "assignment_after_decision" // assignedAt > decidedAt - violates Phase 23 Step 5's own proven timing invariant; a validity failure if ever observed
  | "assignment_outside_experiment_window" // assignedAt falls outside [startedAt, endedAt]
  | "control_contamination" // arm=CONTROL but an Execution row exists
  | "outcome_not_mature" // window still open, ordinary "too early"
  | "missing_outcome_past_window" // window closed but no terminal Outcome exists - a data-completeness gap, not ordinary immaturity
  | "unresolved_attribution"; // RECOVERED but attributionStatus=UNKNOWN

export type CandidateClassification = {
  revenueRiskEventId: string;
  status: "ANALYZABLE" | "NOT_ANALYZABLE";
  reason: NotAnalyzableReason | null;
  maturity: MaturityClassification | IndeterminateMaturity;
  /** Paise, present whenever a RECOVERED Outcome exists - even when
   * NOT_ANALYZABLE (e.g. control_contamination, unresolved_attribution) -
   * so downstream sensitivity analysis (Section 16) can still reason about
   * amounts without re-deriving them. */
  recoveredAmount: number | null;
};

const VALID_ARMS: readonly ExperimentGroupValue[] = ["CONTROL", "TREATMENT"];

/**
 * Determines maturity for a single candidate from its own Outcome (if any)
 * and its Decision's age against the attribution window policy. Never
 * treats a still-open window as a failure (Section 3's core requirement).
 */
export function classifyMaturity(
  outcome: CandidateOutcomeRecord,
  decidedAt: Date,
  strategy: string | null,
  now: Date,
  policy: AttributionPolicy
): { maturity: MaturityClassification; windowClosed: boolean } {
  const windowClosed = isAttributionWindowClosed(decidedAt, strategy, now, policy);

  if (!outcome || outcome.status === "PENDING") {
    return { maturity: "NOT_YET_MATURE", windowClosed };
  }
  if (outcome.status === "NOT_RECOVERED") {
    return { maturity: "MATURED_FAILURE", windowClosed };
  }
  // outcome.status === "RECOVERED"
  if (outcome.attributionStatus === "UNKNOWN") {
    return { maturity: "MATURED_UNKNOWN", windowClosed };
  }
  return { maturity: "MATURED_SUCCESS", windowClosed };
}

/**
 * Classifies one candidate under one assignment. Checks run in a fixed
 * order and return on the first violation found, exactly like
 * safetyGate.ts's own fixed-priority-order convention elsewhere in this
 * codebase - the same input always yields exactly one classification.
 */
export function classifyCandidate(
  experimentWindow: ExperimentWindowRecord,
  assignment: { arm: ExperimentGroupValue; assignedAt: Date },
  candidate: CandidateRecord,
  now: Date,
  policy: AttributionPolicy = DEFAULT_ATTRIBUTION_POLICY
): CandidateClassification {
  const base = { revenueRiskEventId: candidate.revenueRiskEventId };

  if (!VALID_ARMS.includes(assignment.arm)) {
    return { ...base, status: "NOT_ANALYZABLE", reason: "invalid_assignment", maturity: "INDETERMINATE", recoveredAmount: null };
  }

  if (!candidate.decision) {
    return { ...base, status: "NOT_ANALYZABLE", reason: "missing_decision", maturity: "INDETERMINATE", recoveredAmount: null };
  }

  if (assignment.assignedAt.getTime() > candidate.decision.decidedAt.getTime()) {
    return { ...base, status: "NOT_ANALYZABLE", reason: "assignment_after_decision", maturity: "INDETERMINATE", recoveredAmount: null };
  }

  const withinExperimentWindow =
    experimentWindow.startedAt !== null &&
    assignment.assignedAt.getTime() >= experimentWindow.startedAt.getTime() &&
    (experimentWindow.endedAt === null || assignment.assignedAt.getTime() <= experimentWindow.endedAt.getTime());
  if (!withinExperimentWindow) {
    return { ...base, status: "NOT_ANALYZABLE", reason: "assignment_outside_experiment_window", maturity: "INDETERMINATE", recoveredAmount: null };
  }

  if (assignment.arm === "CONTROL" && candidate.execution) {
    return {
      ...base,
      status: "NOT_ANALYZABLE",
      reason: "control_contamination",
      maturity: "INDETERMINATE",
      recoveredAmount: candidate.outcome?.recoveredAmount ?? null,
    };
  }

  const strategy = candidate.execution?.actionType ?? null;
  const { maturity, windowClosed } = classifyMaturity(candidate.outcome, candidate.decision.decidedAt, strategy, now, policy);

  if (maturity === "NOT_YET_MATURE") {
    const reason: NotAnalyzableReason = windowClosed ? "missing_outcome_past_window" : "outcome_not_mature";
    return { ...base, status: "NOT_ANALYZABLE", reason, maturity, recoveredAmount: null };
  }

  if (maturity === "MATURED_UNKNOWN") {
    return {
      ...base,
      status: "NOT_ANALYZABLE",
      reason: "unresolved_attribution",
      maturity,
      recoveredAmount: candidate.outcome?.recoveredAmount ?? null,
    };
  }

  // MATURED_SUCCESS or MATURED_FAILURE.
  return { ...base, status: "ANALYZABLE", reason: null, maturity, recoveredAmount: candidate.outcome?.recoveredAmount ?? null };
}

/** Classifies every candidate reachable from one assignment. Never returns
 * an empty array - an assignment with zero candidates is itself a
 * classifiable (NOT_ANALYZABLE) fact, not silently skipped. */
export function classifyAssignmentCandidates(
  experimentWindow: ExperimentWindowRecord,
  assignment: AssignmentRecord,
  now: Date,
  policy: AttributionPolicy = DEFAULT_ATTRIBUTION_POLICY
): CandidateClassification[] {
  if (assignment.candidates.length === 0) {
    return [
      { revenueRiskEventId: "", status: "NOT_ANALYZABLE", reason: "missing_candidate", maturity: "INDETERMINATE", recoveredAmount: null },
    ];
  }
  return assignment.candidates.map((candidate) => classifyCandidate(experimentWindow, assignment, candidate, now, policy));
}
