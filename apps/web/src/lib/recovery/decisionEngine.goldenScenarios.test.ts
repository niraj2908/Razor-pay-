import { describe, expect, it } from "vitest";
import { evaluateRecoveryDecision } from "./decisionEngine";
import { RecoveryContext } from "./types";

/**
 * Phase 21.11 golden scenarios. Each scenario is a fixed, hand-picked
 * context chosen to exercise one specific rule in the decision pipeline
 * (natural-recovery model -> economics -> policy -> safety -> final
 * action). See docs/decision-engine.md for the full input/prediction/
 * economics/policy/safety/decision writeup of each one.
 */

const BASE: RecoveryContext = {
  paymentId: "pay_golden",
  merchantId: "merchant_golden",
  amount: 10000, // ₹100
  paymentMethod: "card",
  paymentState: "failed",
  failureReason: "NETWORK_DEGRADATION",
  retryCount: 0,
  minutesSinceLastAttempt: 120,
  customerContactCount: 0,
  hasPendingExecution: false,
  activeIncident: false,
};

describe("golden scenario 1: high natural recovery -> WAIT", () => {
  it("waits instead of spending on intervention when the payment is likely to resolve on its own", () => {
    const trace = evaluateRecoveryDecision({
      ...BASE,
      paymentState: "pending",
      failureReason: "PENDING",
      amount: 1000,
      candidateStrategies: ["PAYMENT_LINK"],
    });
    expect(trace.naturalRecoveryProbability).toBeGreaterThanOrEqual(0.75);
    expect(trace.selectedAction).toBe("WAIT");
  });
});

describe("golden scenario 2: strong intervention uplift -> ACT", () => {
  it("acts with RETRY when a transient network failure has a large, cheap recovery uplift", () => {
    const trace = evaluateRecoveryDecision({
      ...BASE,
      failureReason: "NETWORK_DEGRADATION",
      amount: 20000,
    });
    expect(trace.selectedAction).toBe("ACT");
    expect(trace.selectedStrategy).toBe("RETRY");
    expect(trace.expectedValues.RETRY).toBeGreaterThan(0);
  });
});

describe("golden scenario 3: negative intervention economics -> STOP", () => {
  it("stops when the only strategy considered costs more than the uplift is worth", () => {
    const trace = evaluateRecoveryDecision({
      ...BASE,
      failureReason: "CONFIRMED_FAILURE",
      amount: 1000,
      candidateStrategies: ["PAYMENT_LINK"],
    });
    expect(trace.expectedValues.PAYMENT_LINK).toBeLessThan(0);
    expect(trace.selectedAction).toBe("STOP");
  });
});

describe("golden scenario 4: low confidence -> ESCALATE", () => {
  it("escalates to a human when the underlying diagnosis is too uncertain to trust", () => {
    const trace = evaluateRecoveryDecision({
      ...BASE,
      failureReason: "STATE_UNCERTAIN",
      amount: 10000,
    });
    expect(trace.naturalRecoveryConfidence).toBeLessThan(0.5);
    expect(trace.selectedAction).toBe("ESCALATE");
  });
});

describe("golden scenario 5: retry limit exceeded -> STOP", () => {
  it("stops once the merchant policy's max-attempts limit has already been hit", () => {
    const trace = evaluateRecoveryDecision({ ...BASE, retryCount: 3 });
    expect(trace.safetyResults.reasons).toContain("retry_limit_exceeded");
    expect(trace.selectedAction).toBe("STOP");
  });
});

describe("golden scenario 6: cooldown active -> WAIT", () => {
  it("waits out the cooldown window instead of re-attempting too soon", () => {
    const trace = evaluateRecoveryDecision({ ...BASE, minutesSinceLastAttempt: 10 });
    expect(trace.safetyResults.reasons).toContain("cooldown_active");
    expect(trace.selectedAction).toBe("WAIT");
  });
});

describe("golden scenario 7: policy disallows action -> STOP", () => {
  it("stops when the payment method isn't one the policy allows intervening on", () => {
    const trace = evaluateRecoveryDecision({ ...BASE, paymentMethod: "emi" });
    expect(trace.policyResults?.allowed).toBe(false);
    expect(trace.selectedAction).toBe("STOP");
  });
});

describe("golden scenario 8: high-value uncertain payment -> ESCALATE", () => {
  it("escalates a large payment whose diagnosis confidence is too low to act on", () => {
    const trace = evaluateRecoveryDecision({
      ...BASE,
      failureReason: "STATE_UNCERTAIN",
      amount: 4_000_000, // ₹40,000 - high value, still within the amount limit
    });
    expect(trace.naturalRecoveryConfidence).toBeLessThan(0.5);
    expect(trace.selectedAction).toBe("ESCALATE");
  });
});

describe("golden scenario 9: active payment incident -> WAIT", () => {
  it("waits during an active network/gateway incident rather than intervening into it", () => {
    const trace = evaluateRecoveryDecision({ ...BASE, activeIncident: true, amount: 10000 });
    expect(trace.safetyResults.reasons).toContain("active_incident");
    expect(trace.selectedAction).toBe("WAIT");
  });

  it("escalates instead when that same incident is on a high-value payment", () => {
    const trace = evaluateRecoveryDecision({ ...BASE, activeIncident: true, amount: 2_000_000 });
    expect(trace.safetyResults.reasons).toContain("active_incident");
    expect(trace.selectedAction).toBe("ESCALATE");
  });
});

describe("golden scenario 10: Payment Link economically superior -> ACT + PAYMENT_LINK", () => {
  it("chooses PAYMENT_LINK over RETRY when it has the larger expected incremental value", () => {
    const trace = evaluateRecoveryDecision({
      ...BASE,
      failureReason: "CUSTOMER_ABANDONMENT",
      amount: 10000,
    });
    expect(trace.expectedValues.PAYMENT_LINK).toBeGreaterThan(trace.expectedValues.RETRY);
    expect(trace.selectedAction).toBe("ACT");
    expect(trace.selectedStrategy).toBe("PAYMENT_LINK");
  });
});
