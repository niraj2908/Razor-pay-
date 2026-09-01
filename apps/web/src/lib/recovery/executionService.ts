import type { ActionType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { RazorpayClient } from "@/lib/razorpay/client";
import { classifyRazorpayError } from "./executionErrors";
import { RecoveryAction, Strategy } from "./types";

/**
 * A strategy value as it arrives on a command at the Execution Service
 * boundary - broader than the recovery engine's own `Strategy` type
 * (which has no `CAPTURE`, since capturing an authorized-but-uncaptured
 * payment isn't something `evaluateRecoveryDecision` reasons about - see
 * docs/decision-engine.md and the Phase 22 Step 1 audit).
 */
export type CommandStrategy = Strategy | "CAPTURE";

/**
 * An approved execution command. `decisionId` is the persisted
 * `Decision.id` database row - the same value `Execution.decisionId`
 * foreign-keys to - NOT the recovery engine's in-memory
 * `RecoveryDecisionTrace.decisionId` (a UUID that is never itself a
 * database primary key).
 */
export type ExecutionCommand = {
  decisionId: string;
  paymentId: string;
  action: RecoveryAction;
  strategy: CommandStrategy;
  policyVersion: string;
  decidedAt: string; // ISO timestamp of the decision this command executes
  amount: number; // paise
};

// Phase 22 Step 1 finding: Razorpay has no "retry a failed payment" API.
// RETRY and OTHER_ALLOWED_STRATEGY are therefore deliberately excluded -
// only strategies with a real, verified Razorpay API action are here.
export const SUPPORTED_EXECUTION_STRATEGIES: readonly CommandStrategy[] = ["PAYMENT_LINK", "CAPTURE"];

// A decision older than this is not trusted - the world may have changed
// since it was made. Deliberately conservative for this first execution
// phase; see docs/decision-engine.md.
const MAX_DECISION_AGE_MS = 30 * 60 * 1000; // 30 minutes

export type ExecutionRejectionReason =
  | "action_not_executable"
  | "unsupported_strategy"
  | "missing_decision_id"
  | "missing_payment_id"
  | "invalid_amount"
  | "decision_stale"
  // Phase 23 Step 5 hardening: the decision's own RevenueRiskEvent carries a
  // CONTROL ExperimentAssignment - see isControlArmForbidden() below.
  | "control_arm_forbidden";

export type ExecutionResult =
  | { status: "rejected"; reason: ExecutionRejectionReason }
  | { status: "existing"; executionId: string; executionStatus: string }
  | { status: "skipped"; executionId: string; reason: string }
  | { status: "succeeded"; executionId: string; razorpayReferenceId: string }
  | { status: "failed"; executionId: string; errorCategory: string }
  | { status: "ambiguous"; executionId: string; errorCategory: string };

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

function isUniqueConstraintViolation(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION
  );
}

/**
 * Structural boundary validation only (Phase 22 Step 9) - this does NOT
 * recompute economics or re-run policy/safety. It checks that the command
 * is even executable in principle: action must be ACT, strategy must be
 * one Razorpay actually supports, required fields must be present/sane,
 * and the decision must not be stale.
 */
function validateCommand(command: ExecutionCommand): ExecutionRejectionReason | null {
  if (command.action !== "ACT") {
    return "action_not_executable";
  }
  if (!SUPPORTED_EXECUTION_STRATEGIES.includes(command.strategy)) {
    return "unsupported_strategy";
  }
  if (!command.decisionId) {
    return "missing_decision_id";
  }
  if (!command.paymentId) {
    return "missing_payment_id";
  }
  if (!Number.isFinite(command.amount) || command.amount <= 0) {
    return "invalid_amount";
  }
  if (Date.now() - new Date(command.decidedAt).getTime() > MAX_DECISION_AGE_MS) {
    return "decision_stale";
  }
  return null;
}

/**
 * Defense-in-depth CONTROL enforcement (Phase 23 Step 5 hardening).
 *
 * `experimentService.ts`'s `isExecutionAllowed()` already blocks CONTROL at
 * the processing-layer call site (candidateBuilder.ts) - but that is
 * caller-side discipline, not something the Execution Service itself
 * enforces. This function makes the Execution Service independently reject
 * a CONTROL candidate regardless of caller: a future automatic wiring
 * path, an accidental direct call, a refactor, a background job, or
 * internal API misuse can never execute one, because this check runs here
 * too, not only upstream.
 *
 * Deliberately re-resolves the assignment from the DATABASE via the
 * existing Decision -> RevenueRiskEvent -> ExperimentAssignment relations
 * (no new schema, no duplicated experiment fields) rather than trusting
 * anything the caller supplied - `ExecutionCommand` itself carries no
 * arm/experimentId/assignment field at all, so there is nothing for a
 * caller to spoof in the first place; this function is the only source of
 * truth for whether a command's decision belongs to CONTROL.
 *
 * Only a value of exactly "CONTROL" forbids execution. A decision with NO
 * ExperimentAssignment (the RevenueRiskEvent's experimentAssignmentId is
 * null, or the Decision itself cannot be found) is NOT treated as CONTROL -
 * that would silently break all non-experiment recovery behavior, which
 * must keep working exactly as before Step 5. TREATMENT is likewise never
 * specially privileged here; it simply isn't CONTROL, so it falls through
 * to every other check unchanged (safety/policy already ran upstream in
 * the Decision Engine; idempotency and payment-state checks below still
 * apply in full).
 */
