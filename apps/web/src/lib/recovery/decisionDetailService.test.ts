import { beforeEach, describe, expect, it, vi } from "vitest";

const decisionFindFirst = vi.fn();
const auditEventFindFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    decision: { findFirst: decisionFindFirst },
    auditEvent: { findFirst: auditEventFindFirst },
  },
}));

const { getDecisionDetail } = await import("./decisionDetailService");

const MERCHANT_A = "merchant_a";

function fixtureDecision(overrides: Record<string, unknown> = {}) {
  return {
    id: "decision_1",
    decisionType: "ACT",
    decidedAt: new Date("2026-01-01T00:05:00.000Z"),
    expectedIncrementalValue: 5000,
    chosenAction: {
      id: "action_1",
      actionType: "PAYMENT_LINK",
      predictedSuccessProbability: 0.6,
      incrementalLift: 0.3,
      estimatedCost: 0,
      expectedNetValue: 5000,
    },
    revenueRiskEvent: {
      id: "risk_1",
      diagnosis: "CUSTOMER_ABANDONMENT",
      amountAtRisk: 10000,
      naturalRecoveryProbability: 0.3,
      detectedAt: new Date("2026-01-01T00:00:00.000Z"),
      resolvedAt: null,
      dataSource: "REAL_RAZORPAY_TEST_MODE",
      payment: {
        id: "payment_1",
        razorpayPaymentId: "pay_abc123",
        amount: 10000,
        currency: "INR",
        method: "card",
        status: "FAILED",
        createdAt: new Date("2025-12-31T23:00:00.000Z"),
      },
      modelPredictions: [
        { modelName: "intervention_response", modelVersion: "intervention-v1", predictedValue: 0.6, predictedAt: new Date("2026-01-01T00:01:00.000Z") },
      ],
    },
    evidence: [],
    executions: [],
    outcome: null,
    ...overrides,
  };
}

