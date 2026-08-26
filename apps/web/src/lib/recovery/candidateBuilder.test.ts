import { beforeEach, describe, expect, it, vi } from "vitest";

const paymentEventFindUnique = vi.fn();
const paymentFindUnique = vi.fn();
const revenueRiskEventCreate = vi.fn();
const modelPredictionCreate = vi.fn();
const candidateActionCreate = vi.fn();
const decisionCreate = vi.fn();
const auditEventCreate = vi.fn();
const resolveExperimentAssignment = vi.fn();
const receiveExecutionCommand = vi.fn();

const tx = {
  revenueRiskEvent: { create: revenueRiskEventCreate },
  modelPrediction: { create: modelPredictionCreate },
  candidateAction: { create: candidateActionCreate },
  decision: { create: decisionCreate },
  auditEvent: { create: auditEventCreate },
};

const transactionMock = vi.fn(async (callback: (tx: unknown) => Promise<void>) => callback(tx));

// Mirrors the mocking style already used in idempotency.test.ts: mock the
// Prisma singleton, not @prisma/client itself, so this stays independent
// of a running database.
vi.mock("@/lib/db", () => ({
  prisma: {
    paymentEvent: { findUnique: paymentEventFindUnique },
    payment: { findUnique: paymentFindUnique },
    $transaction: transactionMock,
  },
}));

// experimentService.ts needs a real database too (Phase 23 Step 5) - mock
// it here so this suite stays fast and DB-independent, matching the
// pattern already used for outcomeService.ts in route.test.ts/queue.test.ts.
vi.mock("@/lib/experiments/experimentService", () => ({
  resolveExperimentAssignment,
  isExecutionAllowed: (resolution: { outcome: string; assignment?: { arm: string } }) =>
    resolution.outcome !== "assigned" || resolution.assignment?.arm !== "CONTROL",
}));

// buildExecutionCommand is pure and left real; only the dispatch boundary
// (receiveExecutionCommand) is mocked so tests can assert on it directly.
vi.mock("./execution", async (importActual) => {
  const actual = await importActual<typeof import("./execution")>();
  return { ...actual, receiveExecutionCommand };
});

// The real evaluateRecoveryDecision always returns ESCALATE for today's
// hardcoded STATE_UNCERTAIN failure reason (its confidence, 0.35, is below
// DEFAULT_POLICY.minConfidence) - never ACT - so it can never itself
// exercise the CONTROL/TREATMENT execution-gating boundary below. Real
// behavior is kept as the default (via importActual) for every existing
// test; only the two new gating tests below override it to force an ACT
// trace, proving the gate itself, not this prototype model's calibration.
const evaluateRecoveryDecision = vi.fn();
vi.mock("./decisionEngine", async (importActual) => {
  const actual = await importActual<typeof import("./decisionEngine")>();
  return { ...actual, evaluateRecoveryDecision };
});
const { evaluateRecoveryDecision: realEvaluateRecoveryDecision } =
  await vi.importActual<typeof import("./decisionEngine")>("./decisionEngine");

const { buildRecoveryCandidateFromPaymentEvent } = await import("./candidateBuilder");

describe("buildRecoveryCandidateFromPaymentEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revenueRiskEventCreate.mockResolvedValue({ id: "risk_1" });
    candidateActionCreate.mockImplementation(async ({ data }: { data: { actionType: string } }) => ({
      id: `action_${data.actionType}`,
    }));
    decisionCreate.mockResolvedValue({ id: "decision_1" });
    auditEventCreate.mockResolvedValue({ id: "audit_1" });
    resolveExperimentAssignment.mockResolvedValue({ outcome: "no_running_experiment" });
    evaluateRecoveryDecision.mockImplementation(realEvaluateRecoveryDecision);
  });

  function mockActPayment(paymentId: string) {
    paymentEventFindUnique.mockResolvedValue({
      id: `evt_${paymentId}`,
      paymentId,
      payload: { event: "payment.failed" },
    });
    paymentFindUnique.mockResolvedValue({
      id: paymentId,
      merchantId: "merchant_real",
      customerId: null,
      amount: 20000,
      method: "card",
      status: "FAILED",
    });
    evaluateRecoveryDecision.mockReturnValue({
      decisionId: "trace_decision_1",
      paymentId,
      modelVersion: "baseline-v1",
      featureVersion: "features-v1",
      policyVersion: "policy-v1",
      naturalRecoveryProbability: 0.2,
      naturalRecoveryConfidence: 0.9,
      interventionProbability: 0.6,
      candidateStrategies: [
        {
          strategy: "PAYMENT_LINK",
          intervention: { probability: 0.6, modelVersion: "v1", featureVersion: "v1", confidence: 0.9 },
          economics: { expectedIncrementalValue: 500, incrementalRecoveryProbability: 0.4 },
        },
      ],
      expectedValues: { PAYMENT_LINK: 500 },
      selectedAction: "ACT",
      selectedStrategy: "PAYMENT_LINK",
      safetyResults: { safe: true, reasons: [], recommendedFallback: null },
      policyResults: { allowed: true, violations: [], policyVersion: "policy-v1" },
      reason: "positive_expected_incremental_value",
      timestamp: new Date().toISOString(),
    });
  }

  it("skips a marked Test Mode fixture without touching Payment or the transaction (Phase 21.14)", async () => {
    paymentEventFindUnique.mockResolvedValue({
      id: "evt_fixture",
      paymentId: null,
      payload: { _test_fixture: { isTestFixture: true } },
    });

    const result = await buildRecoveryCandidateFromPaymentEvent("evt_fixture");

    expect(result).toEqual({ status: "skipped_fixture" });
    expect(paymentFindUnique).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("skips when the PaymentEvent does not exist", async () => {
    paymentEventFindUnique.mockResolvedValue(null);

    const result = await buildRecoveryCandidateFromPaymentEvent("evt_missing");

    expect(result).toEqual({ status: "skipped_not_found" });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("skips when the event has no linked Payment (paymentId is null)", async () => {
    paymentEventFindUnique.mockResolvedValue({
      id: "evt_unlinked",
      paymentId: null,
      payload: { event: "payment.captured" },
    });

    const result = await buildRecoveryCandidateFromPaymentEvent("evt_unlinked");

    expect(result).toEqual({ status: "skipped_unlinked_payment" });
    expect(paymentFindUnique).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("skips when paymentId is set but no matching Payment row exists", async () => {
    paymentEventFindUnique.mockResolvedValue({
      id: "evt_orphaned",
      paymentId: "pay_missing",
      payload: { event: "payment.failed" },
    });
    paymentFindUnique.mockResolvedValue(null);

    const result = await buildRecoveryCandidateFromPaymentEvent("evt_orphaned");

    expect(result).toEqual({ status: "skipped_unlinked_payment" });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("evaluates and persists a full decision trace for a legitimate linked payment", async () => {
    paymentEventFindUnique.mockResolvedValue({
      id: "evt_real",
      paymentId: "pay_real",
      payload: { event: "payment.failed" },
    });
    paymentFindUnique.mockResolvedValue({
      id: "pay_real",
      merchantId: "merchant_real",
      amount: 20000,
      method: "card",
      status: "FAILED",
    });

    const result = await buildRecoveryCandidateFromPaymentEvent("evt_real");

    expect(result.status).toBe("evaluated");
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(revenueRiskEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ merchantId: "merchant_real", paymentId: "pay_real" }),
      })
    );
    expect(decisionCreate).toHaveBeenCalledTimes(1);
    expect(auditEventCreate).toHaveBeenCalledTimes(1);
    // The audit row must never carry secrets - only decision metadata.
    const auditCallArg = auditEventCreate.mock.calls[0][0].data.details;
    expect(JSON.stringify(auditCallArg)).not.toMatch(/secret|password/i);
  });

  it("13. a TREATMENT assignment lets an ACT decision reach the execution command boundary", async () => {
    mockActPayment("pay_treatment");
    resolveExperimentAssignment.mockResolvedValue({
      outcome: "assigned",
      assignment: { id: "assignment_1", experimentId: "exp_1", arm: "TREATMENT" },
    });

    const result = await buildRecoveryCandidateFromPaymentEvent("evt_pay_treatment");

    expect(result.status).toBe("evaluated");
    expect(receiveExecutionCommand).toHaveBeenCalledTimes(1);
    expect(receiveExecutionCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ACT", strategy: "PAYMENT_LINK", paymentId: "pay_treatment" })
    );
    // The Decision/RevenueRiskEvent/CandidateAction persistence is
    // completely unaffected by the arm - the experiment layer only gates
    // the final execution dispatch, never the decision engine's own path.
    expect(decisionCreate).toHaveBeenCalledTimes(1);
  });

  it("14. a CONTROL assignment structurally blocks the same ACT decision from reaching execution", async () => {
    mockActPayment("pay_control");
    resolveExperimentAssignment.mockResolvedValue({
      outcome: "assigned",
      assignment: { id: "assignment_1", experimentId: "exp_1", arm: "CONTROL" },
    });

    const result = await buildRecoveryCandidateFromPaymentEvent("evt_pay_control");

    expect(result.status).toBe("evaluated");
    if (result.status === "evaluated") {
      expect(result.selectedAction).toBe("ACT"); // the decision engine still recommended ACT...
    }
    expect(receiveExecutionCommand).not.toHaveBeenCalled(); // ...but CONTROL never reaches execution
    // Persistence still happens identically - CONTROL is not implemented by
    // skipping the decision engine or its recording, only by blocking dispatch.
    expect(decisionCreate).toHaveBeenCalledTimes(1);
    expect(revenueRiskEventCreate).toHaveBeenCalledTimes(1);
  });

  it("15/16. an unsafe ACT-shaped context still never dispatches, regardless of TREATMENT assignment (experiment never overrides safety/policy)", async () => {
    mockActPayment("pay_treatment_unsafe");
    evaluateRecoveryDecision.mockImplementation((...args: Parameters<typeof realEvaluateRecoveryDecision>) =>
      realEvaluateRecoveryDecision(...args)
    );
    resolveExperimentAssignment.mockResolvedValue({
      outcome: "assigned",
      assignment: { id: "assignment_1", experimentId: "exp_1", arm: "TREATMENT" },
    });

    const result = await buildRecoveryCandidateFromPaymentEvent("evt_pay_treatment_unsafe");

    // The real decision engine (hardcoded STATE_UNCERTAIN, confidence 0.35 <
    // policy.minConfidence 0.5) returns ESCALATE, never ACT - proving
    // TREATMENT never forces or fabricates an executable action on its own.
    if (result.status === "evaluated") {
      expect(result.selectedAction).not.toBe("ACT");
    }
    expect(receiveExecutionCommand).not.toHaveBeenCalled();
  });
});
