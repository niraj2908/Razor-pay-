import { describe, expect, it, vi } from "vitest";
import { buildExecutionCommand, receiveExecutionCommand } from "./execution";
import { evaluateRecoveryDecision } from "./decisionEngine";
import { RecoveryContext } from "./types";

const ACT_CONTEXT: RecoveryContext = {
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

const WAIT_CONTEXT: RecoveryContext = {
  ...ACT_CONTEXT,
  minutesSinceLastAttempt: 5, // cooldown active -> WAIT
};

describe("buildExecutionCommand", () => {
  it("builds a command for an ACT decision, carrying the chosen strategy", () => {
    const trace = evaluateRecoveryDecision(ACT_CONTEXT);
    expect(trace.selectedAction).toBe("ACT");

    const command = buildExecutionCommand(trace);
    expect(command).toEqual({
      action: "ACT",
      strategy: trace.selectedStrategy,
      paymentId: trace.paymentId,
      decisionId: trace.decisionId,
    });
  });

  it("returns null for a non-ACT decision", () => {
    const trace = evaluateRecoveryDecision(WAIT_CONTEXT);
    expect(trace.selectedAction).not.toBe("ACT");
    expect(buildExecutionCommand(trace)).toBeNull();
  });
});

describe("receiveExecutionCommand", () => {
  it("only logs the command - it must never call an external API itself", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const trace = evaluateRecoveryDecision(ACT_CONTEXT);
    const command = buildExecutionCommand(trace)!;

    receiveExecutionCommand(command);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("not executed"), command);
    logSpy.mockRestore();
  });
});
