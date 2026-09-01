import { describe, expect, it } from "vitest";
import { evaluateRecoveryDecision } from "./decisionEngine";
import { buildExecutionCommand } from "./execution";
import { executeCommand, SUPPORTED_EXECUTION_STRATEGIES } from "./executionService";
import { mapRazorpayFailureToReason } from "./failureReasonMapping";
import type { FailureReason, RecoveryContext } from "./types";

/**
 * Whether a diagnosis the failure mapping can now produce leads to a
 * decision the Execution Service could actually carry out.
 *
 * Before `failureReasonMapping.ts`, every real payment entered the engine
 * as STATE_UNCERTAIN, so no real payment could reach ACT and this question
 * never arose in production. It arises now, which is why these tests exist:
 * an ACT decision naming a strategy the executor rejects is a decision the
 * product cannot honour.
 *
 * Nothing here touches a database. `executeCommand` validates the command
 * shape - including the strategy - and returns before any Prisma call, so
 * the rejection path is genuinely reachable from a unit test.
 */

function failedPaymentContext(failureReason: FailureReason, amount: number): RecoveryContext {
  return {
    paymentId: "pay_test",
    merchantId: "merchant_test",
    amount,
    paymentMethod: "card",
    paymentState: "failed",
    failureReason,
    retryCount: 0,
    minutesSinceLastAttempt: 9999,
    customerContactCount: 0,
    hasPendingExecution: false,
    activeIncident: false,
  };
}

const REPRESENTATIVE_AMOUNT = 250_000; // ₹2,500 - the real Test Mode payment's amount

describe("a diagnosis the failure mapping produces -> a decision the executor can honour", () => {
  it.each([
    ["customer", "CUSTOMER_ABANDONMENT"],
    ["bank", "OTHER_RECOVERABLE"],
    ["business", "CONFIRMED_FAILURE"],
  ])("a %s-source failure diagnoses as %s and selects an executable strategy", (source, expected) => {
    const reason = mapRazorpayFailureToReason({
      errorSource: source,
      errorCode: null,
      errorReason: null,
      errorStep: null,
    });
    expect(reason).toBe(expected);

    const trace = evaluateRecoveryDecision(failedPaymentContext(reason, REPRESENTATIVE_AMOUNT));
    expect(trace.selectedAction).toBe("ACT");
    expect(trace.selectedStrategy).not.toBeNull();
    // The relationship, not a hardcoded strategy name: whatever the engine
    // picks must be something the Execution Service supports.
    expect(SUPPORTED_EXECUTION_STRATEGIES).toContain(trace.selectedStrategy);
  });

  it("STATE_UNCERTAIN still cannot reach ACT, so it never produces a command at all", () => {
    const trace = evaluateRecoveryDecision(
      failedPaymentContext("STATE_UNCERTAIN", REPRESENTATIVE_AMOUNT)
    );
    expect(trace.selectedAction).not.toBe("ACT");
    expect(buildExecutionCommand(trace)).toBeNull();
  });
});

describe("KNOWN GAP: NETWORK_DEGRADATION selects a strategy the executor cannot perform", () => {
  /**
   * This documents a real mismatch rather than asserting desired behaviour.
   * `DEFAULT_POLICY.allowedStrategies` includes RETRY, and for a network
   * failure the engine prices RETRY above PAYMENT_LINK - but Razorpay has
   * no retry-a-failed-payment API, so `SUPPORTED_EXECUTION_STRATEGIES`
   * excludes it and `executeCommand` rejects the command.
   *
   * The mismatch predates the failure mapping; the mapping makes it
   * REACHABLE on real traffic for the first time, which is why it is pinned
   * here. Today nothing executes decisions automatically, so no false claim
   * of recovery can be made - the command is only logged.
   *
   * When the mismatch is fixed, this test must be UPDATED to assert the new
   * behaviour, not deleted.
   */
  it("selects RETRY for a gateway-side failure", () => {
    const reason = mapRazorpayFailureToReason({
      errorSource: "gateway",
      errorCode: "GATEWAY_ERROR",
      errorReason: null,
      errorStep: null,
    });
    expect(reason).toBe("NETWORK_DEGRADATION");

    const trace = evaluateRecoveryDecision(failedPaymentContext(reason, REPRESENTATIVE_AMOUNT));
    expect(trace.selectedAction).toBe("ACT");
    expect(trace.selectedStrategy).toBe("RETRY");
    expect(SUPPORTED_EXECUTION_STRATEGIES).not.toContain("RETRY");
  });

  it("and the Execution Service rejects that command instead of attempting anything", async () => {
    const result = await executeCommand({
      decisionId: "decision_test",
      paymentId: "pay_test",
      action: "ACT",
      strategy: "RETRY",
      policyVersion: "policy-v1",
      decidedAt: new Date().toISOString(),
      amount: REPRESENTATIVE_AMOUNT,
    });

    expect(result).toEqual({ status: "rejected", reason: "unsupported_strategy" });
  });
});
