import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getRecoveryOverview } from "./overviewService";

/**
 * Real-database integration test for the Phase 25 Step 4B Recovery
 * Overview query service. A mock alone cannot prove tenant isolation or
 * real monetary deduplication - this file proves both against two real,
 * distinct Merchant rows and real duplicate-RevenueRiskEvent fixtures.
 *
 * Run via `pnpm test:integration`, never as part of `pnpm test`.
 */

const TAG = `phase25-step4b-${randomUUID()}`;
const createdMerchantIds: string[] = [];
const createdPaymentIds: string[] = [];

async function makeMerchant() {
  const merchant = await prisma.merchant.create({ data: { name: `Overview test merchant ${TAG}-${randomUUID()}` } });
  createdMerchantIds.push(merchant.id);
  return merchant;
}

async function makePayment(merchantId: string, amount = 10000) {
  const payment = await prisma.payment.create({ data: { merchantId, amount, currency: "INR", status: "FAILED", method: "card" } });
  createdPaymentIds.push(payment.id);
  return payment;
}

async function makeRiskEvent(opts: { merchantId: string; paymentId: string; amountAtRisk?: number; resolvedAt?: Date | null }) {
  return prisma.revenueRiskEvent.create({
    data: {
      merchantId: opts.merchantId,
      paymentId: opts.paymentId,
      diagnosis: "CUSTOMER_ABANDONMENT",
      amountAtRisk: opts.amountAtRisk ?? 10000,
      naturalRecoveryProbability: 0.3,
      dataSource: "SIMULATED",
      resolvedAt: opts.resolvedAt ?? null,
    },
  });
}

async function makeDecision(revenueRiskEventId: string, decisionType: "ACT" | "WAIT" = "ACT") {
  return prisma.decision.create({ data: { revenueRiskEventId, decisionType } });
}

async function makeExecution(opts: { decisionId: string; paymentId: string; status: "PENDING" | "SUCCEEDED" | "FAILED" | "AMBIGUOUS"; executedAt?: Date }) {
  return prisma.execution.create({
    data: { decisionId: opts.decisionId, paymentId: opts.paymentId, actionType: "PAYMENT_LINK", status: opts.status, executedAt: opts.executedAt ?? new Date() },
  });
}

async function makeOutcome(opts: {
  decisionId: string;
  paymentId: string;
  status: "PENDING" | "RECOVERED" | "NOT_RECOVERED";
  attributionStatus?: "NATURAL_RECOVERY" | "INTERVENTION_RECOVERY" | "UNKNOWN";
  recoveredAmount?: number;
  observedAt?: Date;
}) {
  return prisma.outcome.create({
    data: {
      decisionId: opts.decisionId,
      paymentId: opts.paymentId,
      status: opts.status,
      attributionStatus: opts.attributionStatus ?? null,
      recoveredAmount: opts.recoveredAmount ?? null,
      attributionPolicyVersion: "attribution-v1",
      observedAt: opts.observedAt ?? new Date(),
    },
  });
}

const createdExperimentIds: string[] = [];

async function makeExperiment(merchantId: string) {
  const experiment = await prisma.experiment.create({
    data: {
      merchantId,
      name: `Overview incrementalRecovery test experiment ${TAG}-${randomUUID()}`,
      version: "v1",
      treatmentDefinition: "policy-v1",
      treatmentAllocationPercent: 50,
      status: "COMPLETED",
    },
  });
  createdExperimentIds.push(experiment.id);
  return experiment;
}

