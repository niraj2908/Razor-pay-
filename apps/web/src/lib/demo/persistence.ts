import type { ActionType, RiskDiagnosis } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { RecoveryDecisionTrace } from "@/lib/recovery/decisionEngine";
import { buildRecoveryAuditEvent } from "@/lib/recovery/audit";
import type { Strategy } from "@/lib/recovery/types";

/**
 * Shared persistence helpers for the Demo Workspace seed (Phase 28B).
 *
 * These mirror the EXACT row shapes `candidateBuilder.ts` and
 * `executionService.ts` already write to the existing schema - no new
 * tables, no new columns, no different `details` shape on any AuditEvent.
 * The only reason this is a separate module (rather than calling those
 * files' own exported functions) is their input contracts: both are built
 * around a persisted `PaymentEvent`/webhook-shaped entry point, whereas the
 * seed constructs a `RecoveryDecisionTrace` directly from a hand-built
 * `RecoveryContext` (see scenarios.ts's own doc comment on why the real
 * webhook-driven `buildRecoveryCandidateFromPaymentEvent` cannot currently
 * produce anything but STATE_UNCERTAIN/ESCALATE - a genuine, pre-existing
 * gap, not something this module works around).
 *
 * What IS reused directly, unmodified: `buildRecoveryAuditEvent` (the real
 * audit-shape builder) here, and `outcomeService.processOutcomeAttributionForPaymentEvent`
 * (the real, DB-driven attribution orchestrator) in seedDemoWorkspace.ts.
 */

function mapStrategyToActionType(strategy: Strategy): ActionType {
  switch (strategy) {
    case "RETRY":
      return "RETRY_NOW";
    case "PAYMENT_LINK":
      return "PAYMENT_LINK";
    case "OTHER_ALLOWED_STRATEGY":
      return "CUSTOMER_CONTACT";
  }
}

export type PersistedDecision = {
  revenueRiskEventId: string;
  decisionId: string;
  chosenActionId: string | null;
};

/**
 * Persists one already-computed `RecoveryDecisionTrace` into
 * RevenueRiskEvent/ModelPrediction/CandidateAction/Decision/AuditEvent -
 * field-for-field the same shape `candidateBuilder.ts`'s own transaction
 * writes for a real webhook-derived candidate. `revenueRiskEventId` is
 * caller-supplied (a fixed, deterministic demo id) rather than
 * `randomUUID()`, so re-running the seed after a reset reproduces byte-
 * identical rows - `candidateBuilder.ts` itself is never modified to
 * support this; this is a seed-only concern.
 */
