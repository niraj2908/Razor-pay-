import type { ActionType, Prisma, RazorpayPaymentStatus, RecoveryDecision, RiskDiagnosis } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * The Recovery Queue query service (Phase 25 Step 3).
 *
 * A read-only projection over EXISTING domain tables
 * (RevenueRiskEvent/Payment/Decision/CandidateAction) - contains NO
 * decision logic, NO economics, NO statistics. It only shapes an
 * already-persisted, already-merchant-scoped query into a stable response
 * DTO. The route handler is expected to have already resolved and
 * authorized `merchantId` before calling this - this function trusts its
 * `merchantId` argument completely and applies it directly in the WHERE
 * clause (never fetch-then-filter-in-app-code), which is what actually
 * makes cross-merchant leakage structurally impossible here, not merely
 * checked after the fact.
 *
 * RevenueRiskEvent (not Decision) is the anchor: it is the one row per
 * "situation needing attention," which is what an operational queue
 * actually enumerates - a Decision is downstream context for that
 * situation, not the queue's own unit.
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export type RecoveryQueueStatusFilter = "open" | "resolved" | "all";
export type RecoveryQueueSort = "detectedAt_asc" | "detectedAt_desc" | "amountAtRisk_desc";

const VALID_STATUS_FILTERS: readonly RecoveryQueueStatusFilter[] = ["open", "resolved", "all"];
const VALID_SORTS: readonly RecoveryQueueSort[] = ["detectedAt_asc", "detectedAt_desc", "amountAtRisk_desc"];
const VALID_DIAGNOSES: readonly RiskDiagnosis[] = [
  "CONFIRMED_FAILURE",
  "PENDING",
  "STATE_UNCERTAIN",
  "CUSTOMER_ABANDONMENT",
  "NETWORK_DEGRADATION",
  "OTHER_RECOVERABLE",
];
const VALID_DECISION_TYPES: readonly RecoveryDecision[] = ["ACT", "WAIT", "STOP", "ESCALATE"];

export function isValidStatusFilter(value: unknown): value is RecoveryQueueStatusFilter {
  return typeof value === "string" && (VALID_STATUS_FILTERS as readonly string[]).includes(value);
}
export function isValidSort(value: unknown): value is RecoveryQueueSort {
  return typeof value === "string" && (VALID_SORTS as readonly string[]).includes(value);
}
export function isValidDiagnosis(value: unknown): value is RiskDiagnosis {
  return typeof value === "string" && (VALID_DIAGNOSES as readonly string[]).includes(value);
}
export function isValidDecisionType(value: unknown): value is RecoveryDecision {
  return typeof value === "string" && (VALID_DECISION_TYPES as readonly string[]).includes(value);
}

/** cuid()-shaped: lowercase alphanumeric, a sane bounded length. Rejects
 * obviously-malformed input before it ever reaches a database query -
 * never itself the security boundary (the merchant WHERE clause is), just
 * cheap early validation. */
export function isPlausibleId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{1,40}$/i.test(value);
}

export type RecoveryQueueQuery = {
  status?: RecoveryQueueStatusFilter;
  diagnosis?: RiskDiagnosis;
  decisionType?: RecoveryDecision;
  sort?: RecoveryQueueSort;
  cursor?: string;
  limit?: number;
};

export type RecoveryQueueItem = {
  id: string;
  detectedAt: string;
  resolvedAt: string | null;
  diagnosis: RiskDiagnosis;
  amountAtRiskPaise: number;
  naturalRecoveryProbability: number | null;
  payment: {
    id: string;
    status: RazorpayPaymentStatus;
    method: string | null;
    amountPaise: number;
    currency: string;
  };
  decision: {
    id: string;
    decisionType: RecoveryDecision;
    decidedAt: string;
    expectedIncrementalValuePaise: number | null;
    chosenAction: { actionType: ActionType; predictedSuccessProbability: number } | null;
  } | null;
};

export type RecoveryQueueResult = { items: RecoveryQueueItem[]; nextCursor: string | null };

function resolvedFilter(status: RecoveryQueueStatusFilter): Prisma.RevenueRiskEventWhereInput {
  if (status === "open") return { resolvedAt: null };
  if (status === "resolved") return { resolvedAt: { not: null } };
  return {};
}

function orderBy(sort: RecoveryQueueSort): Prisma.RevenueRiskEventOrderByWithRelationInput[] {
  switch (sort) {
    case "detectedAt_desc":
      return [{ detectedAt: "desc" }, { id: "asc" }];
    case "amountAtRisk_desc":
      return [{ amountAtRisk: "desc" }, { id: "asc" }];
    case "detectedAt_asc":
    default:
      return [{ detectedAt: "asc" }, { id: "asc" }];
  }
}

/**
 * Lists this merchant's Recovery Queue, cursor-paginated. `merchantId` MUST
 * already be the caller's own authorized merchant (see this module's own
 * doc comment) - this function has no way to verify that itself and does
 * not attempt to; enforcing that is the route handler's job via
 * authenticateOperator()/resolveMerchantAccess().
 */
export async function listRecoveryQueue(merchantId: string, query: RecoveryQueueQuery): Promise<RecoveryQueueResult> {
  const status = query.status ?? "open";
  const sort = query.sort ?? "detectedAt_asc";
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const where: Prisma.RevenueRiskEventWhereInput = {
    merchantId,
    ...resolvedFilter(status),
    ...(query.diagnosis ? { diagnosis: query.diagnosis } : {}),
    ...(query.decisionType ? { decisions: { some: { decisionType: query.decisionType } } } : {}),
  };

  const rows = await prisma.revenueRiskEvent.findMany({
    where,
    orderBy: orderBy(sort),
    take: limit + 1, // one extra row to detect "is there a next page" without a second count query
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: {
      payment: true,
      decisions: {
        orderBy: { decidedAt: "desc" },
        take: 1,
        include: { chosenAction: true },
      },
    },
  });

  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

  const items: RecoveryQueueItem[] = pageRows.map((row) => {
    const decision = row.decisions[0] ?? null;
    return {
      id: row.id,
      detectedAt: row.detectedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      diagnosis: row.diagnosis,
      amountAtRiskPaise: row.amountAtRisk,
      naturalRecoveryProbability: row.naturalRecoveryProbability,
      payment: {
        id: row.payment.id,
        status: row.payment.status,
        method: row.payment.method,
        amountPaise: row.payment.amount,
        currency: row.payment.currency,
      },
      decision: decision
        ? {
            id: decision.id,
            decisionType: decision.decisionType,
            decidedAt: decision.decidedAt.toISOString(),
            expectedIncrementalValuePaise: decision.expectedIncrementalValue ?? null,
            chosenAction: decision.chosenAction
              ? { actionType: decision.chosenAction.actionType, predictedSuccessProbability: decision.chosenAction.predictedSuccessProbability }
              : null,
          }
        : null,
    };
  });

  return { items, nextCursor: hasNextPage ? pageRows[pageRows.length - 1].id : null };
}
