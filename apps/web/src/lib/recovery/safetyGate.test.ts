import { describe, expect, it } from "vitest";
import { evaluateSafety } from "./safetyGate";
import { DEFAULT_POLICY } from "./policy";
import { RecoveryContext } from "./types";

const SAFE_CONTEXT: RecoveryContext = {
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

describe("evaluateSafety", () => {
  it("is safe for an ordinary failed payment with no red flags", () => {
    const result = evaluateSafety(SAFE_CONTEXT);
    expect(result.safe).toBe(true);
    expect(result.recommendedFallback).toBeNull();
  });

  it("stops when the payment already succeeded (nothing to recover)", () => {
    const result = evaluateSafety({ ...SAFE_CONTEXT, paymentState: "captured" });
    expect(result.safe).toBe(false);
    expect(result.recommendedFallback).toBe("STOP");
  });

  it("stops on duplicate-execution risk", () => {
    const result = evaluateSafety({ ...SAFE_CONTEXT, hasPendingExecution: true });
    expect(result.safe).toBe(false);
    expect(result.recommendedFallback).toBe("STOP");
  });

  it("stops once the retry limit is exceeded", () => {
    const result = evaluateSafety({ ...SAFE_CONTEXT, retryCount: DEFAULT_POLICY.maxAttempts });
    expect(result.safe).toBe(false);
    expect(result.recommendedFallback).toBe("STOP");
  });

  it("waits while the cooldown window is still active", () => {
    const result = evaluateSafety({ ...SAFE_CONTEXT, minutesSinceLastAttempt: 5 });
    expect(result.safe).toBe(false);
    expect(result.recommendedFallback).toBe("WAIT");
  });

  it("stops when the amount exceeds the intervention limit", () => {
    const result = evaluateSafety({
      ...SAFE_CONTEXT,
      amount: DEFAULT_POLICY.maxInterventionAmount + 1,
    });
    expect(result.safe).toBe(false);
    expect(result.recommendedFallback).toBe("STOP");
  });

  it("waits for an active incident on a low-value payment", () => {
    const result = evaluateSafety({ ...SAFE_CONTEXT, activeIncident: true, amount: 5000 });
    expect(result.safe).toBe(false);
    expect(result.recommendedFallback).toBe("WAIT");
  });

  it("escalates for an active incident on a high-value payment", () => {
    const result = evaluateSafety({ ...SAFE_CONTEXT, activeIncident: true, amount: 2_000_000 });
    expect(result.safe).toBe(false);
    expect(result.recommendedFallback).toBe("ESCALATE");
  });

  it("returns exactly one violation reason even when multiple conditions are unsafe", () => {
    const result = evaluateSafety({
      ...SAFE_CONTEXT,
      paymentState: "captured",
      retryCount: 99,
      hasPendingExecution: true,
    });
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toBe("payment_already_succeeded");
  });
});
