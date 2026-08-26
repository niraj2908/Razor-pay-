import type { ActionType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { evaluateRecoveryDecision } from "./decisionEngine";
import { buildRecoveryAuditEvent } from "./audit";
import { buildExecutionCommand, receiveExecutionCommand } from "./execution";
import { FailureReason, PaymentMethod, PaymentState, RecoveryContext, Strategy } from "./types";

export type CandidateBuildResult =
  | { status: "skipped_not_found" }
  | { status: "skipped_fixture" }
  | { status: "skipped_unlinked_payment" }
  | { status: "evaluated"; decisionId: string; selectedAction: string };

function mapPaymentStatus(status: string): PaymentState {
  switch (status) {
    case "CAPTURED":
      return "captured";
    case "AUTHORIZED":
      return "authorized";
    case "CREATED":
      return "pending";
    default:
      return "failed";
  }
}

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

/**
 * Payment doesn't yet store a structured failure reason (only
 * RazorpayPaymentStatus) or retry/contact history, so this defaults to the
 * most honest "we don't know yet" category rather than guessing. Once the
 * webhook route captures a real failure reason, this mapping is the only
 * place that needs to change.
 */
function contextFromPayment(payment: {
  id: string;
  merchantId: string;
  amount: number;
  method: string | null;
  status: string;
}): RecoveryContext {
  return {
    paymentId: payment.id,
    merchantId: payment.merchantId,
    amount: payment.amount,
    paymentMethod: (payment.method as PaymentMethod | null) ?? "other",
    paymentState: mapPaymentStatus(payment.status),
    failureReason: "STATE_UNCERTAIN" as FailureReason,
    retryCount: 0,
    minutesSinceLastAttempt: 9999,
    customerContactCount: 0,
    hasPendingExecution: false,
    activeIncident: false,
  };
}

/**
 * Entry point called from the webhook processing boundary (processing/
 * queue.ts) - never from the webhook request/response cycle itself. Reads
 * the persisted PaymentEvent, filters out the marked Test Mode fixtures
 * (Phase 21.14), and - once Payment linkage exists (it doesn't yet:
 * PaymentEvent.paymentId is always null today, see route.ts) - runs the
 * pure decision engine and persists a full trace into the EXISTING schema
 * (RevenueRiskEvent/ModelPrediction/CandidateAction/Decision/AuditEvent -
 * no new tables).
 *
 * Never executes a recovery action - only decides and records. See
 * execution.ts for the command boundary, which logs intent but does not
 * call the Razorpay adapter (Phase 21.15 defers that to a later phase).
 *
 * Fails safe: any DB/lookup problem returns a skip status rather than
 * throwing, so a recovery-engine failure can never surface as (or be
 * mistaken for) a financial action.
 */
export async function buildRecoveryCandidateFromPaymentEvent(
  paymentEventId: string
): Promise<CandidateBuildResult> {
  const event = await prisma.paymentEvent.findUnique({ where: { id: paymentEventId } });
  if (!event) {
    return { status: "skipped_not_found" };
  }

  const payload = event.payload as { _test_fixture?: { isTestFixture?: boolean } } | null;
  if (payload?._test_fixture?.isTestFixture === true) {
    return { status: "skipped_fixture" };
  }

  if (!event.paymentId) {
    return { status: "skipped_unlinked_payment" };
  }

  const payment = await prisma.payment.findUnique({ where: { id: event.paymentId } });
  if (!payment) {
    return { status: "skipped_unlinked_payment" };
  }

  const context = contextFromPayment(payment);
  const trace = evaluateRecoveryDecision(context);
  const audit = buildRecoveryAuditEvent(trace);

  await prisma.$transaction(async (tx) => {
    const riskEvent = await tx.revenueRiskEvent.create({
      data: {
        merchantId: payment.merchantId,
        paymentId: payment.id,
        diagnosis: context.failureReason,
        amountAtRisk: context.amount,
        naturalRecoveryProbability: trace.naturalRecoveryProbability,
        dataSource: "REAL_RAZORPAY_TEST_MODE",
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
          },
        })
      )
    );

    const chosenAction = trace.selectedStrategy
      ? candidateActionRows[
          trace.candidateStrategies.findIndex((e) => e.strategy === trace.selectedStrategy)
        ]
      : null;

    const decision = await tx.decision.create({
      data: {
        revenueRiskEventId: riskEvent.id,
        decisionType: trace.selectedAction,
        chosenActionId: chosenAction?.id ?? null,
        expectedIncrementalValue:
          trace.expectedValues[trace.selectedStrategy ?? trace.candidateStrategies[0].strategy],
      },
    });

    await tx.auditEvent.create({
      data: {
        merchantId: payment.merchantId,
        entityType: "Decision",
        entityId: decision.id,
        action: `decision.${trace.selectedAction.toLowerCase()}`,
        actorType: "SYSTEM",
        details: audit,
      },
    });
  });

  const command = buildExecutionCommand(trace);
  if (command) {
    receiveExecutionCommand(command);
  }

  return { status: "evaluated", decisionId: trace.decisionId, selectedAction: trace.selectedAction };
}
