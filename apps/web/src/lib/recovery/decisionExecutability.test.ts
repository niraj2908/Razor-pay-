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

describe("a strategy the executor cannot perform is never selected", () => {
  /**
   * This replaces a test that pinned the opposite behaviour. RETRY used to
   * win selection for a network failure and `executeCommand` then rejected
   * the command - the engine could decide an action the product could not
   * perform. Selection is now restricted to executable strategies, while
   * RETRY is still evaluated and still reported, so the economics stay
   * visible and the audit records what was passed over.
   */
  it("prices RETRY highest for a gateway-side failure but selects an executable strategy", () => {
    const reason = mapRazorpayFailureToReason({
      errorSource: "gateway",
      errorCode: "GATEWAY_ERROR",
      errorReason: null,
      errorStep: null,
    });
    expect(reason).toBe("NETWORK_DEGRADATION");

    const trace = evaluateRecoveryDecision(failedPaymentContext(reason, REPRESENTATIVE_AMOUNT));
    expect(trace.selectedAction).toBe("ACT");
    // The economics are unchanged and still visible...
    expect(trace.expectedValues.RETRY).toBeGreaterThan(trace.expectedValues.PAYMENT_LINK);
    // ...but the engine selects only what can be carried out, and says what
    // it could not use.
    expect(SUPPORTED_EXECUTION_STRATEGIES).toContain(trace.selectedStrategy);
    expect(trace.unexecutableBestStrategy).toBe("RETRY");
  });

  it("holds for every diagnosis the failure mapping can produce", () => {
    const diagnoses: FailureReason[] = [
      "CUSTOMER_ABANDONMENT",
      "OTHER_RECOVERABLE",
      "CONFIRMED_FAILURE",
      "NETWORK_DEGRADATION",
      "STATE_UNCERTAIN",
      "PENDING",
    ];

    for (const diagnosis of diagnoses) {
      const trace = evaluateRecoveryDecision(
        failedPaymentContext(diagnosis, REPRESENTATIVE_AMOUNT)
      );
      if (trace.selectedAction === "ACT") {
        expect(SUPPORTED_EXECUTION_STRATEGIES).toContain(trace.selectedStrategy);
      } else {
        expect(buildExecutionCommand(trace)).toBeNull();
      }
    }
  });

  it("the Execution Service still refuses a RETRY command reaching it by any other route", async () => {
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

  it("escalates rather than acting when no executable strategy is allowed at all", () => {
    const trace = evaluateRecoveryDecision(
      { ...failedPaymentContext("NETWORK_DEGRADATION", REPRESENTATIVE_AMOUNT), candidateStrategies: ["RETRY"] }
    );

    expect(trace.selectedAction).toBe("ESCALATE");
    expect(trace.reason).toBe("no_executable_strategy");
    expect(trace.selectedStrategy).toBeNull();
    expect(buildExecutionCommand(trace)).toBeNull();
  });
});
