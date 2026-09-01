import type { ActionType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { executeCommand, type CommandStrategy, type ExecutionResult } from "./executionService";

/**
 * The operator-triggered path from a stored ACT decision to a real
 * Razorpay action.
 *
 * Until now `executeCommand` had no production caller at all: the engine
 * decided, `execution.ts` logged the command, and nothing carried it out.
 * This module is that missing link, and it is deliberately operator-
 * triggered rather than automatic - a human stays on every financial
 * action, which is also what keeps the decision fresh enough for
 * `executeCommand`'s own staleness check to mean something.
 *
 * What this module does NOT do is re-decide. It reads the decision the
 * engine already made and hands it to the Execution Service unchanged; it
 * cannot upgrade a WAIT into an ACT, choose a different strategy, or
 * bypass a gate. Every safety, policy and experiment control still lives
 * where it already lived - `evaluateRecoveryDecision` before the row was
 * written, and `executeCommand`'s own validation plus CONTROL-arm check on
 * the way out.
 *
 * Merchant isolation is the WHERE clause, not an app-code comparison: a
 * decision belonging to another merchant simply never matches, and the
 * caller cannot tell that case apart from "no such decision" - the same
 * enumeration-resistance choice the rest of the recovery services make.
 */

export type DecisionExecutionRefusal =
  /** The decision exists but is not an ACT - WAIT/STOP/ESCALATE are never executable. */
  | "decision_not_act"
  /** An ACT decision with no chosen candidate action - nothing to execute. */
  | "no_chosen_action"
  /** The risk event's payment row is missing, so no command can be addressed. */
  | "payment_missing";

export type DecisionExecutionOutcome =
  | { status: "not_found" }
  | { status: "refused"; reason: DecisionExecutionRefusal }
  | { status: "executed"; result: ExecutionResult };

/**
 * The Execution Service owns which strategies are performable, so this
 * translation is deliberately total and lossless: every `ActionType` maps
 * to the command vocabulary, and anything unsupported is rejected by
 * `executeCommand` itself rather than being filtered out here. One
 * authority, not two.
 */
function actionTypeToStrategy(actionType: ActionType): CommandStrategy {
  switch (actionType) {
    case "PAYMENT_LINK":
      return "PAYMENT_LINK";
    case "CAPTURE":
      return "CAPTURE";
    case "RETRY_NOW":
    case "RETRY_LATER":
      return "RETRY";
    default:
      return "OTHER_ALLOWED_STRATEGY";
  }
}

/**
 * Reads the policy version the decision was made under from its audit
 * event, the only place it is recorded (there is no `policyVersion`
 * column - see decisionDetailService.ts). Falls back to a marker rather
 * than inventing a version number: the execution audit trail should say
 * "we could not establish this" instead of asserting something false.
 */
async function resolvePolicyVersion(decisionId: string): Promise<string> {
  const auditEvent = await prisma.auditEvent.findFirst({
    where: { entityType: "Decision", entityId: decisionId },
    orderBy: { createdAt: "desc" },
  });
  const details = auditEvent?.details as { policyVersion?: unknown } | null;
  const policyVersion = details?.policyVersion;
  return typeof policyVersion === "string" && policyVersion.length > 0 ? policyVersion : "unknown";
}

/**
 * Executes the stored ACT decision `decisionId`, if it belongs to
 * `merchantId`. Returns the Execution Service's own result verbatim -
 * including its rejections - so a caller never has to guess why nothing
 * happened.
 */
export async function executeDecision(
  merchantId: string,
  decisionId: string
): Promise<DecisionExecutionOutcome> {
  const decision = await prisma.decision.findFirst({
    where: { id: decisionId, revenueRiskEvent: { merchantId } },
    include: {
      chosenAction: true,
      revenueRiskEvent: { include: { payment: true } },
    },
  });

  if (!decision) {
    return { status: "not_found" };
  }
  if (decision.decisionType !== "ACT") {
    return { status: "refused", reason: "decision_not_act" };
  }
  if (!decision.chosenAction) {
    return { status: "refused", reason: "no_chosen_action" };
  }

  const payment = decision.revenueRiskEvent.payment;
  if (!payment) {
    return { status: "refused", reason: "payment_missing" };
  }

  const result = await executeCommand({
    decisionId: decision.id,
    paymentId: payment.id,
    action: "ACT",
    strategy: actionTypeToStrategy(decision.chosenAction.actionType),
    policyVersion: await resolvePolicyVersion(decision.id),
    decidedAt: decision.decidedAt.toISOString(),
    amount: decision.revenueRiskEvent.amountAtRisk,
  });

  return { status: "executed", result };
}