describe("decisionDetailService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes the query to the given merchantId via the revenueRiskEvent relation filter - the core isolation contract", async () => {
    decisionFindFirst.mockResolvedValue(null);
    await getDecisionDetail(MERCHANT_A, "decision_1");
    expect(decisionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "decision_1", revenueRiskEvent: { merchantId: MERCHANT_A } },
      })
    );
  });

  it("returns not_found when the query returns null (nonexistent OR cross-merchant - indistinguishable by design)", async () => {
    decisionFindFirst.mockResolvedValue(null);
    const result = await getDecisionDetail(MERCHANT_A, "decision_does_not_exist");
    expect(result).toEqual({ status: "not_found" });
    expect(auditEventFindFirst).not.toHaveBeenCalled(); // never queries audit for a decision it never found
  });

  it("maps a full decision into the documented DTO, in paise, extracting only the three safe fields from AuditEvent.details", async () => {
    decisionFindFirst.mockResolvedValue(fixtureDecision());
    auditEventFindFirst.mockResolvedValue({
      id: "audit_1",
      details: { policyVersion: "policy-v1", modelVersion: "natural-v1", reason: "positive_expected_incremental_value", secretShouldNeverAppear: "leaked" },
    });

    const result = await getDecisionDetail(MERCHANT_A, "decision_1");
    expect(result.status).toBe("found");
    if (result.status !== "found") return;

    expect(result.decision.expectedIncrementalValuePaise).toBe(5000);
    expect(result.decision.chosenAction?.expectedNetValuePaise).toBe(5000);
    expect(result.decision.payment.amountPaise).toBe(10000);
    expect(result.decision.decisionContext).toEqual({
      policyVersion: "policy-v1",
      modelVersion: "natural-v1",
      reason: "positive_expected_incremental_value",
    });
    expect(JSON.stringify(result.decision)).not.toContain("secretShouldNeverAppear");
    expect(JSON.stringify(result.decision)).not.toContain("leaked");
    expect(result.decision.auditEventId).toBe("audit_1");
  });

  it("decisionContext is null when no AuditEvent exists - never fabricated", async () => {
    decisionFindFirst.mockResolvedValue(fixtureDecision());
    auditEventFindFirst.mockResolvedValue(null);

    const result = await getDecisionDetail(MERCHANT_A, "decision_1");
    if (result.status !== "found") throw new Error("expected found");
    expect(result.decision.decisionContext).toBeNull();
    expect(result.decision.auditEventId).toBeNull();
  });

  it("honestly reports empty decisionDrivers (DecisionEvidence) rather than fabricating any", async () => {
    decisionFindFirst.mockResolvedValue(fixtureDecision());
    auditEventFindFirst.mockResolvedValue(null);
    const result = await getDecisionDetail(MERCHANT_A, "decision_1");
    if (result.status !== "found") throw new Error("expected found");
    expect(result.decision.decisionDrivers).toEqual([]);
  });

  it("execution and outcome are null when they don't exist yet - never fabricated placeholders", async () => {
    decisionFindFirst.mockResolvedValue(fixtureDecision());
    auditEventFindFirst.mockResolvedValue(null);
    const result = await getDecisionDetail(MERCHANT_A, "decision_1");
    if (result.status !== "found") throw new Error("expected found");
    expect(result.decision.execution).toBeNull();
    expect(result.decision.outcome).toBeNull();
  });

  it("surfaces execution and outcome correctly when they DO exist", async () => {
    decisionFindFirst.mockResolvedValue(
      fixtureDecision({
        executions: [
          {
            id: "execution_1",
            actionType: "PAYMENT_LINK",
            status: "SUCCEEDED",
            razorpayReferenceId: "plink_xyz",
            executedAt: new Date("2026-01-01T00:06:00.000Z"),
            completedAt: new Date("2026-01-01T00:10:00.000Z"),
          },
        ],
        outcome: {
          id: "outcome_1",
          status: "RECOVERED",
          attributionStatus: "INTERVENTION_RECOVERY",
          recoveredAmount: 10000,
          observedAt: new Date("2026-01-01T00:11:00.000Z"),
        },
      })
    );
    auditEventFindFirst.mockResolvedValue(null);

    const result = await getDecisionDetail(MERCHANT_A, "decision_1");
    if (result.status !== "found") throw new Error("expected found");
    expect(result.decision.execution).toEqual({
      id: "execution_1",
      actionType: "PAYMENT_LINK",
      status: "SUCCEEDED",
      razorpayReferenceId: "plink_xyz",
      executedAt: "2026-01-01T00:06:00.000Z",
      completedAt: "2026-01-01T00:10:00.000Z",
    });
    expect(result.decision.outcome).toEqual({
      id: "outcome_1",
      status: "RECOVERED",
      attributionStatus: "INTERVENTION_RECOVERY",
      recoveredAmountPaise: 10000,
      observedAt: "2026-01-01T00:11:00.000Z",
    });
  });

  it("never includes ModelPrediction.inputFeatures in the response", async () => {
    decisionFindFirst.mockResolvedValue(
      fixtureDecision({
        revenueRiskEvent: {
          ...fixtureDecision().revenueRiskEvent,
          modelPredictions: [
            {
              modelName: "intervention_response",
              modelVersion: "intervention-v1",
              predictedValue: 0.6,
              predictedAt: new Date(),
              inputFeatures: { shouldNeverAppear: true },
            },
          ],
        },
      })
    );
    auditEventFindFirst.mockResolvedValue(null);
    const result = await getDecisionDetail(MERCHANT_A, "decision_1");
    if (result.status !== "found") throw new Error("expected found");
    expect(JSON.stringify(result.decision)).not.toContain("shouldNeverAppear");
  });

  it("chosenAction is null for a non-ACT decision (e.g. WAIT) - never fabricated", async () => {
    decisionFindFirst.mockResolvedValue(fixtureDecision({ decisionType: "WAIT", chosenAction: null }));
    auditEventFindFirst.mockResolvedValue(null);
    const result = await getDecisionDetail(MERCHANT_A, "decision_1");
    if (result.status !== "found") throw new Error("expected found");
    expect(result.decision.chosenAction).toBeNull();
  });
});