export async function persistDemoDecision(params: {
  revenueRiskEventId: string;
  merchantId: string;
  paymentId: string;
  amountAtRiskPaise: number;
  /** The real `FailureReason` the seed built the context with - a
   * `RecoveryDecisionTrace` does not itself carry this back, so the caller
   * (which constructed the context) supplies it explicitly rather than
   * having this function guess it from the trace's `reason` string. */
  diagnosis: RiskDiagnosis;
  trace: RecoveryDecisionTrace;
  detectedAt: Date;
  decidedAt: Date;
  experimentAssignmentId: string | null;
}): Promise<PersistedDecision> {
  const { trace } = params;
  const audit = buildRecoveryAuditEvent(trace);

  return prisma.$transaction(async (tx) => {
    const riskEvent = await tx.revenueRiskEvent.create({
      data: {
        id: params.revenueRiskEventId,
        merchantId: params.merchantId,
        paymentId: params.paymentId,
        diagnosis: params.diagnosis,
        amountAtRisk: params.amountAtRiskPaise,
        naturalRecoveryProbability: trace.naturalRecoveryProbability,
        detectedAt: params.detectedAt,
        dataSource: "SIMULATED",
        experimentAssignmentId: params.experimentAssignmentId,
      },
    });

    await Promise.all(
      trace.candidateStrategies.map((evaluation) =>
        tx.modelPrediction.create({
          data: {
            revenueRiskEventId: riskEvent.id,
            modelName: "intervention_response",
            modelVersion: evaluation.intervention.modelVersion,
            predictedValue: evaluation.intervention.probability,
            inputFeatures: { strategy: evaluation.strategy },
            predictedAt: params.decidedAt,
          },
        })
      )
    );

    const candidateActionRows = await Promise.all(
      trace.candidateStrategies.map((evaluation) =>
        tx.candidateAction.create({
          data: {
            revenueRiskEventId: riskEvent.id,
            actionType: mapStrategyToActionType(evaluation.strategy),
            predictedSuccessProbability: evaluation.intervention.probability,
            incrementalLift: evaluation.economics.incrementalRecoveryProbability,
            estimatedCost: 0,
            expectedNetValue: evaluation.economics.expectedIncrementalValue,
            createdAt: params.decidedAt,
          },
        })
      )
    );

    const chosenAction = trace.selectedStrategy
      ? candidateActionRows[trace.candidateStrategies.findIndex((e) => e.strategy === trace.selectedStrategy)]
      : null;

    const decision = await tx.decision.create({
      data: {
        revenueRiskEventId: riskEvent.id,
        decisionType: trace.selectedAction,
        chosenActionId: chosenAction?.id ?? null,
        expectedIncrementalValue:
          trace.expectedValues[trace.selectedStrategy ?? trace.candidateStrategies[0].strategy],
        decidedAt: params.decidedAt,
      },
    });

    await tx.auditEvent.create({
      data: {
        merchantId: params.merchantId,
        entityType: "Decision",
        entityId: decision.id,
        action: `decision.${trace.selectedAction.toLowerCase()}`,
        actorType: "SYSTEM",
        details: audit,
        createdAt: params.decidedAt,
      },
    });

    return { revenueRiskEventId: riskEvent.id, decisionId: decision.id, chosenActionId: chosenAction?.id ?? null };
  });
}

export type SyntheticExecutionResult = {
  executionId: string;
};

/**
 * Persists a synthetic Execution row plus its `execution.requested` and
 * terminal (`execution.succeeded`/`execution.failed`) AuditEvents - the
 * exact shapes `executionService.ts` itself writes. No Razorpay call is
 * made (see this module's own doc comment on why: a live network call
 * would make the seed non-deterministic and depend on external, currently-
 * flaky infrastructure - see the Phase 28B report). Every synthetic
 * identifier is prefixed `DEMO` so it can never be mistaken for a real
 * Razorpay object.
 */
export async function persistSyntheticExecution(params: {
  decisionId: string;
  paymentId: string;
  strategy: "PAYMENT_LINK";
  status: "SUCCEEDED" | "FAILED";
  razorpayReferenceId: string | null;
  executedAt: Date;
  completedAt: Date;
}): Promise<SyntheticExecutionResult> {
  const execution = await prisma.execution.create({
    data: {
      decisionId: params.decisionId,
      paymentId: params.paymentId,
      actionType: "PAYMENT_LINK",
      status: "PENDING",
      executedAt: params.executedAt,
    },
  });

  await prisma.auditEvent.create({
    data: {
      entityType: "Execution",
      entityId: execution.id,
      action: "execution.requested",
      actorType: "SYSTEM",
      details: { decisionId: params.decisionId, paymentId: params.paymentId, strategy: "PAYMENT_LINK" },
      createdAt: params.executedAt,
    },
  });

  await prisma.execution.update({
    where: { id: execution.id },
    data: {
      status: params.status,
      razorpayReferenceId: params.razorpayReferenceId ?? undefined,
      completedAt: params.completedAt,
    },
  });

  await prisma.auditEvent.create({
    data: {
      entityType: "Execution",
      entityId: execution.id,
      action: params.status === "SUCCEEDED" ? "execution.succeeded" : "execution.failed",
      actorType: "SYSTEM",
      details:
        params.status === "SUCCEEDED"
          ? { decisionId: params.decisionId, razorpayReferenceId: params.razorpayReferenceId }
          : { decisionId: params.decisionId, errorCategory: "demo_synthetic_non_conversion" },
      createdAt: params.completedAt,
    },
  });

  return { executionId: execution.id };
}
