import type {
  ActionType,
  AttributionStatus,
  DataSource,
  ExecutionStatus,
  OutcomeStatus,
  RazorpayPaymentStatus,
  RecoveryDecision,
  RiskDiagnosis,
} from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * The Decision Detail query service (Phase 25 Step 3).
 *
 * A read-only projection over EXISTING domain tables - contains NO
 * decision logic, NO economics, NO statistics, and does not call the
 * Decision Engine. Two queries total (never N+1): one deep `include` for
 * the Decision's own relational graph, and one separate lookup of its
 * AuditEvent (a genuinely separate query because AuditEvent is a
 * polymorphic entityType/entityId reference, not a Prisma relation).
 *
 * Merchant scoping happens IN the first query's WHERE clause
 * (`revenueRiskEvent: { merchantId }`), not as an app-code check after
 * fetching - a decision belonging to a different merchant simply never
 * matches and `findFirst` returns null, which the route maps to 404. This
 * is what makes "decision belongs to another merchant" and "decision does
 * not exist" indistinguishable to a caller by design (Phase 25 Step 3
 * Section 11's enumeration-resistance choice).
 *
 * DecisionEvidence is included and returned, but is honestly reported as
 * currently always empty - no code path in this repository writes to it
 * (verified by inspection before this file was written). "Policy
 * version"/"model version" are NOT their own columns anywhere; the only
 * place they exist is inside the "Decision"-entityType AuditEvent's
 * `details` JSON (written by candidateBuilder.ts via audit.ts's
 * buildRecoveryAuditEvent) - this service reads ONLY the three specific,
 * known-safe fields out of that blob (policyVersion, modelVersion, reason)
 * rather than exposing `details` wholesale, since AuditEvent.details has
 * no schema-level shape contract (Phase 25 Step 1 audit finding).
 */

export type DecisionDetailOutcome =
  | { status: "found"; decision: DecisionDetailDTO }
  | { status: "not_found" };

export type DecisionDetailDTO = {
  id: string;
  decisionType: RecoveryDecision;
  decidedAt: string;
  expectedIncrementalValuePaise: number | null;
  chosenAction: {
    id: string;
    actionType: ActionType;
    predictedSuccessProbability: number;
    incrementalLift: number;
    estimatedCostPaise: number;
    expectedNetValuePaise: number;
  } | null;
  revenueRiskEvent: {
    id: string;
    diagnosis: RiskDiagnosis;
    amountAtRiskPaise: number;
    naturalRecoveryProbability: number | null;
    detectedAt: string;
    resolvedAt: string | null;
    dataSource: DataSource;
  };
  payment: {
    id: string;
    razorpayPaymentId: string | null;
    amountPaise: number;
    currency: string;
    method: string | null;
    status: RazorpayPaymentStatus;
    createdAt: string;
  };
  modelPredictions: Array<{
    modelName: string;
    modelVersion: string;
    predictedValue: number;
    predictedAt: string;
  }>;
  /** Null when no matching AuditEvent exists (should not ordinarily
   * happen for a decision created via the normal pipeline, but this
   * service never assumes that guarantee holds). */
  decisionContext: { policyVersion: string | null; modelVersion: string | null; reason: string | null } | null;
  /** Always [] today - see this module's doc comment. Returned as a real
   * (empty) array, never fabricated placeholder content. */
  decisionDrivers: Array<{ evidenceType: string; label: string; value: string | null; passed: boolean | null }>;
  execution: {
    id: string;
    actionType: ActionType;
    status: ExecutionStatus;
    razorpayReferenceId: string | null;
    executedAt: string;
    completedAt: string | null;
  } | null;
  outcome: {
    id: string;
    status: OutcomeStatus;
    attributionStatus: AttributionStatus | null;
    recoveredAmountPaise: number | null;
    observedAt: string;
  } | null;
  /** A reference only (the audit row's own id) - never the raw AuditEvent,
   * which could in principle carry more than the three fields already
   * surfaced in `decisionContext`. */
  auditEventId: string | null;
};

/**
 * Finds the most recent decision associated with a payment reference
 * (Phase 28C AI Assistant addition, additive - never modifies
 * `getDecisionDetail`'s existing contract). A "payment reference" is
 * either our own `Payment.id` or the Razorpay-issued
 * `Payment.razorpayPaymentId` - both are things an operator could
 * plausibly type or paste, unlike an internal `RevenueRiskEvent.id`.
 * Merchant-scoped identically to every other lookup in this file: the
 * WHERE clause itself is the isolation boundary, never an app-code filter
 * after a broader fetch.
 */
export async function findDecisionIdByPaymentReference(merchantId: string, reference: string): Promise<string | null> {
  const decision = await prisma.decision.findFirst({
    where: {
      revenueRiskEvent: {
        merchantId,
        payment: { OR: [{ id: reference }, { razorpayPaymentId: reference }] },
      },
    },
    orderBy: { decidedAt: "desc" },
    select: { id: true },
  });
  return decision?.id ?? null;
}