async function isControlArmForbidden(decisionId: string): Promise<boolean> {
  const decision = await prisma.decision.findUnique({
    where: { id: decisionId },
    include: { revenueRiskEvent: { include: { experimentAssignment: true } } },
  });
  const arm = decision?.revenueRiskEvent?.experimentAssignment?.arm;
  return arm === "CONTROL";
}

function mapStrategyToActionType(strategy: CommandStrategy): ActionType {
  switch (strategy) {
    case "PAYMENT_LINK":
      return "PAYMENT_LINK";
    case "CAPTURE":
      return "CAPTURE";
    default:
      // Unreachable: validateCommand rejects anything else first.
      throw new Error(`Unsupported strategy reached persistence: ${strategy}`);
  }
}

async function audit(
  entityId: string,
  action: string,
  details: Record<string, unknown>
): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      entityType: "Execution",
      entityId,
      action,
      actorType: "SYSTEM",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      details: details as any,
    },
  });
}

async function markTerminal(
  executionId: string,
  status: "SUCCEEDED" | "FAILED" | "AMBIGUOUS",
  razorpayReferenceId: string | null
): Promise<void> {
  await prisma.execution.update({
    where: { id: executionId },
    data: { status, razorpayReferenceId: razorpayReferenceId ?? undefined, completedAt: new Date() },
  });
}

/** Phase 22 Step 6: is this Payment still a legitimate PAYMENT_LINK recovery candidate? */
function checkPaymentLinkEligibility(payment: { status: string }): { eligible: boolean; reason?: string } {
  if (payment.status === "CAPTURED" || payment.status === "AUTHORIZED") {
    return { eligible: false, reason: "payment_already_succeeded" };
  }
  if (payment.status === "REFUNDED") {
    return { eligible: false, reason: "payment_already_refunded" };
  }
  return { eligible: true };
}

async function executePaymentLink(
  executionId: string,
  command: ExecutionCommand,
  payment: { status: string; merchantId: string; razorpayCustomerId?: string | null }
): Promise<ExecutionResult> {
  const eligibility = checkPaymentLinkEligibility(payment);
  if (!eligibility.eligible) {
    await markTerminal(executionId, "FAILED", null);
    await audit(executionId, "execution.skipped", { decisionId: command.decisionId, reason: eligibility.reason });
    return { status: "skipped", executionId, reason: eligibility.reason! };
  }

  await audit(executionId, "execution.started", {
    decisionId: command.decisionId,
    strategy: "PAYMENT_LINK",
    amount: command.amount,
  });

  try {
    // reference_id is for OUR business correlation (linking the eventual
    // payment_link.paid webhook back to this decision) - it is NOT our
    // idempotency mechanism. Execution.decisionId's unique constraint,
    // enforced above before this call is ever reached, is authoritative.
    const link = await RazorpayClient.paymentLinks.create({
      amount: command.amount,
      currency: "INR",
      referenceId: command.decisionId,
    });

    await markTerminal(executionId, "SUCCEEDED", link.id);
    await audit(executionId, "execution.succeeded", {
      decisionId: command.decisionId,
      razorpayReferenceId: link.id,
    });
    return { status: "succeeded", executionId, razorpayReferenceId: link.id };
  } catch (error) {
    const classified = classifyRazorpayError(error);
    if (classified.category === "network_timeout") {
      await markTerminal(executionId, "AMBIGUOUS", null);
      await audit(executionId, "execution.ambiguous", {
        decisionId: command.decisionId,
        errorCategory: classified.category,
      });
      return { status: "ambiguous", executionId, errorCategory: classified.category };
    }
    await markTerminal(executionId, "FAILED", null);
    await audit(executionId, "execution.failed", {
      decisionId: command.decisionId,
      errorCategory: classified.category,
    });
    return { status: "failed", executionId, errorCategory: classified.category };
  }
}

