import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, evaluatePolicy } from "./policy";
import { Strategy } from "./types";

describe("evaluatePolicy", () => {
  it("allows a strategy/payment-method combination within policy", () => {
    const result = evaluatePolicy({
      strategy: "RETRY",
      paymentMethod: "card",
      customerContactCount: 0,
    });
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.policyVersion).toBe(DEFAULT_POLICY.version);
  });

  it("disallows a strategy not in the policy's allowed list", () => {
    const result = evaluatePolicy({
      strategy: "OTHER_ALLOWED_STRATEGY",
      paymentMethod: "card",
      customerContactCount: 0,
    });
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain("strategy_not_allowed:OTHER_ALLOWED_STRATEGY");
  });

  it("disallows a payment method not in the policy's allowed list", () => {
    const result = evaluatePolicy({
      strategy: "RETRY",
      paymentMethod: "emi",
      customerContactCount: 0,
    });
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain("payment_method_not_allowed:emi");
  });

  it("disallows once the customer contact limit is reached", () => {
    const result = evaluatePolicy({
      strategy: "PAYMENT_LINK",
      paymentMethod: "card",
      customerContactCount: DEFAULT_POLICY.maxCustomerContacts,
    });
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain("customer_contact_limit_reached");
  });

  it("respects a custom policy override instead of the default", () => {
    const strictPolicy = { ...DEFAULT_POLICY, allowedStrategies: [] as Strategy[] };
    const result = evaluatePolicy(
      { strategy: "RETRY", paymentMethod: "card", customerContactCount: 0 },
      strictPolicy
    );
    expect(result.allowed).toBe(false);
    expect(result.policyVersion).toBe(strictPolicy.version);
  });
});
