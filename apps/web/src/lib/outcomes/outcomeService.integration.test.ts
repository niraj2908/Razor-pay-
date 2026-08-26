import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { processOutcomeAttributionForPaymentEvent } from "./outcomeService";

/**
 * Real-database integration tests for Phase 23 Step 4 outcome attribution:
 * concurrency, duplicate-webhook idempotency, and out-of-order-event
 * behavior can only be proven against real Postgres (a mocked Prisma
 * client only proves our own code reacts correctly to a *simulated*
 * race). Run via `pnpm test:integration`, never as part of `pnpm test`.
 *
 * All rows are clearly-marked fixtures, cleaned up in afterAll. The 7
 * existing Test Mode webhook fixtures are never touched or read.
 */

const TAG = `phase23-step4-${randomUUID()}`;
const createdMerchantIds: string[] = [];
const createdExperimentIds: string[] = [];

async function makeCandidate(originalStatus: "FAILED" | "AUTHORIZED" | "CAPTURED" = "FAILED") {
  const merchant = await prisma.merchant.create({ data: { name: `Outcome test merchant ${TAG}` } });
  createdMerchantIds.push(merchant.id);

  const payment = await prisma.payment.create({
    data: { merchantId: merchant.id, amount: 10000, currency: "INR", status: originalStatus },
  });

  const riskEvent = await prisma.revenueRiskEvent.create({
    data: {
      merchantId: merchant.id,
      paymentId: payment.id,
      diagnosis: "CUSTOMER_ABANDONMENT",
      amountAtRisk: 10000,
      dataSource: "SIMULATED",
    },
  });

  const decision = await prisma.decision.create({
    data: { revenueRiskEventId: riskEvent.id, decisionType: "ACT", expectedIncrementalValue: 50 },
  });

  const paymentEvent = await prisma.paymentEvent.create({
    data: { razorpayEventId: `${TAG}-${randomUUID()}`, eventType: "payment.captured", payload: {}, paymentId: payment.id },
  });

  return { merchantId: merchant.id, paymentId: payment.id, riskEventId: riskEvent.id, decisionId: decision.id, paymentEventId: paymentEvent.id };
}

afterAll(async () => {
  await prisma.outcome.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.execution.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.decision.deleteMany({ where: { revenueRiskEvent: { merchantId: { in: createdMerchantIds } } } });
  await prisma.revenueRiskEvent.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.paymentEvent.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.payment.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.experimentAssignment.deleteMany({ where: { experimentId: { in: createdExperimentIds } } });
  await prisma.experiment.deleteMany({ where: { id: { in: createdExperimentIds } } });
  await prisma.$disconnect();
});

