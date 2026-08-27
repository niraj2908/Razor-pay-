import { prisma } from "@/lib/db";
import {
  ASSIGNMENT_ALGORITHM_VERSION,
  AssignmentUnitValue,
  ExperimentGroupValue,
  determineArm,
  determineAssignmentUnit,
} from "./assignmentEngine";

/**
 * The Experiment Assignment Service (Phase 23 Step 5) - the DB-touching
 * orchestrator around the pure assignmentEngine.ts. Responsible for:
 * finding the applicable RUNNING experiment, resolving the assignment unit,
 * enforcing the V1 experiment-overlap policy, checking eligibility, and
 * persisting the assignment idempotently.
 *
 * This module NEVER decides whether to intervene - that remains entirely
 * the Decision Engine's job (decisionEngine.ts), unmodified. This module
 * only decides whether an already-computed decision is ALLOWED to reach
 * execution - see `isExecutionAllowed` below, which is the sole, explicit
 * CONTROL-enforcement boundary.
 */

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

function isUniqueConstraintViolation(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION
  );
}

/**
 * Version tag for the eligibility ruleset applied below, recorded on every
 * new assignment (Section 15/12) so a historical assignment's eligibility
 * reasoning stays reproducible even after this ruleset later changes.
 */
export const ELIGIBILITY_VERSION = "eligibility-v1";

// Payment states for which recovery no longer makes sense at all - matches
// the equivalent checks already used by safetyGate.ts and executionService.ts
// (checkPaymentLinkEligibility). Kept as its own small check here (rather
// than importing those) because THIS check answers a different question:
// "should this candidate be exposed to the experiment at all," not "is it
// safe to execute right now" - the two must stay independently reasoned
// about even though they currently overlap in practice.
const INELIGIBLE_PAYMENT_STATES = new Set(["CAPTURED", "AUTHORIZED", "REFUNDED"]);

export type EligibilityInput = {
  /** Deliberately only pre-decision, pre-outcome facts (Section 11): this
   * type structurally cannot carry a Decision/Execution/Outcome, so
   * eligibility (and therefore assignment) can never be influenced by
   * payment success, recovery outcome, or execution result. */
  paymentState: string;
};

export type EligibilityResult = { eligible: true } | { eligible: false; reasons: string[] };

export function checkCandidateEligibility(input: EligibilityInput): EligibilityResult {
  const reasons: string[] = [];
  if (INELIGIBLE_PAYMENT_STATES.has(input.paymentState)) {
    reasons.push(`payment_state_ineligible:${input.paymentState}`);
  }
  // Merchant eligibility and policy eligibility (Section 12) are not yet
  // implemented in V1 - there is no existing merchant-level experiment
  // opt-out mechanism to check (documented limitation, not an oversight;
  // see the Phase 23 Step 5 final report).
  return reasons.length > 0 ? { eligible: false, reasons } : { eligible: true };
}

/** Only RUNNING experiments may assign new candidates (Section 2). */
export function canAssignNewCandidates(status: string): boolean {
  return status === "RUNNING";
}

export type ExperimentAssignmentRow = {
  id: string;
  experimentId: string;
  unitType: AssignmentUnitValue;
  unitKey: string;
  arm: ExperimentGroupValue;
  assignedAt: Date;
  eligibilityVersion: string;
  assignmentAlgorithm: string;
};

export type ExperimentAssignmentResolution =
  | { outcome: "no_running_experiment" }
  | { outcome: "ineligible"; reasons: string[] }
  /** Section 14: this unit already belongs to a DIFFERENT experiment - V1
   * does not support overlapping experiments, so no new assignment is made
   * rather than building cross-experiment orchestration. */
  | { outcome: "excluded_overlap"; existingExperimentId: string }
  | { outcome: "assigned"; assignment: ExperimentAssignmentRow };

/**
 * Section 8's sole CONTROL-enforcement boundary. This is deliberately a
 * plain, explicit predicate the caller must check before ever building or
 * dispatching an execution command - CONTROL is blocked HERE, structurally,
 * never by relying on the Decision Engine happening to return WAIT.
 */
export function isExecutionAllowed(resolution: ExperimentAssignmentResolution): boolean {
  if (resolution.outcome === "assigned") {
    return resolution.assignment.arm !== "CONTROL";
  }
  // No experiment applies, or the candidate was ineligible/excluded from
  // one - none of those states restrict execution; the Decision Engine's
  // own ACT/WAIT/STOP/ESCALATE result governs exactly as before Step 5.
  return true;
}

