import { describe, expect, it } from "vitest";
import { buildRecoveryAuditEvent } from "./audit";
import { evaluateRecoveryDecision } from "./decisionEngine";
import { RecoveryContext } from "./types";

const CONTEXT: RecoveryContext = {
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

describe("buildRecoveryAuditEvent", () => {
  it("carries the required audit fields from the decision trace (Phase 21.13)", () => {
    const trace = evaluateRecoveryDecision(CONTEXT);
    const audit = buildRecoveryAuditEvent(trace);

    expect(audit).toEqual({
      decisionId: trace.decisionId,
      paymentId: trace.paymentId,
      selectedAction: trace.selectedAction,
      selectedStrategy: trace.selectedStrategy,
      unexecutableBestStrategy: trace.unexecutableBestStrategy,
      policyVersion: trace.policyVersion,
      modelVersion: trace.modelVersion,
      reason: trace.reason,
      timestamp: trace.timestamp,
    });
  });

  it("never includes the full candidate-strategy breakdown or any secret-shaped field", () => {
    const trace = evaluateRecoveryDecision(CONTEXT);
    const audit = buildRecoveryAuditEvent(trace);

    expect(audit).not.toHaveProperty("candidateStrategies");
    expect(audit).not.toHaveProperty("expectedValues");
    expect(JSON.stringify(audit)).not.toMatch(/secret|password|key/i);
  });

  it("records the higher-value strategy that could not be executed, so the trail explains the downgrade", () => {
    // NETWORK_DEGRADATION prices RETRY above PAYMENT_LINK, and RETRY is not
    // executable - the audit must say so rather than silently showing only
    // the strategy that was chosen.
    const trace = evaluateRecoveryDecision({ ...CONTEXT, amount: 20000 });
    const audit = buildRecoveryAuditEvent(trace);

    expect(audit.selectedStrategy).toBe("PAYMENT_LINK");
    expect(audit.unexecutableBestStrategy).toBe("RETRY");
  });
});
