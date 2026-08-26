import { beforeEach, describe, expect, it, vi } from "vitest";

const paymentEventFindUnique = vi.fn();
const paymentFindUnique = vi.fn();
const revenueRiskEventCreate = vi.fn();
const modelPredictionCreate = vi.fn();
const candidateActionCreate = vi.fn();
const decisionCreate = vi.fn();
const auditEventCreate = vi.fn();

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
  });

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
});