async function executeCapture(
  executionId: string,
  command: ExecutionCommand,
  payment: { razorpayPaymentId: string | null }
): Promise<ExecutionResult> {
  if (!payment.razorpayPaymentId) {
    await markTerminal(executionId, "FAILED", null);
    await audit(executionId, "execution.skipped", {
      decisionId: command.decisionId,
      reason: "no_razorpay_payment_id",
    });
    return { status: "skipped", executionId, reason: "no_razorpay_payment_id" };
  }

  await audit(executionId, "execution.started", {
    decisionId: command.decisionId,
    strategy: "CAPTURE",
    amount: command.amount,
  });

  try {
    // Never trust the state that existed when the decision was generated -
    // fetch Razorpay's current truth immediately before acting (Step 4/10).
    const current = await RazorpayClient.payments.fetch(payment.razorpayPaymentId);

    if (current.status !== "authorized") {
      await markTerminal(executionId, "FAILED", null);
      await audit(executionId, "execution.skipped", {
        decisionId: command.decisionId,
        reason: `payment_not_authorized:${current.status}`,
      });
      return { status: "skipped", executionId, reason: `payment_not_authorized:${current.status}` };
    }

    const captured = await RazorpayClient.payments.capture(
      payment.razorpayPaymentId,
      current.amount,
      current.currency
    );

    await markTerminal(executionId, "SUCCEEDED", captured.id);
    await audit(executionId, "execution.succeeded", {
      decisionId: command.decisionId,
      razorpayReferenceId: captured.id,
    });
    return { status: "succeeded", executionId, razorpayReferenceId: captured.id };
  } catch (error) {
    const classified = classifyRazorpayError(error);
    if (classified.category === "network_timeout") {
      await markTerminal(executionId, "AMBIGUOUS", null);
      await audit(executionId, "execution.ambiguous", {
        decisionId: command.decisionId,
        errorCategory: classified.category,
      });
      return { status: "ambiguous", executionId, errorCategory: classified.category };
    }
    await markTerminal(executionId, "FAILED", null);
    await audit(executionId, "execution.failed", {
      decisionId: command.decisionId,
      errorCategory: classified.category,
    });
    return { status: "failed", executionId, errorCategory: classified.category };
  }
}

/**
 * The Execution Service (Phase 22): the ONLY layer between an approved
 * Decision and the Razorpay Adapter. It does not decide WHAT to do - the
 * Decision Engine already decided that - it decides HOW an approved
 * command is safely, idempotently, and observably turned into a real (or
 * safely skipped) Razorpay action.
 *
 * Flow: validate -> reserve (DB unique constraint on Execution.decisionId,
 * P2002-based, never check-then-insert) -> re-verify the payment is still
 * eligible (never trust the state the decision was made against) -> call
 * Razorpay -> record the real, definitive-or-ambiguous outcome -> audit.
 *
 * A network timeout or unparseable response is recorded as AMBIGUOUS, never
 * FAILED, and is never automatically retried - both because the original
 * request may have already succeeded, and because this phase deliberately
 * does not implement any automatic-retry loop for a financial mutation.
 *
 * Flow (Phase 23 Step 5 hardening adds a step): validate -> independently
 * re-check CONTROL from the database (isControlArmForbidden) -> reserve
 * (DB unique constraint on Execution.decisionId, P2002-based, never
 * check-then-insert) -> re-verify the payment is still eligible (never
 * trust the state the decision was made against) -> call Razorpay ->
 * record the real, definitive-or-ambiguous outcome -> audit. The CONTROL
 * check runs BEFORE Execution.create() and BEFORE any RazorpayClient call -
 * a CONTROL decision creates no Execution row and makes no Razorpay call.
 */
export async function executeCommand(command: ExecutionCommand): Promise<ExecutionResult> {
  const rejection = validateCommand(command);
  if (rejection) {
    return { status: "rejected", reason: rejection };
  }

  if (await isControlArmForbidden(command.decisionId)) {
    console.warn("[execution-service] execution blocked - CONTROL arm assignment", {
      decisionId: command.decisionId,
    });
    return { status: "rejected", reason: "control_arm_forbidden" };
  }

  let execution;
  try {
    execution = await prisma.execution.create({
      data: {
        decisionId: command.decisionId,
        paymentId: command.paymentId,
        actionType: mapStrategyToActionType(command.strategy),
        status: "PENDING",
      },
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      const existing = await prisma.execution.findUniqueOrThrow({
        where: { decisionId: command.decisionId },
      });
      console.log("[execution-service] duplicate execution command - no Razorpay call made", {
        decisionId: command.decisionId,
        existingExecutionId: existing.id,
        existingStatus: existing.status,
      });
      return { status: "existing", executionId: existing.id, executionStatus: existing.status };
    }
    throw error;
  }

  await audit(execution.id, "execution.requested", {
    decisionId: command.decisionId,
    paymentId: command.paymentId,
    strategy: command.strategy,
    policyVersion: command.policyVersion,
    decidedAt: command.decidedAt,
  });

  const payment = await prisma.payment.findUnique({ where: { id: command.paymentId } });
  if (!payment) {
    await markTerminal(execution.id, "FAILED", null);
    await audit(execution.id, "execution.skipped", {
      decisionId: command.decisionId,
      reason: "payment_not_found",
    });
    return { status: "skipped", executionId: execution.id, reason: "payment_not_found" };
  }

  if (command.strategy === "PAYMENT_LINK") {
    return executePaymentLink(execution.id, command, payment);
  }
  return executeCapture(execution.id, command, payment);
}
