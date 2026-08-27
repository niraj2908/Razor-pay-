import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getDecisionDetail } from "./decisionDetailService";

/**
 * Real-database integration test for the Phase 25 Step 3 Decision Detail
 * query service. Proves the actual cross-merchant isolation contract
 * (Phase 25 Step 3 Section 11/13) against two real, distinct Merchant
 * rows - a mock cannot prove this.
 *
 * Run via `pnpm test:integration`, never as part of `pnpm test`.
 */

const TAG = `phase25-step3-decision-${randomUUID()}`;
const createdMerchantIds: string[] = [];
const createdPaymentIds: string[] = [];
const createdDecisionIds: string[] = [];

async function makeMerchant() {
  const merchant = await prisma.merchant.create({ data: { name: `Decision detail test merchant ${TAG}-${randomUUID()}` } });
  createdMerchantIds.push(merchant.id);
  return merchant;
}

async function makeFullDecision(opts: { merchantId: string; withExecutionAndOutcome?: boolean }) {
  const payment = await prisma.payment.create({
    data: { merchantId: opts.merchantId, amount: 10000, currency: "INR", status: "FAILED", method: "card", razorpayPaymentId: `pay_${TAG}_${randomUUID()}` },
  });
  createdPaymentIds.push(payment.id);

  const riskEvent = await prisma.revenueRiskEvent.create({
    data: {
      merchantId: opts.merchantId,
      paymentId: payment.id,
      diagnosis: "CUSTOMER_ABANDONMENT",
      amountAtRisk: 10000,
      naturalRecoveryProbability: 0.3,
      dataSource: "SIMULATED",
    },
  });

  await prisma.modelPrediction.create({
    data: { revenueRiskEventId: riskEvent.id, modelName: "intervention_response", modelVersion: "intervention-v1", predictedValue: 0.6, inputFeatures: { strategy: "PAYMENT_LINK" } },
  });

  const action = await prisma.candidateAction.create({
    data: { revenueRiskEventId: riskEvent.id, actionType: "PAYMENT_LINK", predictedSuccessProbability: 0.6, incrementalLift: 0.3, estimatedCost: 0, expectedNetValue: 5000 },
  });

  const decision = await prisma.decision.create({
    data: { revenueRiskEventId: riskEvent.id, decisionType: "ACT", chosenActionId: action.id, expectedIncrementalValue: 5000 },
  });
  createdDecisionIds.push(decision.id);

  await prisma.auditEvent.create({
    data: {
      merchantId: opts.merchantId,
      entityType: "Decision",
      entityId: decision.id,
      action: "decision.act",
      actorType: "SYSTEM",
      details: { decisionId: decision.id, paymentId: payment.id, selectedAction: "ACT", selectedStrategy: "PAYMENT_LINK", policyVersion: "policy-v1", modelVersion: "natural-v1", reason: "positive_expected_incremental_value", timestamp: new Date().toISOString() },
    },
  });

  if (opts.withExecutionAndOutcome) {
    const execution = await prisma.execution.create({
      data: { decisionId: decision.id, paymentId: payment.id, actionType: "PAYMENT_LINK", status: "SUCCEEDED", razorpayReferenceId: `plink_${TAG}` },
    });
    await prisma.outcome.create({
      data: { decisionId: decision.id, paymentId: payment.id, executionId: execution.id, status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 10000, attributionPolicyVersion: "attribution-v1" },
    });
  }

  return { decision, riskEvent, payment };
}

afterAll(async () => {
  await prisma.auditEvent.deleteMany({ where: { entityType: "Decision", entityId: { in: createdDecisionIds } } });
  await prisma.outcome.deleteMany({ where: { decisionId: { in: createdDecisionIds } } });
  await prisma.execution.deleteMany({ where: { decisionId: { in: createdDecisionIds } } });
  await prisma.decision.deleteMany({ where: { id: { in: createdDecisionIds } } });
  await prisma.candidateAction.deleteMany({ where: { revenueRiskEvent: { merchantId: { in: createdMerchantIds } } } });
  await prisma.modelPrediction.deleteMany({ where: { revenueRiskEvent: { merchantId: { in: createdMerchantIds } } } });
  await prisma.revenueRiskEvent.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.$disconnect();
});

