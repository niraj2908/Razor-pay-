import { FailureReason } from "./types";

/**
 * Razorpay's failure vocabulary -> our `RiskDiagnosis` vocabulary.
 *
 * This is the mapping `candidateBuilder.ts` used to not have. Before it,
 * every real payment entered the Decision Engine as `STATE_UNCERTAIN`
 * regardless of why it failed, whose hand-set confidence (0.35) sits below
 * `DEFAULT_POLICY.minConfidence` (0.5) - so real webhook traffic could only
 * ever resolve to ESCALATE or a safety-gate fallback, never ACT.
 *
 * Deliberately a pure function over four strings, with no database and no
 * Razorpay call: what it decides is a judgement about failure semantics,
 * and judgements that move money belong somewhere small, deterministic, and
 * fully unit-tested rather than inlined in an ingestion path.
 *
 * ## Reading the rules
 *
 * Rules are evaluated in a FIXED order and the first match wins, so the
 * same signals always produce the same diagnosis. `error_source` is trusted
 * ahead of `error_code` because it is the more stable, more semantic field:
 * Razorpay reuses `GATEWAY_ERROR` across bank-side and gateway-side
 * failures, while `source` says which side actually failed.
 *
 * ## Why the default is STATE_UNCERTAIN
 *
 * Anything unrecognised - a new Razorpay error code, a missing field, an
 * event with no error at all - falls through to `STATE_UNCERTAIN`, which is
 * exactly today's behaviour. An unmapped code therefore degrades to "we
 * don't know", never to a confident diagnosis this table did not actually
 * make. See ENGINEERING_PRINCIPLES.md #4: unknown payment state is safer
 * than an incorrect recovery action.
 *
 * ## Known interaction with strategy selection
 *
 * `NETWORK_DEGRADATION` prices RETRY (uplift 0.35) above PAYMENT_LINK
 * (0.10), and `executeCommand` cannot perform RETRY - Razorpay has no
 * retry-a-failed-payment API, so `SUPPORTED_EXECUTION_STRATEGIES` excludes
 * it. A network-degradation ACT decision is therefore currently
 * un-executable. That is a decision-engine/executor mismatch that predates
 * this module and is tracked separately; it is recorded here so the
 * behaviour is not mistaken for a mapping bug.
 */
export type RazorpayFailureSignals = {
  errorCode: string | null | undefined;
  errorReason: string | null | undefined;
  errorSource: string | null | undefined;
  errorStep: string | null | undefined;
};

/** Razorpay sends the literal string "NA" for "no source", which carries
 * exactly as much information as the field being absent. */
function normalize(value: string | null | undefined): string | null {
  // `undefined` is accepted alongside `null` deliberately: the database
  // always returns null, but a partially-selected row or a test fixture
  // written before these columns existed hands over undefined, and this
  // function's contract is that it never throws on any input.
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "" || trimmed === "na") return null;
  return trimmed;
}

const CUSTOMER_ABANDONMENT_REASONS = new Set(["payment_authentication_failed"]);
const CUSTOMER_ABANDONMENT_STEPS = new Set(["payment_authentication"]);
const CONFIRMED_FAILURE_REASONS = new Set(["input_validation_failed", "invalid_card"]);
const NETWORK_CODES = new Set(["gateway_error", "server_error"]);

/**
 * Maps one payment's failure signals onto a `FailureReason`.
 *
 * Never throws and never returns null: an unmappable input is a
 * `STATE_UNCERTAIN` result, not an error, because ingestion must not fail
 * on an error code Razorpay added after this table was written.
 */
export function mapRazorpayFailureToReason(signals: RazorpayFailureSignals): FailureReason {
  const source = normalize(signals.errorSource);
  const reason = normalize(signals.errorReason);
  const step = normalize(signals.errorStep);
  const code = normalize(signals.errorCode);

  // No usable signal at all - a success event, or a failure Razorpay
  // described in fields we don't read.
  if (source === null && reason === null && step === null && code === null) {
    return "STATE_UNCERTAIN";
  }

  // Source-led rules first: it says which side of the transaction failed.
  if (source === "customer") {
    return "CUSTOMER_ABANDONMENT";
  }
  if (source === "business") {
    // Something about the request itself was wrong (bad amount, bad
    // configuration). Re-presenting the same request cannot fix it.
    return "CONFIRMED_FAILURE";
  }
  if (source === "bank" || source === "issuer") {
    // Bank-side declines are frequently transient (issuer timeouts, daily
    // limits) and are deliberately NOT called a confirmed failure: this
    // table has no access to the specific decline code that would justify
    // that, and over-claiming here would suppress recoverable revenue.
    return "OTHER_RECOVERABLE";
  }
  if (source === "gateway" || source === "network" || source === "internal") {
    return "NETWORK_DEGRADATION";
  }

  // Source absent or unrecognised - fall back to the other fields.
  if (
    (reason !== null && CUSTOMER_ABANDONMENT_REASONS.has(reason)) ||
    (step !== null && CUSTOMER_ABANDONMENT_STEPS.has(step))
  ) {
    return "CUSTOMER_ABANDONMENT";
  }
  if (reason !== null && CONFIRMED_FAILURE_REASONS.has(reason)) {
    return "CONFIRMED_FAILURE";
  }
  if (code !== null && NETWORK_CODES.has(code)) {
    return "NETWORK_DEGRADATION";
  }

  return "STATE_UNCERTAIN";
}
