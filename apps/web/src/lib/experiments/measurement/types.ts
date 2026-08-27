/**
 * Shared domain types for the Phase 24 measurement layer.
 *
 * These are deliberately DB-independent - the orchestrator
 * (experimentResultService.ts) is the only place that knows how to build
 * them from Prisma rows, mirroring the split already used for
 * outcomes/attributionEngine.ts and experiments/assignmentEngine.ts.
 */

export type ExperimentGroupValue = "CONTROL" | "TREATMENT";
export type AssignmentUnitValue = "CUSTOMER" | "CANDIDATE";
export type OutcomeStatusValue = "PENDING" | "RECOVERED" | "NOT_RECOVERED";
export type AttributionStatusValue = "NATURAL_RECOVERY" | "INTERVENTION_RECOVERY" | "UNKNOWN" | null;

export type CandidateOutcomeRecord = {
  status: OutcomeStatusValue;
  attributionStatus: AttributionStatusValue;
  recoveredAmount: number | null; // paise
} | null;

/** Presence alone (any row, regardless of its own status) is what matters
 * for CONTROL-contamination detection - see eligibility.ts. */
export type CandidateExecutionRecord = {
  status: string; // ExecutionStatus: PENDING | SUCCEEDED | FAILED | AMBIGUOUS
  actionType: string; // ActionType - used as the attribution window's "strategy" key
} | null;

export type CandidateDecisionRecord = {
  id: string;
  decidedAt: Date;
} | null;

/** One recovery candidate (RevenueRiskEvent) reachable from an assignment. */
export type CandidateRecord = {
  revenueRiskEventId: string;
  decision: CandidateDecisionRecord;
  execution: CandidateExecutionRecord;
  outcome: CandidateOutcomeRecord;
};

export type AssignmentRecord = {
  id: string;
  unitType: AssignmentUnitValue;
  unitKey: string;
  arm: ExperimentGroupValue;
  assignedAt: Date;
  candidates: CandidateRecord[];
};

/** The experiment-level window an assignment must fall within to be
 * considered analyzable - see eligibility.ts's `assignment_outside_experiment_window`. */
export type ExperimentWindowRecord = {
  startedAt: Date | null;
  endedAt: Date | null;
};
