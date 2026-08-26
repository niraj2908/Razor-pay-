/**
 * The Outcome Attribution Engine (Phase 23 Step 4).
 *
 * Core principle: "payment succeeded after intervention" is NEVER treated
 * as "intervention caused recovery." This module is a PURE, deterministic
 * decision function - no database queries, no HTTP, no Razorpay calls, no
 * LLM. It only classifies evidence handed to it by the orchestrator
 * (outcomeService.ts), which is responsible for gathering that evidence
 * from the database.
 *
 * Terminology note: this deliberately does NOT have a `FAILED`
 * AttributionStatus value distinct from `OutcomeStatus.NOT_RECOVERED`
 * (Phase 23 Step 2's design, re-affirmed here after inspection) - "no
 * qualifying recovery occurred within the window" is a single fact, and
 * duplicating it into both status fields would be redundant, not more
 * precise. `AttributionStatus` is reserved for explaining a CONFIRMED
 * recovery (NATURAL_RECOVERY / INTERVENTION_RECOVERY), or for flagging a
 * genuinely uncertain situation (UNKNOWN) that deserves reconciliation
 * attention even before/without a confirmed recovery - e.g. an ambiguous
 * execution result, or evidence that only weakly correlates two records.
 */

export type Strategy = "PAYMENT_LINK" | "CAPTURE" | string;
export type ExecutionStatusValue = "PENDING" | "SUCCEEDED" | "FAILED" | "AMBIGUOUS";
export type PaymentStatusValue = "CREATED" | "AUTHORIZED" | "CAPTURED" | "FAILED" | "REFUNDED";

export type OutcomeStatusValue = "PENDING" | "RECOVERED" | "NOT_RECOVERED";
export type AttributionStatusValue = "NATURAL_RECOVERY" | "INTERVENTION_RECOVERY" | "UNKNOWN" | null;

/** A non-deterministic signal an upstream heuristic MIGHT surface - Section 3:
 * "weak evidence must not be used for intervention attribution." This type
 * exists so that fact is enforced in code, not just by omission - even if a
 * caller passes one of these, the engine below never uses it to confirm a
 * recovery, only to explain why it stayed UNKNOWN. */
export type WeakEvidenceBasis = "amount" | "email" | "phone" | "timestamp" | "merchant" | "payment_method";

export type AttributionPolicy = {
  version: string;
  /** Minutes from Decision.decidedAt after which the window closes, by strategy. */
  windowMinutesByStrategy: Record<string, number>;
  /** Window for candidates with no execution at all (pure natural-recovery watch). */
  defaultWindowMinutes: number;
};

// Phase 23 Step 1 audit's own recommendation: Payment Link gets a window
// tied to real customer behavior time, Capture is near-synchronous.
export const DEFAULT_ATTRIBUTION_POLICY: AttributionPolicy = {
  version: "attribution-v1",
  windowMinutesByStrategy: {
    PAYMENT_LINK: 24 * 60,
    CAPTURE: 30,
  },
  defaultWindowMinutes: 24 * 60,
};

/** Pure: takes `now` explicitly rather than reading the clock itself. */
export function isAttributionWindowClosed(
  decidedAt: Date,
  strategy: string | null,
  now: Date,
  policy: AttributionPolicy = DEFAULT_ATTRIBUTION_POLICY
): boolean {
  const windowMinutes = strategy
    ? policy.windowMinutesByStrategy[strategy] ?? policy.defaultWindowMinutes
    : policy.defaultWindowMinutes;
  const elapsedMinutes = (now.getTime() - decidedAt.getTime()) / 60_000;
  return elapsedMinutes >= windowMinutes;
}

export type AttributionContext = {
  decisionId: string;
  originalPayment: { status: PaymentStatusValue; amount: number };
  /** null when this Decision never produced an Execution at all (WAIT/STOP/
   * ESCALATE, or an ACT decision nothing has executed yet). */
  execution: { actionType: Strategy; status: ExecutionStatusValue } | null;
  /** ONLY ever populated via deterministic linkage (Execution.razorpayReferenceId
   * matched against a payment_link.paid webhook) - never a guess. */
  recoveredPayment: { status: PaymentStatusValue; amount: number } | null;
  /** Non-deterministic hints a caller might have observed - never used to
   * confirm a recovery, only to justify returning UNKNOWN. Normally empty:
   * today's association logic (Phase 23 Step 3) never produces these. */
  weakEvidenceOnly: WeakEvidenceBasis[];
  attributionWindowClosed: boolean;
};

export type AttributionResult = {
  outcomeStatus: OutcomeStatusValue;
  attributionStatus: AttributionStatusValue;
  recoveredAmount: number | null;
  reason: string;
};

function isCaptured(status: PaymentStatusValue): boolean {
  return status === "CAPTURED";
}

/**
 * Deterministic, testable, side-effect-free. Same input -> same output,
 * every time (Phase 23 Step 4, section 16/20 requirement).
 */
