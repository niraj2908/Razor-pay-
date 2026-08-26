import { Strategy } from "./types";
import { RecoveryDecisionTrace } from "./decisionEngine";

export type ExecutionCommand = {
  action: "ACT";
  strategy: Strategy;
  paymentId: string;
  decisionId: string;
};

/**
 * Turns an ACT decision into an execution command - a plain data object,
 * not a Razorpay call. Returns null for any non-ACT decision (WAIT/STOP/
 * ESCALATE never produce a command).
 */
export function buildExecutionCommand(trace: RecoveryDecisionTrace): ExecutionCommand | null {
  if (trace.selectedAction !== "ACT" || !trace.selectedStrategy) {
    return null;
  }
  return {
    action: "ACT",
    strategy: trace.selectedStrategy,
    paymentId: trace.paymentId,
    decisionId: trace.decisionId,
  };
}

/**
 * Phase 21.15: the decision engine must never call Razorpay directly.
 * Architecture is Decision Engine -> Execution Command -> Execution
 * Service -> Razorpay Adapter -> Razorpay API. This function is that
 * Execution Service boundary - for THIS phase it only records intent and
 * deliberately does not call RazorpayClient. Actual autonomous execution
 * (e.g. RazorpayClient.paymentLinks.create) is a later phase.
 */
export function receiveExecutionCommand(command: ExecutionCommand): void {
  console.log("[execution] command received (not executed - deferred to a later phase)", command);
}