describe("processOutcomeAttributionForPaymentEvent against a real database", () => {
  it("9. processing the same PaymentEvent twice never creates a second Outcome", async () => {
    const candidate = await makeCandidate("CAPTURED");

    const first = await processOutcomeAttributionForPaymentEvent(candidate.paymentEventId);
    const second = await processOutcomeAttributionForPaymentEvent(candidate.paymentEventId);

    expect(first.status).toBe("processed");
    expect(second.status).toBe("processed");

    const outcomes = await prisma.outcome.findMany({ where: { decisionId: candidate.decisionId } });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe("RECOVERED");
  }, 20_000);

  it("10. five concurrent attribution attempts for the same Decision converge on exactly one Outcome", async () => {
    const candidate = await makeCandidate("CAPTURED");

    const results = await Promise.all(
      Array.from({ length: 5 }, () => processOutcomeAttributionForPaymentEvent(candidate.paymentEventId))
    );
    for (const r of results) expect(r.status).toBe("processed");

    const outcomes = await prisma.outcome.findMany({ where: { decisionId: candidate.decisionId } });
    expect(outcomes).toHaveLength(1);
  }, 20_000);

  it("11. a late 'failed' evaluation after a payment is already captured never regresses the Outcome", async () => {
    const candidate = await makeCandidate("CAPTURED");

    const first = await processOutcomeAttributionForPaymentEvent(candidate.paymentEventId);
    expect(first.status).toBe("processed");
    const afterFirst = await prisma.outcome.findUniqueOrThrow({ where: { decisionId: candidate.decisionId } });
    expect(afterFirst.status).toBe("RECOVERED");

    // Real Payment.status can never regress out of CAPTURED (Phase 23 Step 3's
    // own ordering guard) - so a "late failed event" re-triggering evaluation
    // still sees the payment as CAPTURED. This proves the Outcome-level
    // terminal guard holds even if that Step 3 guard were ever bypassed.
    const secondEvent = await prisma.paymentEvent.create({
      data: { razorpayEventId: `${TAG}-late-${randomUUID()}`, eventType: "payment.failed", payload: {}, paymentId: candidate.paymentId },
    });
    const second = await processOutcomeAttributionForPaymentEvent(secondEvent.id);
    expect(second.status).toBe("processed");
    if (second.status === "processed") {
      expect(second.decisionResults[0].status).toBe("skipped_terminal");
    }

    const afterSecond = await prisma.outcome.findUniqueOrThrow({ where: { decisionId: candidate.decisionId } });
    expect(afterSecond.status).toBe("RECOVERED"); // unchanged
  }, 20_000);

  it("12. a payment that later becomes captured correctly upgrades a PENDING outcome to RECOVERED", async () => {
    const candidate = await makeCandidate("FAILED");

    const first = await processOutcomeAttributionForPaymentEvent(candidate.paymentEventId);
    expect(first.status).toBe("processed");
    const afterFirst = await prisma.outcome.findUniqueOrThrow({ where: { decisionId: candidate.decisionId } });
    expect(afterFirst.status).toBe("PENDING"); // window still open, no recovery yet

    await prisma.payment.update({ where: { id: candidate.paymentId }, data: { status: "CAPTURED" } });
    const secondEvent = await prisma.paymentEvent.create({
      data: { razorpayEventId: `${TAG}-captured-${randomUUID()}`, eventType: "payment.captured", payload: {}, paymentId: candidate.paymentId },
    });
    const second = await processOutcomeAttributionForPaymentEvent(secondEvent.id);
    expect(second.status).toBe("processed");

    const afterSecond = await prisma.outcome.findUniqueOrThrow({ where: { decisionId: candidate.decisionId } });
    expect(afterSecond.status).toBe("RECOVERED");
    expect(afterSecond.attributionStatus).toBe("NATURAL_RECOVERY");
  }, 20_000);

  it("17. experiment assignment context is preserved and reachable from the Outcome", async () => {
    const candidate = await makeCandidate("CAPTURED");
    const experiment = await prisma.experiment.create({
      data: { name: `Outcome test experiment ${TAG}`, version: "v1", treatmentDefinition: "policy-v1" },
    });
    createdExperimentIds.push(experiment.id);
    const assignment = await prisma.experimentAssignment.create({
      data: {
        experimentId: experiment.id,
        unitType: "CANDIDATE",
        unitKey: candidate.riskEventId,
        arm: "TREATMENT",
        eligibilityVersion: "eligibility-v1",
      },
    });
    await prisma.revenueRiskEvent.update({
      where: { id: candidate.riskEventId },
      data: { experimentAssignmentId: assignment.id },
    });

    await processOutcomeAttributionForPaymentEvent(candidate.paymentEventId);

    const outcome = await prisma.outcome.findUniqueOrThrow({
      where: { decisionId: candidate.decisionId },
      include: { decision: { include: { revenueRiskEvent: { include: { experimentAssignment: true } } } } },
    });
    expect(outcome.decision.revenueRiskEvent.experimentAssignment?.arm).toBe("TREATMENT");
  }, 20_000);

  it("18. an Outcome is still produced correctly with no experiment assignment at all", async () => {
    const candidate = await makeCandidate("CAPTURED");
    await processOutcomeAttributionForPaymentEvent(candidate.paymentEventId);

    const outcome = await prisma.outcome.findUniqueOrThrow({
      where: { decisionId: candidate.decisionId },
      include: { decision: { include: { revenueRiskEvent: true } } },
    });
    expect(outcome.decision.revenueRiskEvent.experimentAssignmentId).toBeNull();
    expect(outcome.status).toBe("RECOVERED");
  }, 20_000);
});
