import type { FailureReason, PaymentMethod, RecoveryAction, RecoveryContext, Strategy } from "@/lib/recovery/types";

/**
 * Pure, deterministic Demo Workspace scenario definitions (Phase 28B).
 *
 * Every scenario here is a `RecoveryContext` construction, verified by hand
 * against the REAL decision engine's math (decisionEngine.ts, policy.ts,
 * safetyGate.ts, naturalRecoveryModel.ts, interventionResponseModel.ts,
 * economics.ts - none of which are modified by this module) to legitimately
 * produce its `expectedDecision`. This file contains NO decision logic of
 * its own - it only builds inputs. The seed script feeds each context
 * through the real `evaluateRecoveryDecision()` and persists whatever the
 * engine actually returns; `expectedDecision`/`expectedReason` exist so
 * unit tests can assert the real engine still agrees, not to force an
 * outcome.
 *
 * One documented, genuine constraint found while designing this set: under
 * `DEFAULT_POLICY.allowedStrategies` (RETRY, PAYMENT_LINK) and the current
 * intervention-uplift table, the "high natural recovery, no incremental
 * value" WAIT branch is unreachable via RETRY at ANY payment amount for
 * every FailureReason - RETRY's cost is always zero, so its expected value
 * is non-negative unless its uplift is exactly zero, which only happens for
 * CONFIRMED_FAILURE, whose base natural-recovery probability (0.05) can
 * never reach the 0.75 threshold that branch requires. Reaching that
 * specific branch legitimately requires narrowing the candidate strategy
 * set via `RecoveryContext.candidateStrategies` (a real, first-class,
 * already-supported field - e.g. "this payment channel has no automated
 * retry path, only a payment-link nudge applies") - see scenario `wait_1`.
 */

export type DemoDecisionScenario = {
  key: string;
  label: string;
  diagnosis: FailureReason;
  amountPaise: number;
  paymentMethod: PaymentMethod;
  retryCount: number;
  activeIncident: boolean;
  candidateStrategies?: Strategy[];
  expectedDecision: RecoveryAction;
  expectedReason: string;
};

export const DEMO_DECISION_SCENARIOS: DemoDecisionScenario[] = [
  {
    key: "act_retry_network",
    label: "Network degradation, ₹5,000 — a retry scores highest but cannot be executed",
    diagnosis: "NETWORK_DEGRADATION",
    amountPaise: 500_000,
    paymentMethod: "upi",
    retryCount: 0,
    activeIncident: false,
    expectedDecision: "ACT",
    expectedReason: "positive_expected_incremental_value",
  },
  {
    key: "act_payment_link_abandonment",
    label: "Customer abandonment, ₹3,000 — best strategy is a payment-link nudge",
    diagnosis: "CUSTOMER_ABANDONMENT",
    amountPaise: 300_000,
    paymentMethod: "card",
    retryCount: 0,
    activeIncident: false,
    expectedDecision: "ACT",
    expectedReason: "positive_expected_incremental_value",
  },
  {
    key: "act_payment_link_other_recoverable",
    label: "Other recoverable failure, ₹999 — payment-link nudge",
    diagnosis: "OTHER_RECOVERABLE",
    amountPaise: 99_900,
    paymentMethod: "netbanking",
    retryCount: 0,
    activeIncident: false,
    expectedDecision: "ACT",
    expectedReason: "positive_expected_incremental_value",
  },
  {
    key: "act_retry_network_repeat",
    label: "Network degradation, ₹4,499, second attempt — still worth intervening",
    diagnosis: "NETWORK_DEGRADATION",
    amountPaise: 449_900,
    paymentMethod: "upi",
    retryCount: 1,
    activeIncident: false,
    expectedDecision: "ACT",
    expectedReason: "positive_expected_incremental_value",
  },
  {
    key: "wait_1",
    label: "Pending payment, ₹15 — very likely to resolve on its own; not worth a nudge",
    diagnosis: "PENDING",
    amountPaise: 1_500,
    paymentMethod: "upi",
    retryCount: 0,
    activeIncident: false,
    // This payment channel has no automated-retry path available - only a
    // payment-link nudge is a physically applicable strategy for it. See
    // this module's own doc comment for why this is required to legitimately
    // reach the "high natural recovery, no incremental value" branch.
    candidateStrategies: ["PAYMENT_LINK"],
    expectedDecision: "WAIT",
    expectedReason: "high_natural_recovery_no_incremental_value",
  },
  {
    key: "stop_confirmed_failure",
    label: "Confirmed decline, ₹50 — no intervention has positive expected value",
    diagnosis: "CONFIRMED_FAILURE",
    amountPaise: 5_000,
    paymentMethod: "card",
    retryCount: 0,
    activeIncident: false,
    expectedDecision: "STOP",
    expectedReason: "non_positive_expected_incremental_value",
  },
  {
    key: "stop_policy_violation",
    label: "Network degradation, ₹2,000, EMI — payment method is outside policy",
    diagnosis: "NETWORK_DEGRADATION",
    amountPaise: 200_000,
    paymentMethod: "emi",
    retryCount: 0,
    activeIncident: false,
    expectedDecision: "STOP",
    expectedReason: "policy_violation",
  },
  {
    key: "escalate_low_confidence",
    label: "State uncertain, ₹15,000 — model confidence too low to auto-decide",
    diagnosis: "STATE_UNCERTAIN",
    amountPaise: 1_500_000,
    paymentMethod: "card",
    retryCount: 0,
    activeIncident: false,
    expectedDecision: "ESCALATE",
    expectedReason: "confidence_below_threshold",
  },
  {
    key: "escalate_active_incident",
    label: "Network degradation, ₹12,000, active incident — large payment during an outage",
    diagnosis: "NETWORK_DEGRADATION",
    amountPaise: 1_200_000,
    paymentMethod: "wallet",
    retryCount: 0,
    activeIncident: true,
    expectedDecision: "ESCALATE",
    expectedReason: "safety_gate:active_incident",
  },
];

/**
 * Builds the full `RecoveryContext` the real decision engine expects for one
 * scenario. `paymentId`/`merchantId` are filled in by the caller (the seed
 * script) once the corresponding Payment/Merchant rows actually exist -
 * this function has no database access of its own.
 */
export function buildScenarioContext(
  scenario: DemoDecisionScenario,
  paymentId: string,
  merchantId: string
): RecoveryContext {
  return {
    paymentId,
    merchantId,
    amount: scenario.amountPaise,
    paymentMethod: scenario.paymentMethod,
    paymentState: "failed",
    failureReason: scenario.diagnosis,
    retryCount: scenario.retryCount,
    minutesSinceLastAttempt: 120,
    customerContactCount: 0,
    hasPendingExecution: false,
    activeIncident: scenario.activeIncident,
    candidateStrategies: scenario.candidateStrategies,
  };
}
