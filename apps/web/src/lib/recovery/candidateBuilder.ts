import { randomUUID } from "node:crypto";
import type { ActionType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { evaluateRecoveryDecision } from "./decisionEngine";
import { buildRecoveryAuditEvent } from "./audit";
import { buildExecutionCommand, receiveExecutionCommand } from "./execution";
import { PaymentMethod, PaymentState, RecoveryContext, Strategy } from "./types";
import { mapRazorpayFailureToReason } from "./failureReasonMapping";
import { isExecutionAllowed, resolveExperimentAssignment } from "@/lib/experiments/experimentService";

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
 * Diagnoses the payment from the failure signals Razorpay actually sent,
 * which `paymentAssociation.ts` now copies onto the Payment row. A payment
 * carrying no usable signal still diagnoses as STATE_UNCERTAIN - the same
 * honest "we don't know yet" category this defaulted to unconditionally
 * before the columns existed.
 *
 * Retry and contact history are still not tracked per payment, so those
 * remain fixed here; they are the next thing this function should stop
 * guessing about.
 */
function contextFromPayment(payment: {
  id: string;
  merchantId: string;
  amount: number;
  method: string | null;
  status: string;
  errorCode: string | null;
  errorReason: string | null;
  errorSource: string | null;
  errorStep: string | null;
}): RecoveryContext {
  return {
    paymentId: payment.id,
    merchantId: payment.merchantId,
    amount: payment.amount,
    paymentMethod: (payment.method as PaymentMethod | null) ?? "other",
    paymentState: mapPaymentStatus(payment.status),
    failureReason: mapRazorpayFailureToReason({
      errorCode: payment.errorCode,
      errorReason: payment.errorReason,
      errorSource: payment.errorSource,
      errorStep: payment.errorStep,
    }),
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

  // Pre-generated so it can serve as the CANDIDATE-unit experiment
  // assignment key (Phase 23 Step 5) BEFORE the RevenueRiskEvent row that
  // will eventually carry this same id even exists - assignment must
  // complete first (Section 11: assignment before intervention), and the
  // RevenueRiskEvent row is created with this id explicitly below instead
  // of relying on Prisma's default cuid() generation.
  const revenueRiskEventId = randomUUID();

  // A genuinely separate, PRECEDING database round trip (not nested inside
  // the transaction below) - this is what guarantees the experiment
  // assignment's `assignedAt` is never later than the Decision's
  // `decidedAt` created a few lines further down (Section 11), and it is
  // what lets a CONTROL assignment structurally block the execution
  // command further below, regardless of what the Decision Engine itself
  // recommends (Section 8) - never by hoping the engine returns WAIT.
  const experimentResolution = await resolveExperimentAssignment({
    customerId: payment.customerId,
    candidateKey: revenueRiskEventId,
    paymentState: payment.status,
    merchantId: payment.merchantId,
  });
  const experimentAssignmentId =
    experimentResolution.outcome === "assigned" ? experimentResolution.assignment.id : null;

  await prisma.$transaction(async (tx) => {
    const riskEvent = await tx.revenueRiskEvent.create({
      data: {
        id: revenueRiskEventId,
        merchantId: payment.merchantId,
        paymentId: payment.id,
        diagnosis: context.failureReason,
        amountAtRisk: context.amount,
        naturalRecoveryProbability: trace.naturalRecoveryProbability,
        dataSource: "REAL_RAZORPAY_TEST_MODE",
        experimentAssignmentId,
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
    // The Decision Engine's own ACT result is NEVER itself sufficient to
    // execute (Phase 23 Step 5, Section 8/9): a CONTROL assignment blocks
    // dispatch here unconditionally, and a TREATMENT (or no-experiment)
    // assignment only means "eligible for normal evaluation" - safety and
    // policy, already applied inside evaluateRecoveryDecision above, remain
    // fully authoritative either way.
    if (isExecutionAllowed(experimentResolution)) {
      receiveExecutionCommand(command);
    } else {
      console.log("[experiments] execution command suppressed - CONTROL arm", {
        decisionId: trace.decisionId,
        paymentId: payment.id,
      });
    }
  }

  return { status: "evaluated", decisionId: trace.decisionId, selectedAction: trace.selectedAction };
}