async function findApplicableRunningExperiment(merchantId: string): Promise<{
  id: string;
  treatmentAllocationPercent: number;
} | null> {
  // V1 overlap policy (Section 14): if more than one experiment is
  // RUNNING at once FOR THIS MERCHANT, only the earliest-started one
  // accepts new assignments - a simple, explicit, deterministic tie-break
  // rather than building multi-experiment orchestration. This is a
  // documented limitation (see the Phase 23 Step 5 final report), not
  // automatic support for concurrent experiments.
  //
  // Phase 25 Step 5: the `merchantId` filter here is what actually makes
  // Experiment.merchantId (schema) mean something - without it, a
  // per-merchant Experiment field would be inert metadata that a candidate
  // from any merchant could still be assigned across. This is the specific
  // change the Phase 25 Step 1/2B/4 audits identified as the real fix,
  // distinct from and in addition to the schema column itself.
  const experiment = await prisma.experiment.findFirst({
    where: { status: "RUNNING", merchantId },
    orderBy: { startedAt: "asc" },
  });
  if (!experiment) {
    return null;
  }
  return { id: experiment.id, treatmentAllocationPercent: experiment.treatmentAllocationPercent };
}

async function findExistingAssignmentForUnit(
  unitType: AssignmentUnitValue,
  unitKey: string
): Promise<ExperimentAssignmentRow | null> {
  return prisma.experimentAssignment.findFirst({ where: { unitType, unitKey } });
}

async function persistAssignment(
  experimentId: string,
  unitType: AssignmentUnitValue,
  unitKey: string,
  arm: ExperimentGroupValue,
  now: Date
): Promise<ExperimentAssignmentRow> {
  try {
    const created = await prisma.experimentAssignment.create({
      data: {
        experimentId,
        unitType,
        unitKey,
        arm,
        assignedAt: now,
        eligibilityVersion: ELIGIBILITY_VERSION,
        assignmentAlgorithm: ASSIGNMENT_ALGORITHM_VERSION,
      },
    });
    await prisma.auditEvent.create({
      data: {
        entityType: "ExperimentAssignment",
        entityId: created.id,
        action: "experiment_assignment.created",
        actorType: "SYSTEM",
        details: { experimentId, unitType, unitKey, arm, assignmentAlgorithm: ASSIGNMENT_ALGORITHM_VERSION },
      },
    });
    return created;
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) {
      throw error;
    }
    // Section 7: create -> P2002 -> fetch existing, never check-then-insert.
    // Concurrent requests for the same participant converge on exactly one row.
    return prisma.experimentAssignment.findUniqueOrThrow({
      where: { experimentId_unitType_unitKey: { experimentId, unitType, unitKey } },
    });
  }
}

/**
 * Entry point called from candidateBuilder.ts BEFORE the Decision/Execution
 * boundary (Section 11: assignment must happen before intervention, never
 * based on payment success/outcome/execution result - enforced structurally
 * by `EligibilityInput` never being able to carry that information).
 *
 * `candidateKey` is the CANDIDATE-unit fallback key (the recovery
 * candidate's own RevenueRiskEvent id) - callers must pre-generate this id
 * before the RevenueRiskEvent row exists, since assignment must complete
 * first (see candidateBuilder.ts).
 *
 * `merchantId` (Phase 25 Step 5) is the candidate's OWN merchant (the
 * Payment's merchantId) - it restricts which RUNNING experiment can even
 * be considered to ones belonging to that same merchant, so a candidate
 * can never be pulled into another merchant's experiment.
 */
export async function resolveExperimentAssignment(
  input: { customerId: string | null; candidateKey: string; paymentState: string; merchantId: string },
  now: Date = new Date()
): Promise<ExperimentAssignmentResolution> {
  const experiment = await findApplicableRunningExperiment(input.merchantId);
  if (!experiment) {
    return { outcome: "no_running_experiment" };
  }

  const { unitType, unitKey } = determineAssignmentUnit(input.customerId, input.candidateKey);

  const existing = await findExistingAssignmentForUnit(unitType, unitKey);
  if (existing) {
    if (existing.experimentId !== experiment.id) {
      // Section 14: never let a unit already committed to a different
      // experiment be pulled into this one too.
      return { outcome: "excluded_overlap", existingExperimentId: existing.experimentId };
    }
    // Section 13: same experiment, same unit -> reuse the existing arm.
    // Never recomputed, never allowed to switch.
    return { outcome: "assigned", assignment: existing };
  }

  const eligibility = checkCandidateEligibility({ paymentState: input.paymentState });
  if (!eligibility.eligible) {
    // Section 12: an ineligible candidate gets NO assignment at all - never
    // forced into CONTROL as a fallback.
    return { outcome: "ineligible", reasons: eligibility.reasons };
  }

  const arm = determineArm(experiment.id, unitType, unitKey, experiment.treatmentAllocationPercent);
  const assignment = await persistAssignment(experiment.id, unitType, unitKey, arm, now);
  return { outcome: "assigned", assignment };
}
