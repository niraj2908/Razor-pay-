import type { ActorType } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * The Decision Audit Trail query service (Phase 25 Audit API V1, per the
 * approved audit).
 *
 * AuditEvent.merchantId is nullable and, in practice, only ever populated
 * for entityType="Decision" (candidateBuilder.ts). Execution/Outcome/
 * ExperimentAssignment/ExperimentMeasurementResult/PaymentEvent audit rows
 * all have merchantId=null - AuditEvent.entityId is a plain string, not a
 * Prisma relation, so there is no native way to filter it by merchant
 * directly. This service therefore NEVER queries AuditEvent.merchantId.
 * Merchant isolation happens entirely at the parent-Decision lookup below -
 * the exact same query shape decisionDetailService.ts already uses and has
 * already proven safe - and AuditEvent is only ever queried afterwards, by
 * the already-verified (entityType, entityId) pairs that Decision's own
 * `executions`/`outcome` relations produced.
 *
 * V1 exposes ONLY Decision/Execution/Outcome audit rows for one Decision.
 * PaymentEvent and ExperimentAssignment are structurally impossible to
 * return here: this service never queries for them, and their entityIds
 * (a PaymentEvent id, an ExperimentAssignment id) are never among the
 * entityRefs this function builds.
 *
 * `AuditEvent.details` is NEVER serialized wholesale - `sanitizeByEntityType`
 * copies out only an explicit, per-entityType allowlist of scalar fields,
 * verified against every real `auditEvent.create()` call site in this
 * codebase (candidateBuilder.ts, executionService.ts, outcomeService.ts).
 * A field added to `details` in the future is invisible by default; it must
 * be deliberately added to the relevant allowlist below to ever be exposed.
 */

export type AuditEntityType = "Decision" | "Execution" | "Outcome";

const VALID_AUDIT_ENTITY_TYPES: readonly AuditEntityType[] = ["Decision", "Execution", "Outcome"];

export function isValidAuditEntityType(value: unknown): value is AuditEntityType {
  return typeof value === "string" && (VALID_AUDIT_ENTITY_TYPES as readonly string[]).includes(value);
}

export type AuditEventDTO = {
  id: string;
  entityType: AuditEntityType;
  action: string;
  actorType: ActorType;
  createdAt: string;
  /** Sanitized per `sanitizeByEntityType` - never the raw persisted JSON. */
  details: Record<string, unknown>;
};

export type AuditTrailQuery = {
  entityType?: AuditEntityType;
  since?: Date;
  until?: Date;
  cursor?: string;
  limit?: number;
};

export type AuditTrailOutcome =
  | { status: "found"; items: AuditEventDTO[]; nextCursor: string | null }
  | { status: "not_found" };

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

type FieldSpec = "string" | "number" | "boolean" | "string|null";

/**
 * Copies out only the named, type-checked fields present in `raw` - a field
 * not in `allowlist` can never be copied, and a present-but-wrong-typed
 * value (e.g. an unexpected nested object) is silently dropped rather than
 * passed through. This is the actual security boundary: even if a future
 * write site adds a new field to `details`, or an existing field's shape
 * changes unexpectedly, nothing beyond this explicit list can ever reach a
 * response.
 */
function pickScalarFields(raw: unknown, allowlist: Record<string, FieldSpec>): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(allowlist)) {
    const value = record[key];
    if (spec === "string|null") {
      if (value === null || typeof value === "string") result[key] = value;
      continue;
    }
    if (typeof value === spec) {
      result[key] = value;
    }
  }
  return result;
}

// Allowlists verified against the actual `details` object literals written
// by candidateBuilder.ts (via recovery/audit.ts's RecoveryAuditEvent shape)
// - no field here has ever been observed to carry PII, a raw webhook
// payload, a secret, or an internal-only identifier.
const DECISION_DETAILS_ALLOWLIST: Record<string, FieldSpec> = {
  decisionId: "string",
  paymentId: "string",
  selectedAction: "string",
  selectedStrategy: "string|null",
  policyVersion: "string",
  modelVersion: "string",
  reason: "string",
};

