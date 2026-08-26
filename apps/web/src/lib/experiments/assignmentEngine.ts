import { createHash } from "node:crypto";

/**
 * The Experiment Assignment Engine (Phase 23 Step 5).
 *
 * Pure, deterministic, DB-independent - mirrors the outcomes/attributionEngine.ts
 * split: this module only computes an arm from evidence handed to it; all
 * database reads/writes, eligibility lookups, and overlap policy live in
 * experimentService.ts.
 *
 * Core guarantee: the SAME (experimentId, unitType, unitKey, algorithmVersion,
 * treatmentAllocationPercent) always produces the SAME arm, forever - no
 * Math.random(), no process-local random state, no wall-clock input. This is
 * what makes "no treatment switching" and "customer-level assignment reused
 * across candidates" true by construction rather than by convention.
 */

export type AssignmentUnitValue = "CUSTOMER" | "CANDIDATE";
export type ExperimentGroupValue = "CONTROL" | "TREATMENT";

/**
 * Identifies the hashing strategy below. Bump this (e.g. "sha256-v2") only
 * if the algorithm itself changes, and never reuse a version string for a
 * different algorithm - existing ExperimentAssignment rows record which
 * version produced them (Section 16) and must never be reinterpreted under
 * a different one.
 */
export const ASSIGNMENT_ALGORITHM_VERSION = "sha256-v1";

// Bucket space gives 2-decimal-place allocation precision (e.g. a 12%
// treatment split is representable exactly as a 1,200-wide bucket range).
const BUCKET_SPACE = 10_000;

/**
 * Assignment unit resolution (Section 4): CUSTOMER is the primary strategy
 * whenever a stable Customer identity exists; CANDIDATE (keyed by the
 * recovery candidate's own RevenueRiskEvent id) is the fallback for
 * guest/no-stable-customer payments. Merchant-level randomization is never
 * used in V1 - every candidate is keyed to a single customer or a single
 * candidate, never to the whole merchant population at once.
 */
export function determineAssignmentUnit(
  customerId: string | null,
  candidateKey: string
): { unitType: AssignmentUnitValue; unitKey: string } {
  if (customerId) {
    return { unitType: "CUSTOMER", unitKey: customerId };
  }
  return { unitType: "CANDIDATE", unitKey: candidateKey };
}

/**
 * Hash input: `${algorithmVersion}:${experimentId}:${unitType}:${unitKey}`.
 * Hash algorithm: SHA-256 (node:crypto, the same primitive already used for
 * webhook signature verification elsewhere in this codebase - no new
 * dependency). Bucket calculation: the first 8 hex characters of the digest
 * (up to 2^32) reduced mod BUCKET_SPACE into a stable [0, 10000) bucket.
 * Including algorithmVersion in the input means a future algorithm bump
 * naturally reshuffles nothing retroactively - it only changes buckets for
 * NEW hash computations under the new version string.
 */
export function computeAssignmentBucket(
  experimentId: string,
  unitType: AssignmentUnitValue,
  unitKey: string,
  algorithmVersion: string = ASSIGNMENT_ALGORITHM_VERSION
): number {
  const input = `${algorithmVersion}:${experimentId}:${unitType}:${unitKey}`;
  const digest = createHash("sha256").update(input).digest("hex");
  const intValue = parseInt(digest.slice(0, 8), 16);
  return intValue % BUCKET_SPACE;
}

export type AllocationValidation = { valid: boolean; reason?: string };

/**
 * Allocation calculation (Section 6): `treatmentAllocationPercent` is the
 * percentage of assigned units that land in TREATMENT; CONTROL is defined
 * as the complement (100 - treatment), never a second independent field.
 * This makes "treatment + control must sum to 100" true by construction -
 * an impossible-to-misconfigure invariant - rather than a second value to
 * separately validate and reject.
 */
export function validateTreatmentAllocationPercent(percent: number): AllocationValidation {
  if (!Number.isInteger(percent)) {
    return { valid: false, reason: "allocation_must_be_integer" };
  }
  if (percent < 0 || percent > 100) {
    return { valid: false, reason: "allocation_out_of_bounds" };
  }
  return { valid: true };
}

/**
 * hash(experimentId + assignmentUnit + assignmentKey) -> stable bucket ->
 * CONTROL/TREATMENT, exactly as specified. Throws on an invalid allocation
 * rather than silently normalizing it (Section 6) - a misconfigured
 * experiment must fail loudly, not quietly misassign participants.
 */
export function determineArm(
  experimentId: string,
  unitType: AssignmentUnitValue,
  unitKey: string,
  treatmentAllocationPercent: number,
  algorithmVersion: string = ASSIGNMENT_ALGORITHM_VERSION
): ExperimentGroupValue {
  const validation = validateTreatmentAllocationPercent(treatmentAllocationPercent);
  if (!validation.valid) {
    throw new Error(`Invalid treatment allocation percent (${treatmentAllocationPercent}): ${validation.reason}`);
  }

  const bucket = computeAssignmentBucket(experimentId, unitType, unitKey, algorithmVersion);
  const treatmentThreshold = treatmentAllocationPercent * (BUCKET_SPACE / 100);
  return bucket < treatmentThreshold ? "TREATMENT" : "CONTROL";
}