describe("getDecisionDetail against a real database", () => {
  it("CRITICAL: Merchant A operator requesting Merchant A's own decision -> found", async () => {
    const merchantA = await makeMerchant();
    const { decision } = await makeFullDecision({ merchantId: merchantA.id });

    const result = await getDecisionDetail(merchantA.id, decision.id);
    expect(result.status).toBe("found");
  }, 30_000);

  it("CRITICAL: Merchant A operator attempting to retrieve Merchant B's real decision -> not_found (BOLA/IDOR denied)", async () => {
    const merchantA = await makeMerchant();
    const merchantB = await makeMerchant();
    const { decision: decisionB } = await makeFullDecision({ merchantId: merchantB.id });

    const result = await getDecisionDetail(merchantA.id, decisionB.id);
    expect(result).toEqual({ status: "not_found" });
  }, 30_000);

  it("CRITICAL (symmetric): Merchant B cannot retrieve Merchant A's decision either", async () => {
    const merchantA = await makeMerchant();
    const merchantB = await makeMerchant();
    const { decision: decisionA } = await makeFullDecision({ merchantId: merchantA.id });

    const result = await getDecisionDetail(merchantB.id, decisionA.id);
    expect(result).toEqual({ status: "not_found" });
  }, 30_000);

  it("a genuinely nonexistent decision id returns not_found, identical in shape to the cross-merchant case", async () => {
    const merchantA = await makeMerchant();
    const result = await getDecisionDetail(merchantA.id, "cldoesnotexistatall00000");
    expect(result).toEqual({ status: "not_found" });
  }, 30_000);

  it("returns the correct related data end to end: risk event, payment, model predictions, chosen action, and decision context from the real audit event", async () => {
    const merchant = await makeMerchant();
    const { decision, riskEvent, payment } = await makeFullDecision({ merchantId: merchant.id });

    const result = await getDecisionDetail(merchant.id, decision.id);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;

    expect(result.decision.revenueRiskEvent.id).toBe(riskEvent.id);
    expect(result.decision.payment.id).toBe(payment.id);
    expect(result.decision.payment.amountPaise).toBe(10000);
    expect(result.decision.modelPredictions).toHaveLength(1);
    expect(result.decision.modelPredictions[0].modelVersion).toBe("intervention-v1");
    expect(result.decision.chosenAction?.actionType).toBe("PAYMENT_LINK");
    expect(result.decision.expectedIncrementalValuePaise).toBe(5000);
    expect(result.decision.decisionContext).toEqual({
      policyVersion: "policy-v1",
      modelVersion: "natural-v1",
      reason: "positive_expected_incremental_value",
    });
    expect(result.decision.decisionDrivers).toEqual([]); // DecisionEvidence genuinely has no writer - real, honest empty array
  }, 30_000);

  it("execution/outcome absence is handled honestly (null, not fabricated) for a decision with neither yet", async () => {
    const merchant = await makeMerchant();
    const { decision } = await makeFullDecision({ merchantId: merchant.id, withExecutionAndOutcome: false });

    const result = await getDecisionDetail(merchant.id, decision.id);
    if (result.status !== "found") throw new Error("expected found");
    expect(result.decision.execution).toBeNull();
    expect(result.decision.outcome).toBeNull();
  }, 30_000);

  it("execution/outcome are correctly surfaced when they DO exist, against real rows", async () => {
    const merchant = await makeMerchant();
    const { decision } = await makeFullDecision({ merchantId: merchant.id, withExecutionAndOutcome: true });

    const result = await getDecisionDetail(merchant.id, decision.id);
    if (result.status !== "found") throw new Error("expected found");
    expect(result.decision.execution?.status).toBe("SUCCEEDED");
    expect(result.decision.execution?.razorpayReferenceId).toBe(`plink_${TAG}`);
    expect(result.decision.outcome?.status).toBe("RECOVERED");
    expect(result.decision.outcome?.recoveredAmountPaise).toBe(10000);
  }, 30_000);

  it("data safety: the response never contains a raw PaymentEvent payload or a password/session field", async () => {
    const merchant = await makeMerchant();
    const { decision } = await makeFullDecision({ merchantId: merchant.id });

    const result = await getDecisionDetail(merchant.id, decision.id);
    if (result.status !== "found") throw new Error("expected found");
    const serialized = JSON.stringify(result.decision);
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("tokenHash");
    expect(serialized).not.toContain("razorpayEventId");
    expect(serialized).not.toContain("payload");
  }, 30_000);
});
