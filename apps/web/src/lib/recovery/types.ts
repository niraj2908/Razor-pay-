// Shared domain types for the recovery decision engine (Phase 21).
//
// These deliberately mirror existing Prisma enum values (RiskDiagnosis,
// ActionType, RecoveryDecision) so the pure engine below can be persisted
// into the EXISTING schema (RevenueRiskEvent/CandidateAction/Decision)
// without any new tables or migration - see candidateBuilder.ts.

export type Strategy = "RETRY" | "PAYMENT_LINK" | "OTHER_ALLOWED_STRATEGY";

export type RecoveryAction = "ACT" | "WAIT" | "STOP" | "ESCALATE";

// Mirrors the Prisma `RiskDiagnosis` enum exactly (prisma/schema.prisma).
export type FailureReason =
  | "CONFIRMED_FAILURE"
  | "PENDING"
  | "STATE_UNCERTAIN"
  | "CUSTOMER_ABANDONMENT"
  | "NETWORK_DEGRADATION"
  | "OTHER_RECOVERABLE";

export type PaymentMethod = "card" | "upi" | "netbanking" | "wallet" | "emi" | "other";

export type PaymentState = "failed" | "pending" | "authorized" | "captured";

/**
 * Everything the engine needs to evaluate one payment. Intentionally flat
 * and DB-independent - candidateBuilder.ts is the only place that knows
 * how to build this from Prisma rows.
 */
export type RecoveryContext = {
  paymentId: string;
  merchantId: string;
  amount: number; // paise, integer
  paymentMethod: PaymentMethod;
  paymentState: PaymentState;
  failureReason: FailureReason;
  retryCount: number;
  minutesSinceLastAttempt: number;
  customerContactCount: number;
  hasPendingExecution: boolean;
  activeIncident: boolean;
  /** Overrides policy.allowedStrategies for this evaluation, if set. */
  candidateStrategies?: Strategy[];
};
