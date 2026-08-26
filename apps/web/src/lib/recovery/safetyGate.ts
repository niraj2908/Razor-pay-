import { RecoveryContext } from "./types";
import { DEFAULT_POLICY, PolicyConfig } from "./policy";

export type SafetyFallback = "WAIT" | "STOP" | "ESCALATE";

export type SafetyResult = {
  safe: boolean;
  reasons: string[];
  recommendedFallback: SafetyFallback | null;
};

// Above this amount, an active incident escalates to a human instead of
// silently waiting - a synthetic threshold for this prototype.
const INCIDENT_ESCALATION_AMOUNT = 1_000_000; // ₹10,000

/**
 * Deterministic pre-execution safety check (Phase 21.9). Checks are
 * evaluated in a FIXED priority order and this returns on the first
 * violation found, so the same context+policy always yields exactly one
 * fallback - never an ambiguous mix. An unsafe result must never be
 * overridden into ACT.
 */
export function evaluateSafety(
  context: RecoveryContext,
  policy: PolicyConfig = DEFAULT_POLICY
): SafetyResult {
  if (context.paymentState === "captured" || context.paymentState === "authorized") {
    return { safe: false, reasons: ["payment_already_succeeded"], recommendedFallback: "STOP" };
  }

  if (context.hasPendingExecution) {
    return { safe: false, reasons: ["duplicate_execution_risk"], recommendedFallback: "STOP" };
  }

  if (context.retryCount >= policy.maxAttempts) {
    return { safe: false, reasons: ["retry_limit_exceeded"], recommendedFallback: "STOP" };
  }

  if (context.minutesSinceLastAttempt < policy.cooldownMinutes) {
    return { safe: false, reasons: ["cooldown_active"], recommendedFallback: "WAIT" };
  }

  if (context.amount > policy.maxInterventionAmount) {
    return {
      safe: false,
      reasons: ["amount_exceeds_intervention_limit"],
      recommendedFallback: "STOP",
    };
  }

  if (context.activeIncident) {
    return {
      safe: false,
      reasons: ["active_incident"],
      recommendedFallback: context.amount >= INCIDENT_ESCALATION_AMOUNT ? "ESCALATE" : "WAIT",
    };
  }

  return { safe: true, reasons: [], recommendedFallback: null };
}