function baseMeasurementResultData(experimentId: string, overrides: Record<string, unknown> = {}) {
  return {
    experimentId,
    version: 1,
    resultKind: "FINAL" as const,
    resultStatus: "VALID_EFFECT" as const,
    calculatedAt: new Date(),
    dataCutoffAt: new Date(),
    statisticalMethodVersion: "statistics-v1",
    eligibilityLogicVersion: "eligibility-v1",
    validityLogicVersion: "validity-v1",
    confidenceLevel: 0.95,
    totalAssignments: 200,
    treatmentAnalyzableUnits: 100,
    treatmentSuccessUnits: 40,
    treatmentRecoveredGMVPaise: 400000,
    controlAnalyzableUnits: 100,
    controlSuccessUnits: 20,
    controlRecoveredGMVPaise: 200000,
    observedDifference: 0.2,
    observedDifferenceLower: 0.05,
    observedDifferenceUpper: 0.35,
    estimatedCounterfactualTreatmentGMVPaise: 200000,
    estimatedIncrementalGMVPaise: 200000,
    treatmentUnknownOnlyUnits: 0,
    controlUnknownOnlyUnits: 0,
    excludedUnitsTotal: 0,
    exclusionReasonCounts: {},
    validityChecks: [],
    ...overrides,
  };
}

async function makeMeasurementResult(experimentId: string, overrides: Record<string, unknown> = {}) {
  return prisma.experimentMeasurementResult.create({ data: baseMeasurementResultData(experimentId, overrides) });
}

afterAll(async () => {
  await prisma.experimentMeasurementResult.deleteMany({ where: { experimentId: { in: createdExperimentIds } } });
  await prisma.experimentAssignment.deleteMany({ where: { experimentId: { in: createdExperimentIds } } });
  await prisma.experiment.deleteMany({ where: { id: { in: createdExperimentIds } } });
  await prisma.outcome.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.execution.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.decision.deleteMany({ where: { revenueRiskEvent: { merchantId: { in: createdMerchantIds } } } });
  await prisma.revenueRiskEvent.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.$disconnect();
});