// Verified against executionService.ts's `audit()` call sites (13 call
// sites, one shared helper) - amount is integer paise; razorpayReferenceId
// is a non-secret Razorpay object id (a Payment Link/capture id), the same
// class of field already exposed by decisionDetailService.ts's own
// `execution.razorpayReferenceId`.
const EXECUTION_DETAILS_ALLOWLIST: Record<string, FieldSpec> = {
  decisionId: "string",
  paymentId: "string",
  strategy: "string",
  amount: "number",
  razorpayReferenceId: "string",
  errorCategory: "string",
  reason: "string",
  policyVersion: "string",
  decidedAt: "string",
};

// Verified against outcomeService.ts's `audit()` call sites.
const OUTCOME_DETAILS_ALLOWLIST: Record<string, FieldSpec> = {
  decisionId: "string",
  outcomeStatus: "string",
  attributionStatus: "string|null",
  reason: "string",
  attributionPolicyVersion: "string",
};

function sanitizeByEntityType(entityType: AuditEntityType, raw: unknown): Record<string, unknown> {
  switch (entityType) {
    case "Decision":
      return pickScalarFields(raw, DECISION_DETAILS_ALLOWLIST);
    case "Execution":
      return pickScalarFields(raw, EXECUTION_DETAILS_ALLOWLIST);
    case "Outcome":
      return pickScalarFields(raw, OUTCOME_DETAILS_ALLOWLIST);
  }
}

/** Exported (Phase 28C activity-feed addition) so `activityFeedService.ts`
 * can reuse the exact same sanitization discipline for a merchant-wide
 * feed, rather than re-deriving or loosening the per-entityType allowlists
 * above. Behavior is unchanged - this is a visibility change only. */
export function mapAuditEvent(row: {
  id: string;
  entityType: string;
  action: string;
  actorType: ActorType;
  createdAt: Date;
  details: unknown;
}): AuditEventDTO {
  // Safe cast: `row` only ever comes from a query whose WHERE clause
  // restricts entityType to exactly the three values in
  // VALID_AUDIT_ENTITY_TYPES (see getDecisionAuditTrail below).
  const entityType = row.entityType as AuditEntityType;
  return {
    id: row.id,
    entityType,
    action: row.action,
    actorType: row.actorType,
    createdAt: row.createdAt.toISOString(),
    details: sanitizeByEntityType(entityType, row.details),
  };
}

/**
 * Fetches the merged, chronological audit trail across a Decision and its
 * (at most one) Execution and (at most one) Outcome, scoped to
 * `merchantId`. A foreign-merchant or nonexistent `decisionId` both return
 * `{status: "not_found"}` - identical to Decision Detail's own contract
 * (Phase 25 Step 3) - since both cases share this function's single
 * `decision.findFirst` lookup.
 *
 * `merchantId` MUST already be the caller's own authorized merchant (same
 * trust contract as every other query service in this codebase) - this
 * function never verifies it itself.
 */
export async function getDecisionAuditTrail(
  merchantId: string,
  decisionId: string,
  query: AuditTrailQuery
): Promise<AuditTrailOutcome> {
  const decision = await prisma.decision.findFirst({
    where: { id: decisionId, revenueRiskEvent: { merchantId } },
    include: { executions: true, outcome: true },
  });
  if (!decision) {
    return { status: "not_found" };
  }

  const execution = decision.executions[0] ?? null; // Execution.decisionId is @unique

  const entityRefs: Array<{ entityType: AuditEntityType; entityId: string }> = [
    { entityType: "Decision", entityId: decision.id },
  ];
  if (execution) entityRefs.push({ entityType: "Execution", entityId: execution.id });
  if (decision.outcome) entityRefs.push({ entityType: "Outcome", entityId: decision.outcome.id });

  const filteredRefs = query.entityType ? entityRefs.filter((r) => r.entityType === query.entityType) : entityRefs;
  if (filteredRefs.length === 0) {
    // e.g. entityType=Execution requested for a decision with no Execution
    // (WAIT/STOP/ESCALATE) - a real, empty trail, never an error.
    return { status: "found", items: [], nextCursor: null };
  }

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const rows = await prisma.auditEvent.findMany({
    where: {
      OR: filteredRefs.map((r) => ({ entityType: r.entityType, entityId: r.entityId })),
      ...(query.since || query.until
        ? { createdAt: { ...(query.since ? { gte: query.since } : {}), ...(query.until ? { lt: query.until } : {}) } }
        : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

  return {
    status: "found",
    items: pageRows.map(mapAuditEvent),
    nextCursor: hasNextPage ? pageRows[pageRows.length - 1].id : null,
  };
}
