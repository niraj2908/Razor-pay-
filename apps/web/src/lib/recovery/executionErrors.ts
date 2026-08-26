import { RazorpayApiError, RazorpayTimeoutError } from "@/lib/razorpay/client";

export type RazorpayErrorCategory =
  | "validation_error"
  | "authentication_error"
  | "state_conflict"
  | "rate_limited"
  | "server_error"
  | "network_timeout"
  | "unknown";

export type RecommendedHandling = "RETRY" | "WAIT" | "STOP" | "ESCALATE";

export type ClassifiedError = {
  category: RazorpayErrorCategory;
  retrySafe: boolean;
  recommendedHandling: RecommendedHandling;
};

// Razorpay's own documented error text when a Payment Link's reference_id
// collides with an existing one (Phase 22 Step 1 finding).
const DUPLICATE_REFERENCE_PATTERN = /different reference_id/i;

/**
 * Deterministic classification of a Razorpay call failure (Phase 22 Step
 * 8). `retrySafe` is informational only - a real automatic-retry loop is
 * explicitly out of scope for this conservative first execution phase; no
 * caller in this codebase retries automatically based on this value.
 *
 * A `RazorpayTimeoutError` (no definitive response received) is NEVER
 * classified as a confirmed failure - the request may have succeeded.
 */
export function classifyRazorpayError(error: unknown): ClassifiedError {
  if (error instanceof RazorpayTimeoutError) {
    return { category: "network_timeout", retrySafe: false, recommendedHandling: "ESCALATE" };
  }

  if (error instanceof RazorpayApiError) {
    if (DUPLICATE_REFERENCE_PATTERN.test(error.description)) {
      // Our own Execution.decisionId guard should normally prevent this -
      // if it happens anyway, a human must check Razorpay's dashboard for
      // the pre-existing link rather than us guessing what happened.
      return { category: "state_conflict", retrySafe: false, recommendedHandling: "ESCALATE" };
    }
    if (error.httpStatus === 429) {
      return { category: "rate_limited", retrySafe: true, recommendedHandling: "WAIT" };
    }
    if (error.httpStatus === 401 || error.httpStatus === 403) {
      return { category: "authentication_error", retrySafe: false, recommendedHandling: "STOP" };
    }
    if (error.httpStatus >= 500) {
      // Razorpay documents these as retry-safe with the same idempotency
      // key, but this phase never auto-retries a financial mutation.
      return { category: "server_error", retrySafe: true, recommendedHandling: "ESCALATE" };
    }
    if (error.httpStatus >= 400 && error.httpStatus < 500) {
      return { category: "validation_error", retrySafe: false, recommendedHandling: "STOP" };
    }
  }

  return { category: "unknown", retrySafe: false, recommendedHandling: "ESCALATE" };
}
