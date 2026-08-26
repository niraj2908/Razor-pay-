import { PaymentMethod, Strategy } from "./types";

export type PolicyConfig = {
  version: string;
  maxAttempts: number;
  cooldownMinutes: number;
  maxInterventionAmount: number; // paise
  maxCustomerContacts: number;
  allowedPaymentMethods: PaymentMethod[];
  allowedStrategies: Strategy[];
  minExpectedIncrementalValue: number; // paise
  minConfidence: number;
};

/**
 * Prototype default policy. Versioned by a plain string tag (like
 * modelVersion/featureVersion) rather than a new DB table - see
 * docs/decision-engine.md for why introducing MerchantPolicy-backed
 * versioning is deferred until a real merchant/policy-editing flow exists.
 */
export const DEFAULT_POLICY: PolicyConfig = {
  version: "policy-v1",
  maxAttempts: 3,
  cooldownMinutes: 60,
  maxInterventionAmount: 5_000_000, // ₹50,000
  maxCustomerContacts: 2,
  allowedPaymentMethods: ["card", "upi", "netbanking", "wallet"],
  allowedStrategies: ["RETRY", "PAYMENT_LINK"],
  minExpectedIncrementalValue: 100, // ₹1
  minConfidence: 0.5,
};

export type PolicyEvaluationInput = {
  strategy: Strategy;
  paymentMethod: PaymentMethod;
  customerContactCount: number;
};

export type PolicyResult = {
  allowed: boolean;
  violations: string[];
  policyVersion: string;
};

/**
 * Deterministic, versioned policy check. `policyVersion` must be recorded
 * on every decision so a historical decision stays reproducible even after
 * the policy configuration later changes.
 */
export function evaluatePolicy(
  input: PolicyEvaluationInput,
  policy: PolicyConfig = DEFAULT_POLICY
): PolicyResult {
  const violations: string[] = [];

  if (!policy.allowedStrategies.includes(input.strategy)) {
    violations.push(`strategy_not_allowed:${input.strategy}`);
  }
  if (!policy.allowedPaymentMethods.includes(input.paymentMethod)) {
    violations.push(`payment_method_not_allowed:${input.paymentMethod}`);
  }
  if (input.customerContactCount >= policy.maxCustomerContacts) {
    violations.push("customer_contact_limit_reached");
  }

  return { allowed: violations.length === 0, violations, policyVersion: policy.version };
}