function extractDecisionContext(details: unknown): { policyVersion: string | null; modelVersion: string | null; reason: string | null } {
  const record = typeof details === "object" && details !== null ? (details as Record<string, unknown>) : {};
  return {
    policyVersion: typeof record.policyVersion === "string" ? record.policyVersion : null,
    modelVersion: typeof record.modelVersion === "string" ? record.modelVersion : null,
    reason: typeof record.reason === "string" ? record.reason : null,
  };
}

/**
 * Fetches one decision's full detail, scoped to `merchantId` (see this
 * module's doc comment for why that scoping happens in the query itself).
 * `merchantId` MUST already be the caller's own authorized merchant - this
 * function trusts it completely, exactly like `listRecoveryQueue`.
 */
export async function getDecisionDetail(merchantId: string, decisionId: string): Promise<DecisionDetailOutcome> {
  const decision = await prisma.decision.findFirst({
    where: {
      id: decisionId,
      revenueRiskEvent: { merchantId },
    },
    include: {
      revenueRiskEvent: {
        include: {
          payment: true,
          modelPredictions: true,
        },
      },
      chosenAction: true,
      evidence: true,
      executions: true,
      outcome: true,
    },
  });

  if (!decision) {
    return { status: "not_found" };
  }

  const auditEvent = await prisma.auditEvent.findFirst({
    where: { entityType: "Decision", entityId: decision.id },
    orderBy: { createdAt: "desc" },
  });

  const execution = decision.executions[0] ?? null; // schema types this as an array; Execution.decisionId is @unique, so at most one exists in practice

  return {
    status: "found",
    decision: {
      id: decision.id,
      decisionType: decision.decisionType,
      decidedAt: decision.decidedAt.toISOString(),
      expectedIncrementalValuePaise: decision.expectedIncrementalValue ?? null,
      chosenAction: decision.chosenAction
        ? {
            id: decision.chosenAction.id,
            actionType: decision.chosenAction.actionType,
            predictedSuccessProbability: decision.chosenAction.predictedSuccessProbability,
            incrementalLift: decision.chosenAction.incrementalLift,
            estimatedCostPaise: decision.chosenAction.estimatedCost,
            expectedNetValuePaise: decision.chosenAction.expectedNetValue,
          }
        : null,
      revenueRiskEvent: {
        id: decision.revenueRiskEvent.id,
        diagnosis: decision.revenueRiskEvent.diagnosis,
        amountAtRiskPaise: decision.revenueRiskEvent.amountAtRisk,
        naturalRecoveryProbability: decision.revenueRiskEvent.naturalRecoveryProbability,
        detectedAt: decision.revenueRiskEvent.detectedAt.toISOString(),
        resolvedAt: decision.revenueRiskEvent.resolvedAt?.toISOString() ?? null,
        dataSource: decision.revenueRiskEvent.dataSource,
      },
      payment: {
        id: decision.revenueRiskEvent.payment.id,
        razorpayPaymentId: decision.revenueRiskEvent.payment.razorpayPaymentId,
        amountPaise: decision.revenueRiskEvent.payment.amount,
        currency: decision.revenueRiskEvent.payment.currency,
        method: decision.revenueRiskEvent.payment.method,
        status: decision.revenueRiskEvent.payment.status,
        createdAt: decision.revenueRiskEvent.payment.createdAt.toISOString(),
      },
      modelPredictions: decision.revenueRiskEvent.modelPredictions.map((p) => ({
        modelName: p.modelName,
        modelVersion: p.modelVersion,
        predictedValue: p.predictedValue,
        predictedAt: p.predictedAt.toISOString(),
      })),
      decisionContext: auditEvent ? extractDecisionContext(auditEvent.details) : null,
      decisionDrivers: decision.evidence.map((e) => ({
        evidenceType: e.evidenceType,
        label: e.label,
        value: e.value,
        passed: e.passed,
      })),
      execution: execution
        ? {
            id: execution.id,
            actionType: execution.actionType,
            status: execution.status,
            razorpayReferenceId: execution.razorpayReferenceId,
            executedAt: execution.executedAt.toISOString(),
            completedAt: execution.completedAt?.toISOString() ?? null,
          }
        : null,
      outcome: decision.outcome
        ? {
            id: decision.outcome.id,
            status: decision.outcome.status,
            attributionStatus: decision.outcome.attributionStatus,
            recoveredAmountPaise: decision.outcome.recoveredAmount,
            observedAt: decision.outcome.observedAt.toISOString(),
          }
        : null,
      auditEventId: auditEvent?.id ?? null,
    },
  };
}
