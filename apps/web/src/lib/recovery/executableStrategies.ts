import { Strategy } from "./types";

/**
 * Which decision strategies the Execution Service can actually carry out.
 *
 * This exists because the two layers disagreed. `DEFAULT_POLICY` allows
 * RETRY and the models price it - often above PAYMENT_LINK for a network
 * failure - but Razorpay has no retry-a-failed-payment API, so
 * `executeCommand` rejects a RETRY command with `unsupported_strategy`. The
 * engine could therefore choose an action the product cannot perform.
 *
 * The fix keeps the economics honest rather than deleting them: RETRY is
 * still evaluated and still appears in the trace's `expectedValues`, so the
 * audit trail records that a cheaper option was considered and why it was
 * not taken. Only SELECTION is restricted to what can be executed.
 *
 * Kept in its own module so both the decision layer and the execution layer
 * can import one source of truth. The decision layer must not import
 * `executionService.ts` directly - that module pulls in Prisma and the
 * Razorpay client, and the engine is a pure function that stays unit
 * testable without either.
 *
 * CAPTURE is deliberately absent: it is an execution-layer capability
 * (`CommandStrategy`), not something the decision engine selects.
 */
export const EXECUTABLE_STRATEGIES: readonly Strategy[] = ["PAYMENT_LINK"];

export function isExecutableStrategy(strategy: Strategy): boolean {
  return EXECUTABLE_STRATEGIES.includes(strategy);
}