export function evaluateOutcomeAttribution(context: AttributionContext): AttributionResult {
  const originalCaptured = isCaptured(context.originalPayment.status);
  const recoveredCaptured = context.recoveredPayment ? isCaptured(context.recoveredPayment.status) : false;
  const windowClosed = context.attributionWindowClosed;

  // --- PAYMENT_LINK intervention path ---
  if (context.execution?.actionType === "PAYMENT_LINK") {
    if (recoveredCaptured) {
      // Deterministic linkage (Execution.razorpayReferenceId <-> payment_link.paid)
      // is the causal proof here, independent of the execution's own recorded
      // status - it can only ever be non-null because Step 3's association
      // logic matched a real payment_link.paid webhook to this execution.
      return {
        outcomeStatus: "RECOVERED",
        attributionStatus: "INTERVENTION_RECOVERY",
        recoveredAmount: context.recoveredPayment!.amount,
        reason: "payment_link_recovered_payment_captured",
      };
    }
    if (context.execution.status === "SUCCEEDED") {
      // The link was created, but no one has paid it (yet, or at all -
      // Section 4's "Payment Link created but customer never pays" case).
      return windowClosed
        ? { outcomeStatus: "NOT_RECOVERED", attributionStatus: null, recoveredAmount: null, reason: "payment_link_window_closed_never_paid" }
        : { outcomeStatus: "PENDING", attributionStatus: null, recoveredAmount: null, reason: "payment_link_created_awaiting_customer_payment" };
    }
    if (context.execution.status === "AMBIGUOUS" || context.execution.status === "PENDING") {
      // We don't even know if the link creation itself went through.
      return windowClosed
        ? { outcomeStatus: "NOT_RECOVERED", attributionStatus: "UNKNOWN", recoveredAmount: null, reason: "payment_link_creation_ambiguous_window_closed" }
        : { outcomeStatus: "PENDING", attributionStatus: "UNKNOWN", recoveredAmount: null, reason: "payment_link_creation_ambiguous_awaiting_resolution" };
    }
    // execution.status === "FAILED": our own attempt definitively failed at
    // the API level - fall through and check for natural recovery below.
  }

  // --- CAPTURE intervention path (same Payment, never a new one) ---
  if (context.execution?.actionType === "CAPTURE") {
    if (originalCaptured) {
      if (context.execution.status === "SUCCEEDED") {
        return {
          outcomeStatus: "RECOVERED",
          attributionStatus: "INTERVENTION_RECOVERY",
          recoveredAmount: context.originalPayment.amount,
          reason: "capture_succeeded_payment_captured",
        };
      }
      if (context.execution.status === "AMBIGUOUS") {
        // The payment IS captured, but our own capture call's outcome was
        // never confirmed - Razorpay's own gateway may have settled it
        // independently. Never claim causation we cannot prove.
        return {
          outcomeStatus: "RECOVERED",
          attributionStatus: "UNKNOWN",
          recoveredAmount: context.originalPayment.amount,
          reason: "capture_ambiguous_but_payment_captured_cause_uncertain",
        };
      }
      // execution.status === "FAILED" but the payment is captured anyway -
      // our attempt did not cause this.
      return {
        outcomeStatus: "RECOVERED",
        attributionStatus: "NATURAL_RECOVERY",
        recoveredAmount: context.originalPayment.amount,
        reason: "capture_failed_but_payment_captured_independently",
      };
    }
    if (context.execution.status === "SUCCEEDED" || context.execution.status === "AMBIGUOUS" || context.execution.status === "PENDING") {
      // Execution claims success/is unresolved, but the payment's own
      // webhook trail doesn't (yet) show captured - do not assume recovery
      // merely because the API call succeeded (Section 4's core rule).
      return windowClosed
        ? { outcomeStatus: "NOT_RECOVERED", attributionStatus: "UNKNOWN", recoveredAmount: null, reason: "capture_reported_but_payment_state_unconfirmed" }
        : { outcomeStatus: "PENDING", attributionStatus: null, recoveredAmount: null, reason: "capture_awaiting_payment_confirmation" };
    }
    // execution.status === "FAILED" and payment not captured - fall through.
  }

  // --- Weak-evidence guard: never used to confirm a recovery (Section 3). ---
  if (context.weakEvidenceOnly.length > 0 && !originalCaptured && !recoveredCaptured) {
    return windowClosed
      ? { outcomeStatus: "NOT_RECOVERED", attributionStatus: "UNKNOWN", recoveredAmount: null, reason: `weak_evidence_only:${context.weakEvidenceOnly.join(",")}` }
      : { outcomeStatus: "PENDING", attributionStatus: "UNKNOWN", recoveredAmount: null, reason: `weak_evidence_only:${context.weakEvidenceOnly.join(",")}` };
  }

  // --- Natural recovery: no qualifying intervention path applied above. ---
  if (originalCaptured) {
    return {
      outcomeStatus: "RECOVERED",
      attributionStatus: "NATURAL_RECOVERY",
      recoveredAmount: context.originalPayment.amount,
      reason: "original_payment_captured_without_qualifying_intervention",
    };
  }

  return windowClosed
    ? { outcomeStatus: "NOT_RECOVERED", attributionStatus: null, recoveredAmount: null, reason: "attribution_window_closed_no_recovery" }
    : { outcomeStatus: "PENDING", attributionStatus: null, recoveredAmount: null, reason: "attribution_window_still_open" };
}
