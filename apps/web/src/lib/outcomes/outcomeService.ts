import { prisma } from "@/lib/db";
import {
  AttributionContext,
  DEFAULT_ATTRIBUTION_POLICY,
  evaluateOutcomeAttribution,
  isAttributionWindowClosed,
  AttributionPolicy,
} from "./attributionEngine";

export type OutcomeProcessingResult =
  | { status: "skipped_not_found" }
  | { status: "skipped_fixture" }
  | { status: "skipped_unlinked" }
  | { status: "no_relevant_decisions" }
  | { status: "processed"; decisionResults: DecisionOutcomeResult[] };

export type DecisionOutcomeResult =
  | { status: "skipped_terminal"; decisionId: string; outcomeId: string }
  | { status: "created"; decisionId: string; outcomeId: string; outcomeStatus: string }
  | { status: "updated"; decisionId: string; outcomeId: string; outcomeStatus: string };

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

function isUniqueConstraintViolation(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION
  );
}

async function audit(outcomeId: string, action: string, details: Record<string, unknown>): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      entityType: "Outcome",
      entityId: outcomeId,
      action,
      actorType: "SYSTEM",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      details: details as any,
    },
  });
}

/**
 * Gathers evidence for one Decision and runs it through the pure engine,
 * then idempotently persists the result (Phase 23 Step 4, section 10):
 * always attempts create() first (never check-then-insert), and on a
 * P2002 against Outcome.decisionId's existing unique constraint (Phase 23
 * Step 2), falls back to updating the existing row - UNLESS that row is
 * already RECOVERED, a terminal state that is never regressed, no matter
 * what a later/out-of-order event might otherwise suggest.
 */
async function evaluateAndPersistOutcomeForDecision(
  decisionId: string,
  evidencePaymentEventId: string | null,
  policy: AttributionPolicy,
  now: Date
): Promise<DecisionOutcomeResult> {
  const decision = await prisma.decision.findUniqueOrThrow({
    where: { id: decisionId },
    include: { revenueRiskEvent: true },
  });

  const originalPayment = await prisma.payment.findUniqueOrThrow({
    where: { id: decision.revenueRiskEvent.paymentId },
  });

  const execution = await prisma.execution.findUnique({ where: { decisionId } });
  const recoveredPayment = execution?.recoveredPaymentId
    ? await prisma.payment.findUnique({ where: { id: execution.recoveredPaymentId } })
    : null;

  const strategy = execution?.actionType ?? null;
  const context: AttributionContext = {
    decisionId,
    originalPayment: { status: originalPayment.status, amount: originalPayment.amount },
    execution: execution ? { actionType: execution.actionType, status: execution.status } : null,
    recoveredPayment: recoveredPayment ? { status: recoveredPayment.status, amount: recoveredPayment.amount } : null,
    weakEvidenceOnly: [],
    attributionWindowClosed: isAttributionWindowClosed(decision.decidedAt, strategy, now, policy),
  };

  const result = evaluateOutcomeAttribution(context);

  try {
    const created = await prisma.outcome.create({
      data: {
        decisionId,
        paymentId: originalPayment.id,
        executionId: execution?.id,
        status: result.outcomeStatus,
        attributionStatus: result.attributionStatus ?? undefined,
        recoveredAmount: result.recoveredAmount ?? undefined,
        attributionPolicyVersion: policy.version,
        evidencePaymentEventId: evidencePaymentEventId ?? undefined,
      },
    });
    await audit(created.id, "outcome.created", {
      decisionId,
      outcomeStatus: result.outcomeStatus,
      attributionStatus: result.attributionStatus,
      reason: result.reason,
      attributionPolicyVersion: policy.version,
    });
    return { status: "created", decisionId, outcomeId: created.id, outcomeStatus: result.outcomeStatus };
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) {
      throw error;
    }

    const existing = await prisma.outcome.findUniqueOrThrow({ where: { decisionId } });
    if (existing.status === "RECOVERED") {
      // Terminal - never regress a confirmed recovery, regardless of what a
      // later/out-of-order event might otherwise seem to suggest.
      return { status: "skipped_terminal", decisionId, outcomeId: existing.id };
    }

    const updated = await prisma.outcome.update({
      where: { id: existing.id },
      data: {
        status: result.outcomeStatus,
        attributionStatus: result.attributionStatus,
        recoveredAmount: result.recoveredAmount,
        evidencePaymentEventId: evidencePaymentEventId ?? existing.evidencePaymentEventId,
      },
    });
    await audit(updated.id, "outcome.updated", {
      decisionId,
      outcomeStatus: result.outcomeStatus,
      attributionStatus: result.attributionStatus,
      reason: result.reason,
      attributionPolicyVersion: policy.version,
    });
    return { status: "updated", decisionId, outcomeId: updated.id, outcomeStatus: result.outcomeStatus };
  }
}

/**
 * Entry point called from the processing boundary (processing/queue.ts),
 * after payment association has run - never from the webhook route/
 * response cycle. Finds every Decision this PaymentEvent's (now-linked)
 * Payment could affect - as the ORIGINAL payment of an execution, as the
 * RECOVERED payment of an execution, or (no execution at all) via the
 * RevenueRiskEvent's own paymentId - and re-evaluates each one.
 */
export async function processOutcomeAttributionForPaymentEvent(
  paymentEventId: string,
  policy: AttributionPolicy = DEFAULT_ATTRIBUTION_POLICY,
  now: Date = new Date()
): Promise<OutcomeProcessingResult> {
  const event = await prisma.paymentEvent.findUnique({ where: { id: paymentEventId } });
  if (!event) {
    return { status: "skipped_not_found" };
  }

  const payload = event.payload as { _test_fixture?: { isTestFixture?: boolean } } | null;
  if (payload?._test_fixture?.isTestFixture === true) {
    return { status: "skipped_fixture" };
  }

  if (!event.paymentId) {
    return { status: "skipped_unlinked" };
  }

  const [executionsAsOriginal, executionsAsRecovered, riskEvents] = await Promise.all([
    prisma.execution.findMany({ where: { paymentId: event.paymentId } }),
    prisma.execution.findMany({ where: { recoveredPaymentId: event.paymentId } }),
    prisma.revenueRiskEvent.findMany({
      where: { paymentId: event.paymentId },
      include: { decisions: true },
    }),
  ]);

  const decisionIds = new Set<string>([
    ...executionsAsOriginal.map((e) => e.decisionId),
    ...executionsAsRecovered.map((e) => e.decisionId),
    ...riskEvents.flatMap((r) => r.decisions.map((d) => d.id)),
  ]);

  if (decisionIds.size === 0) {
    return { status: "no_relevant_decisions" };
  }

  const decisionResults: DecisionOutcomeResult[] = [];
  for (const decisionId of decisionIds) {
    decisionResults.push(await evaluateAndPersistOutcomeForDecision(decisionId, event.id, policy, now));
  }

  return { status: "processed", decisionResults };
}
