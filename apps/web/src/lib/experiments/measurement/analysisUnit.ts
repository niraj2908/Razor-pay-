import { CandidateClassification, NotAnalyzableReason } from "./eligibility";
import { AssignmentUnitValue, ExperimentGroupValue } from "./types";

/**
 * Analysis-Unit Aggregation (Phase 24 Step 2, Section 4).
 *
 * Pure. The randomized unit of analysis is the ExperimentAssignment row
 * itself, NOT the candidate/payment - a CUSTOMER-unit assignment is
 * deliberately reused across every recovery candidate for that customer
 * (Phase 23), so one customer's many candidates must roll up into exactly
 * ONE analysis row, never one row per candidate. A guest (CANDIDATE-unit)
 * assignment already has exactly one candidate in practice, so it needs no
 * special-casing - the same rollup logic degenerates correctly to a single
 * candidate.
 *
 * Binary rollup rule: a unit counts as SUCCESS if ANY of its analyzable
 * candidates achieved MATURED_SUCCESS - one vote per unit, regardless of
 * how many candidates it had (Section 4's explicit requirement: a customer
 * with 10 candidates must not carry 10x the weight of one with a single
 * candidate). GMV rollup is additive instead (a unit's total recovered
 * value is the sum across ALL of its analyzable successes) - GMV is a
 * conserved economic quantity, not a count, so summing it does not
 * reintroduce the over-weighting problem the binary rule guards against.
 */

export type AnalysisUnit = {
  assignmentId: string;
  unitType: AssignmentUnitValue;
  unitKey: string;
  arm: ExperimentGroupValue;
  /** Total candidates classified under this assignment (any status). */
  candidateCount: number;
  analyzableSuccessCount: number;
  analyzableFailureCount: number;
  /** Candidates that matured RECOVERED-but-UNKNOWN-attribution - tracked
   * for Section 16 sensitivity even though they never affect `outcome`
   * below. */
  maturedUnknownCandidateCount: number;
  /** Unit-level rollup: ANALYZABLE only when at least one candidate
   * contributed a resolved (success or failure) answer. */
  status: "ANALYZABLE" | "NOT_ANALYZABLE";
  /** Null when NOT_ANALYZABLE - there is no unit-level answer yet. */
  outcome: "SUCCESS" | "FAILURE" | null;
  /** Paise. Sum of recoveredAmount across this unit's analyzable
   * successes only - zero when there are none. */
  recoveredAmount: number;
  /** Distinct NOT_ANALYZABLE reasons observed among this unit's
   * non-contributing candidates, for transparency (Section 2: never
   * silently drop). Empty when every candidate contributed. */
  exclusionReasons: NotAnalyzableReason[];
};

export function buildAnalysisUnit(
  assignment: { id: string; unitType: AssignmentUnitValue; unitKey: string; arm: ExperimentGroupValue },
  classifications: CandidateClassification[]
): AnalysisUnit {
  const analyzable = classifications.filter((c) => c.status === "ANALYZABLE");
  const successes = analyzable.filter((c) => c.maturity === "MATURED_SUCCESS");
  const failures = analyzable.filter((c) => c.maturity === "MATURED_FAILURE");
  const maturedUnknown = classifications.filter((c) => c.maturity === "MATURED_UNKNOWN");

  const recoveredAmount = successes.reduce((sum, c) => sum + (c.recoveredAmount ?? 0), 0);

  const exclusionReasons = Array.from(
    new Set(
      classifications
        .filter((c): c is CandidateClassification & { reason: NotAnalyzableReason } => c.status === "NOT_ANALYZABLE" && c.reason !== null)
        .map((c) => c.reason)
    )
  );

  const status: "ANALYZABLE" | "NOT_ANALYZABLE" = successes.length > 0 || failures.length > 0 ? "ANALYZABLE" : "NOT_ANALYZABLE";
  const outcome: "SUCCESS" | "FAILURE" | null = status === "NOT_ANALYZABLE" ? null : successes.length > 0 ? "SUCCESS" : "FAILURE";

  return {
    assignmentId: assignment.id,
    unitType: assignment.unitType,
    unitKey: assignment.unitKey,
    arm: assignment.arm,
    candidateCount: classifications.length,
    analyzableSuccessCount: successes.length,
    analyzableFailureCount: failures.length,
    maturedUnknownCandidateCount: maturedUnknown.length,
    status,
    outcome,
    recoveredAmount,
    exclusionReasons,
  };
}
