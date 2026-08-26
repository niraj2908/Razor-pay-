import { describe, expect, it } from "vitest";
import {
  determineAssignmentUnit,
  computeAssignmentBucket,
  validateTreatmentAllocationPercent,
  determineArm,
  ASSIGNMENT_ALGORITHM_VERSION,
} from "./assignmentEngine";

describe("determineAssignmentUnit", () => {
  it("uses CUSTOMER when a stable customer id exists", () => {
    expect(determineAssignmentUnit("cust_1", "candidate_1")).toEqual({
      unitType: "CUSTOMER",
      unitKey: "cust_1",
    });
  });

  it("12. falls back to CANDIDATE for guest/no-stable-customer payments", () => {
    expect(determineAssignmentUnit(null, "candidate_1")).toEqual({
      unitType: "CANDIDATE",
      unitKey: "candidate_1",
    });
  });
});

describe("determineArm", () => {
  it("5. the same experiment+unit+key always resolves to the same arm", () => {
    const first = determineArm("exp_1", "CUSTOMER", "cust_1", 50);
    const second = determineArm("exp_1", "CUSTOMER", "cust_1", 50);
    expect(first).toBe(second);
  });

  it("6. different keys can produce different buckets (not a constant function)", () => {
    const buckets = Array.from({ length: 20 }, (_, i) =>
      computeAssignmentBucket("exp_1", "CUSTOMER", `cust_${i}`)
    );
    const distinctBuckets = new Set(buckets);
    expect(distinctBuckets.size).toBeGreaterThan(1);
  });

  it("0% treatment allocation always resolves to CONTROL", () => {
    for (let i = 0; i < 10; i++) {
      expect(determineArm("exp_1", "CUSTOMER", `cust_${i}`, 0)).toBe("CONTROL");
    }
  });

  it("100% treatment allocation always resolves to TREATMENT", () => {
    for (let i = 0; i < 10; i++) {
      expect(determineArm("exp_1", "CUSTOMER", `cust_${i}`, 100)).toBe("TREATMENT");
    }
  });

  it("a different experimentId can change the arm for the same unit (no cross-experiment leakage)", () => {
    // Not guaranteed for every possible key, but across many keys at least
    // one must differ, proving experimentId is genuinely part of the hash
    // input rather than being ignored.
    const differs = Array.from({ length: 20 }, (_, i) => `cust_${i}`).some(
      (key) => determineArm("exp_a", "CUSTOMER", key, 50) !== determineArm("exp_b", "CUSTOMER", key, 50)
    );
    expect(differs).toBe(true);
  });

  it("7. rejects a non-integer allocation", () => {
    expect(validateTreatmentAllocationPercent(50.5)).toEqual({
      valid: false,
      reason: "allocation_must_be_integer",
    });
    expect(() => determineArm("exp_1", "CUSTOMER", "cust_1", 50.5)).toThrow(/allocation_must_be_integer/);
  });

  it("7. rejects an out-of-bounds allocation", () => {
    expect(validateTreatmentAllocationPercent(-1)).toEqual({
      valid: false,
      reason: "allocation_out_of_bounds",
    });
    expect(validateTreatmentAllocationPercent(101)).toEqual({
      valid: false,
      reason: "allocation_out_of_bounds",
    });
    expect(() => determineArm("exp_1", "CUSTOMER", "cust_1", 101)).toThrow(/allocation_out_of_bounds/);
  });

  it("8. treatment+control allocation is valid by construction (single field, complement is automatic)", () => {
    // There is deliberately no separate controlAllocationPercent to
    // validate against - CONTROL is always exactly 100 - treatment, so a
    // sum-mismatch misconfiguration is structurally impossible, not merely
    // checked for.
    expect(validateTreatmentAllocationPercent(0).valid).toBe(true);
    expect(validateTreatmentAllocationPercent(50).valid).toBe(true);
    expect(validateTreatmentAllocationPercent(100).valid).toBe(true);
  });

  it("20. attribution algorithm version is a stable, explicit constant", () => {
    expect(ASSIGNMENT_ALGORITHM_VERSION).toBe("sha256-v1");
  });

  it("bucket computation never uses Math.random or wall-clock input (pure function of its arguments)", () => {
    const calls = Array.from({ length: 5 }, () => computeAssignmentBucket("exp_1", "CANDIDATE", "risk_1"));
    expect(new Set(calls).size).toBe(1);
  });
});