describe("getRecoveryOverview against a real database", () => {
  it("empty merchant state returns all zeros/nulls, never an error", async () => {
    const merchant = await makeMerchant();
    const result = await getRecoveryOverview(merchant.id, {});
    expect(result.operational).toEqual({ candidatesCount: 0, revenueAtRiskPaise: 0, interventionsAttempted: 0, interventionsSucceeded: 0 });
    expect(result.attributedOutcomes.matureOutcomesCount).toBe(0);
    expect(result.attributedOutcomes.observedRecoveryRate).toBeNull();
    expect(result.incrementalRecovery).toEqual({ status: "unavailable", reason: "no_experiment_configured" });
  }, 30_000);

  it("CRITICAL: cross-merchant aggregate isolation - Merchant A's overview never reflects Merchant B's real data", async () => {
    const merchantA = await makeMerchant();
    const merchantB = await makeMerchant();

    const paymentA = await makePayment(merchantA.id, 10000);
    await makeRiskEvent({ merchantId: merchantA.id, paymentId: paymentA.id });

    const paymentB = await makePayment(merchantB.id, 999999); // deliberately distinctive amount
    await makeRiskEvent({ merchantId: merchantB.id, paymentId: paymentB.id, amountAtRisk: 999999 });

    const overviewA = await getRecoveryOverview(merchantA.id, {});
    const overviewB = await getRecoveryOverview(merchantB.id, {});

    expect(overviewA.operational.revenueAtRiskPaise).toBe(10000);
    expect(overviewA.operational.candidatesCount).toBe(1);
    expect(JSON.stringify(overviewA)).not.toContain("999999"); // Merchant B's amount never leaks into A's response

    expect(overviewB.operational.revenueAtRiskPaise).toBe(999999);
    expect(overviewB.operational.candidatesCount).toBe(1);
  }, 30_000);

  it("candidate with no outcome contributes to candidatesCount/revenueAtRiskPaise but nothing under attributedOutcomes", async () => {
    const merchant = await makeMerchant();
    const payment = await makePayment(merchant.id, 25000);
    await makeRiskEvent({ merchantId: merchant.id, paymentId: payment.id, amountAtRisk: 25000 });

    const result = await getRecoveryOverview(merchant.id, {});
    expect(result.operational.candidatesCount).toBe(1);
    expect(result.operational.revenueAtRiskPaise).toBe(25000);
    expect(result.attributedOutcomes.matureOutcomesCount).toBe(0);
  }, 30_000);

  it("natural recovery, intervention recovery, failed intervention, and UNKNOWN attribution are each classified correctly against real rows", async () => {
    const merchant = await makeMerchant();

    // Natural recovery
    const paymentNatural = await makePayment(merchant.id, 1000);
    const riskNatural = await makeRiskEvent({ merchantId: merchant.id, paymentId: paymentNatural.id, resolvedAt: new Date() });
    const decisionNatural = await makeDecision(riskNatural.id, "WAIT");
    await makeOutcome({ decisionId: decisionNatural.id, paymentId: paymentNatural.id, status: "RECOVERED", attributionStatus: "NATURAL_RECOVERY", recoveredAmount: 1000 });

    // Intervention recovery (with a successful execution)
    const paymentIntervention = await makePayment(merchant.id, 2000);
    const riskIntervention = await makeRiskEvent({ merchantId: merchant.id, paymentId: paymentIntervention.id, resolvedAt: new Date() });
    const decisionIntervention = await makeDecision(riskIntervention.id, "ACT");
    await makeExecution({ decisionId: decisionIntervention.id, paymentId: paymentIntervention.id, status: "SUCCEEDED" });
    await makeOutcome({ decisionId: decisionIntervention.id, paymentId: paymentIntervention.id, status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 2000 });

    // Failed intervention (execution attempted, no recovery)
    const paymentFailed = await makePayment(merchant.id, 3000);
    const riskFailed = await makeRiskEvent({ merchantId: merchant.id, paymentId: paymentFailed.id, resolvedAt: new Date() });
    const decisionFailed = await makeDecision(riskFailed.id, "ACT");
    await makeExecution({ decisionId: decisionFailed.id, paymentId: paymentFailed.id, status: "FAILED" });
    await makeOutcome({ decisionId: decisionFailed.id, paymentId: paymentFailed.id, status: "NOT_RECOVERED" });

    // UNKNOWN attribution
    const paymentUnknown = await makePayment(merchant.id, 4000);
    const riskUnknown = await makeRiskEvent({ merchantId: merchant.id, paymentId: paymentUnknown.id, resolvedAt: new Date() });
    const decisionUnknown = await makeDecision(riskUnknown.id, "ACT");
    await makeExecution({ decisionId: decisionUnknown.id, paymentId: paymentUnknown.id, status: "AMBIGUOUS" });
    await makeOutcome({ decisionId: decisionUnknown.id, paymentId: paymentUnknown.id, status: "RECOVERED", attributionStatus: "UNKNOWN", recoveredAmount: 4000 });

    // PENDING - must be excluded entirely from matureOutcomesCount/rate
    const paymentPending = await makePayment(merchant.id, 5000);
    const riskPending = await makeRiskEvent({ merchantId: merchant.id, paymentId: paymentPending.id });
    const decisionPending = await makeDecision(riskPending.id, "ACT");
    await makeOutcome({ decisionId: decisionPending.id, paymentId: paymentPending.id, status: "PENDING" });

    const result = await getRecoveryOverview(merchant.id, {});

    expect(result.attributedOutcomes.matureOutcomesCount).toBe(4); // PENDING excluded
    expect(result.attributedOutcomes.recoveredCount).toBe(3);
    expect(result.attributedOutcomes.naturalRecoveryCount).toBe(1);
    expect(result.attributedOutcomes.interventionRecoveryCount).toBe(1);
    expect(result.attributedOutcomes.unknownAttributionCount).toBe(1);
    expect(result.attributedOutcomes.naturalRecoveryGmvPaise).toBe(1000);
    expect(result.attributedOutcomes.interventionRecoveryGmvPaise).toBe(2000);
    expect(result.attributedOutcomes.observedRecoveryRate).toBe(0.75); // 3/4

    expect(result.operational.interventionsAttempted).toBe(3); // SUCCEEDED + FAILED + AMBIGUOUS
    expect(result.operational.interventionsSucceeded).toBe(1);
  }, 30_000);

  it("CRITICAL: duplicate RevenueRiskEvent rows for the SAME Payment never double-count revenueAtRiskPaise, while candidatesCount reflects the real (natural-grain) row count", async () => {
    const merchant = await makeMerchant();
    const payment = await makePayment(merchant.id, 50000);

    // Simulates the real, verified candidateBuilder.ts behavior: two
    // separate webhook-triggered candidate-building calls for the SAME
    // Payment produce two separate RevenueRiskEvent rows.
    await makeRiskEvent({ merchantId: merchant.id, paymentId: payment.id, amountAtRisk: 50000 });
    await makeRiskEvent({ merchantId: merchant.id, paymentId: payment.id, amountAtRisk: 50000 });

    const result = await getRecoveryOverview(merchant.id, {});
    expect(result.operational.candidatesCount).toBe(2); // natural entity grain - both rows are real candidates
    expect(result.operational.revenueAtRiskPaise).toBe(50000); // NOT 100000 - distinct-payment grain
  }, 30_000);

  it("multiple candidates belonging to one Payment, mixed with a genuinely separate payment, sum correctly", async () => {
    const merchant = await makeMerchant();
    const sharedPayment = await makePayment(merchant.id, 10000);
    const distinctPayment = await makePayment(merchant.id, 7000);

    await makeRiskEvent({ merchantId: merchant.id, paymentId: sharedPayment.id, amountAtRisk: 10000 });
    await makeRiskEvent({ merchantId: merchant.id, paymentId: sharedPayment.id, amountAtRisk: 10000 });
    await makeRiskEvent({ merchantId: merchant.id, paymentId: distinctPayment.id, amountAtRisk: 7000 });

    const result = await getRecoveryOverview(merchant.id, {});
    expect(result.operational.candidatesCount).toBe(3);
    expect(result.operational.revenueAtRiskPaise).toBe(17000); // 10000 (once) + 7000
  }, 30_000);

  it("resolved risk events are excluded from candidatesCount/revenueAtRiskPaise (current-state semantics)", async () => {
    const merchant = await makeMerchant();
    const openPayment = await makePayment(merchant.id, 1000);
    const resolvedPayment = await makePayment(merchant.id, 2000);
    await makeRiskEvent({ merchantId: merchant.id, paymentId: openPayment.id, amountAtRisk: 1000, resolvedAt: null });
    await makeRiskEvent({ merchantId: merchant.id, paymentId: resolvedPayment.id, amountAtRisk: 2000, resolvedAt: new Date() });

    const result = await getRecoveryOverview(merchant.id, {});
    expect(result.operational.candidatesCount).toBe(1);
    expect(result.operational.revenueAtRiskPaise).toBe(1000);
  }, 30_000);

  it("date boundaries: since is inclusive, until is exclusive, on real Outcome.observedAt values", async () => {
    const merchant = await makeMerchant();
    const payment = await makePayment(merchant.id, 1000);
    const risk = await makeRiskEvent({ merchantId: merchant.id, paymentId: payment.id });
    const decision = await makeDecision(risk.id, "WAIT");

    const boundary = new Date("2026-03-01T00:00:00.000Z");
    await makeOutcome({ decisionId: decision.id, paymentId: payment.id, status: "RECOVERED", attributionStatus: "NATURAL_RECOVERY", recoveredAmount: 1000, observedAt: boundary });

    const includesBoundary = await getRecoveryOverview(merchant.id, { since: boundary, until: new Date(boundary.getTime() + 1000) });
    expect(includesBoundary.attributedOutcomes.matureOutcomesCount).toBe(1); // since is inclusive

    const excludesBoundary = await getRecoveryOverview(merchant.id, { since: new Date(boundary.getTime() - 1000), until: boundary });
    expect(excludesBoundary.attributedOutcomes.matureOutcomesCount).toBe(0); // until is exclusive
  }, 30_000);

  it("real integer-paise amounts round-trip exactly with no floating-point drift", async () => {
    const merchant = await makeMerchant();
    const payment = await makePayment(merchant.id, 123456789);
    await makeRiskEvent({ merchantId: merchant.id, paymentId: payment.id, amountAtRisk: 123456789 });

    const result = await getRecoveryOverview(merchant.id, {});
    expect(result.operational.revenueAtRiskPaise).toBe(123456789);
    expect(Number.isInteger(result.operational.revenueAtRiskPaise)).toBe(true);
  }, 30_000);

  describe("incrementalRecovery against real Experiment/ExperimentMeasurementResult rows (Phase 25 backend-gap audit, Fix #2)", () => {
    it("available with the real persisted paise values when the merchant's one experiment has a real VALID_EFFECT result", async () => {
      const merchant = await makeMerchant();
      const experiment = await makeExperiment(merchant.id);
      await makeMeasurementResult(experiment.id);

      const result = await getRecoveryOverview(merchant.id, {});
      expect(result.incrementalRecovery).toEqual({
        status: "available",
        estimatedIncrementalGMVPaise: 200000,
        estimatedCounterfactualTreatmentGMVPaise: 200000,
      });
    }, 30_000);

    it("unavailable/no_valid_effect_result when the latest real result is VALID_INCONCLUSIVE, even though it carries a real observedDifference - never treated as causal", async () => {
      const merchant = await makeMerchant();
      const experiment = await makeExperiment(merchant.id);
      await makeMeasurementResult(experiment.id, {
        resultStatus: "VALID_INCONCLUSIVE",
        observedDifference: 0.05,
        observedDifferenceLower: -0.02,
        observedDifferenceUpper: 0.12,
        estimatedIncrementalGMVPaise: null,
        estimatedCounterfactualTreatmentGMVPaise: null,
      });

      const result = await getRecoveryOverview(merchant.id, {});
      expect(result.incrementalRecovery).toEqual({ status: "unavailable", reason: "no_valid_effect_result" });
    }, 30_000);

    it("unavailable/ambiguous_multiple_valid_effect_experiments when TWO real experiments each have their own real VALID_EFFECT result - never guesses which counts", async () => {
      const merchant = await makeMerchant();
      const experimentOne = await makeExperiment(merchant.id);
      const experimentTwo = await makeExperiment(merchant.id);
      await makeMeasurementResult(experimentOne.id, { estimatedIncrementalGMVPaise: 111111, estimatedCounterfactualTreatmentGMVPaise: 111111 });
      await makeMeasurementResult(experimentTwo.id, { estimatedIncrementalGMVPaise: 222222, estimatedCounterfactualTreatmentGMVPaise: 222222 });

      const result = await getRecoveryOverview(merchant.id, {});
      expect(result.incrementalRecovery).toEqual({ status: "unavailable", reason: "ambiguous_multiple_valid_effect_experiments" });
      expect(JSON.stringify(result)).not.toContain("111111");
      expect(JSON.stringify(result)).not.toContain("222222");
    }, 30_000);

    it("cross-merchant isolation: Merchant A's real VALID_EFFECT experiment never makes Merchant B's incrementalRecovery available", async () => {
      const merchantA = await makeMerchant();
      const merchantB = await makeMerchant();
      const experimentA = await makeExperiment(merchantA.id);
      await makeMeasurementResult(experimentA.id);

      const overviewB = await getRecoveryOverview(merchantB.id, {});
      expect(overviewB.incrementalRecovery).toEqual({ status: "unavailable", reason: "no_experiment_configured" });
    }, 30_000);
  });
});
