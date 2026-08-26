import { describe, expect, it } from "vitest";
import { evaluateRecoveryDecision } from "./decisionEngine";
import { RecoveryContext } from "./types";

const BASE_CONTEXT: RecoveryContext = {
  paymentId: "pay_1",
  merchantId: "merchant_1",
  amount: 10000,
  paymentMethod: "card",
  paymentState: "failed",
  failureReason: "NETWORK_DEGRADATION",
  retryCount: 0,
  minutesSinceLastAttempt: 120,
  customerContactCount: 0,
  hasPendingExecution: false,
  activeIncident: false,
};

describe("evaluateRecoveryDecision", () => {
  it("produces the same decision-relevant fields for the same input, run twice", () => {
    const first = evaluateRecoveryDecision(BASE_CONTEXT);
    const second = evaluateRecoveryDecision(BASE_CONTEXT);

    expect(second.selectedAction).toBe(first.selectedAction);
    expect(second.selectedStrategy).toBe(first.selectedStrategy);
    expect(second.reason).toBe(first.reason);
    expect(second.expectedValues).toEqual(first.expectedValues);
    expect(second.naturalRecoveryProbability).toBe(first.naturalRecoveryProbability);
    // decisionId and timestamp are per-instance identifiers, not part of
    // the decision itself, so they are allowed to differ.
    expect(second.decisionId).not.toBe(first.decisionId);
  });

  it("includes every field required by the Phase 21.12 decision trace", () => {
    const trace = evaluateRecoveryDecision(BASE_CONTEXT);
    expect(trace).toMatchObject({
      decisionId: expect.any(String),
      paymentId: BASE_CONTEXT.paymentId,
      modelVersion: expect.any(String),
      featureVersion: expect.any(String),
      policyVersion: expect.any(String),
      naturalRecoveryProbability: expect.any(Number),
      candidateStrategies: expect.any(Array),
      expectedValues: expect.any(Object),
      selectedAction: expect.any(String),
      safetyResults: expect.any(Object),
      timestamp: expect.any(String),
    });
  });

  it("never returns ACT without a selectedStrategy", () => {
    const trace = evaluateRecoveryDecision(BASE_CONTEXT);
    if (trace.selectedAction === "ACT") {
      expect(trace.selectedStrategy).not.toBeNull();
    } else {
      expect(trace.selectedStrategy).toBeNull();
    }
  });

  it("evaluates only the caller-specified candidate strategies when given", () => {
    const trace = evaluateRecoveryDecision({
      ...BASE_CONTEXT,
      candidateStrategies: ["PAYMENT_LINK"],
    });
    expect(trace.candidateStrategies).toHaveLength(1);
    expect(trace.candidateStrategies[0].strategy).toBe("PAYMENT_LINK");
  });

  it("an unsafe context always overrides economics, even when the numbers favor ACT", () => {
    const trace = evaluateRecoveryDecision({
      ...BASE_CONTEXT,
      failureReason: "NETWORK_DEGRADATION", // strong uplift, would otherwise ACT
      retryCount: 99, // but retry limit is blown - must never ACT
    });
    expect(trace.selectedAction).not.toBe("ACT");
    expect(trace.reason).toMatch(/^safety_gate:/);
  });
});
