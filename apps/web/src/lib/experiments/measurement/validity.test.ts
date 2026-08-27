import { describe, expect, it } from "vitest";
import { AnalysisUnit } from "./analysisUnit";
import { AssignmentValidityContext, evaluateExperimentValidity, ExperimentValidityInput } from "./validity";

const EXPERIMENT_ID = "exp_1";

function unit(overrides: Partial<AnalysisUnit> = {}): AnalysisUnit {
  return {
    assignmentId: `assignment_${Math.random()}`,
    unitType: "CANDIDATE",
    unitKey: `unit_${Math.random()}`,
    arm: "TREATMENT",
    candidateCount: 1,
    analyzableSuccessCount: 0,
    analyzableFailureCount: 0,
    maturedUnknownCandidateCount: 0,
    status: "NOT_ANALYZABLE",
    outcome: null,
    recoveredAmount: 0,
    exclusionReasons: [],
    ...overrides,
  };
}

function successUnit(arm: "TREATMENT" | "CONTROL", assignmentId: string, unitKey = assignmentId): AnalysisUnit {
  return unit({ assignmentId, unitKey, arm, status: "ANALYZABLE", outcome: "SUCCESS", analyzableSuccessCount: 1, recoveredAmount: 1000 });
}
function failureUnit(arm: "TREATMENT" | "CONTROL", assignmentId: string, unitKey = assignmentId): AnalysisUnit {
  return unit({ assignmentId, unitKey, arm, status: "ANALYZABLE", outcome: "FAILURE", analyzableFailureCount: 1 });
}

function ctx(u: AnalysisUnit, experimentId: string = EXPERIMENT_ID): AssignmentValidityContext {
  return { analysisUnit: u, experimentId };
}

function baseInput(overrides: Partial<ExperimentValidityInput> = {}): ExperimentValidityInput {
  return {
    experimentId: EXPERIMENT_ID,
    experimentStatus: "RUNNING",
    treatmentAllocationPercent: 50,
    minimumAnalyzableSamplePerArm: 10,
    assignments: [],
    ...overrides,
  };
}

function checkFor(result: ReturnType<typeof evaluateExperimentValidity>, code: string) {
  const found = result.checks.find((c) => c.code === code);
  if (!found) throw new Error(`No check with code "${code}" was returned`);
  return found;
}

describe("evaluateExperimentValidity", () => {
  it("1. a balanced, sufficiently-sampled, clean experiment is VALID", () => {
    const assignments = [
      ...Array.from({ length: 12 }, (_, i) => ctx(successUnit("TREATMENT", `t_${i}`))),
      ...Array.from({ length: 12 }, (_, i) => ctx(failureUnit("CONTROL", `c_${i}`))),
    ];
    const result = evaluateExperimentValidity(baseInput({ assignments }));
    expect(result.status).toBe("VALID");
    expect(checkFor(result, "control_contamination").passed).toBe(true);
    expect(checkFor(result, "randomization_integrity").passed).toBe(true);
  });

  it("2. an unequal-allocation experiment (e.g. 90/10) is still VALID when structurally clean", () => {
    const assignments = [
      ...Array.from({ length: 45 }, (_, i) => ctx(successUnit("TREATMENT", `t_${i}`))),
      ...Array.from({ length: 10 }, (_, i) => ctx(failureUnit("CONTROL", `c_${i}`))),
    ];
    const result = evaluateExperimentValidity(baseInput({ assignments, treatmentAllocationPercent: 90, minimumAnalyzableSamplePerArm: 5 }));
    expect(result.status).toBe("VALID");
    expect(checkFor(result, "allocation_sanity")).toMatchObject({ passed: true });
  });

  it("3. missing TREATMENT arm entirely -> INSUFFICIENT_DATA, not INVALID", () => {
    const assignments = Array.from({ length: 12 }, (_, i) => ctx(failureUnit("CONTROL", `c_${i}`)));
    const result = evaluateExperimentValidity(baseInput({ assignments }));
    expect(checkFor(result, "treatment_arm_exists").passed).toBe(false);
    expect(result.status).toBe("INSUFFICIENT_DATA");
  });

  it("4. missing CONTROL arm entirely -> INSUFFICIENT_DATA, not INVALID", () => {
    const assignments = Array.from({ length: 12 }, (_, i) => ctx(successUnit("TREATMENT", `t_${i}`)));
    const result = evaluateExperimentValidity(baseInput({ assignments }));
    expect(checkFor(result, "control_arm_exists").passed).toBe(false);
    expect(result.status).toBe("INSUFFICIENT_DATA");
  });

  it("5. a duplicate assignment (same unitKey twice) -> INVALID", () => {
    const assignments = [
      ctx(successUnit("TREATMENT", "assignment_a", "cust_1")),
      ctx(failureUnit("TREATMENT", "assignment_b", "cust_1")), // same unitKey, different assignmentId - a real duplicate row
    ];
    const result = evaluateExperimentValidity(baseInput({ assignments }));
    const check = checkFor(result, "assignment_uniqueness");
    expect(check.passed).toBe(false);
    expect(check.details?.duplicateUnitKeys).toEqual(["cust_1"]);
    expect(result.status).toBe("INVALID");
  });

  it("6. assignment-after-decision timing violation -> INVALID", () => {
    const assignments = [
      ctx(unit({ arm: "TREATMENT", status: "NOT_ANALYZABLE", exclusionReasons: ["assignment_after_decision"] })),
      ctx(successUnit("CONTROL", "c1")),
    ];
    const result = evaluateExperimentValidity(baseInput({ assignments }));
    expect(checkFor(result, "assignment_before_decision")).toMatchObject({ passed: false });
    expect(result.status).toBe("INVALID");
  });

  it("7. control contamination -> INVALID, and the unit's arm remains CONTROL (never silently reassigned)", () => {
    const contaminated = unit({
      arm: "CONTROL",
      status: "NOT_ANALYZABLE",
      exclusionReasons: ["control_contamination"],
    });
    const assignments = [ctx(contaminated), ctx(successUnit("TREATMENT", "t1"))];
    const result = evaluateExperimentValidity(baseInput({ assignments }));
    expect(checkFor(result, "control_contamination")).toMatchObject({ passed: false, details: { affectedUnits: 1 } });
    expect(contaminated.arm).toBe("CONTROL"); // never mutated
    expect(result.status).toBe("INVALID");
  });

  it("8. treatment/arm inconsistency (same unitKey, two different arms) -> INVALID", () => {
    const assignments = [
      ctx(successUnit("TREATMENT", "assignment_a", "cust_1")),
      ctx(failureUnit("CONTROL", "assignment_b", "cust_1")), // impossible under correct Phase 23 behavior, but provable-from-data if it occurred
    ];
    const result = evaluateExperimentValidity(baseInput({ assignments }));
    const check = checkFor(result, "treatment_arm_consistency");
    expect(check.passed).toBe(false);
    expect(check.details?.affectedUnitKeys).toEqual(["cust_1"]);
    expect(result.status).toBe("INVALID");
  });

  it("9. immature observations are reported, never treated as failures, and do not by themselves invalidate", () => {
    const immature = unit({ arm: "TREATMENT", status: "NOT_ANALYZABLE", exclusionReasons: ["outcome_not_mature"] });
    const assignments = [
      ctx(immature),
      ...Array.from({ length: 12 }, (_, i) => ctx(successUnit("TREATMENT", `t_${i}`))),
      ...Array.from({ length: 12 }, (_, i) => ctx(failureUnit("CONTROL", `c_${i}`))),
    ];
    const result = evaluateExperimentValidity(baseInput({ assignments }));
    const check = checkFor(result, "immature_observations");
    expect(check.severity).toBe("INFO");
    expect(check.passed).toBe(true);
    expect(check.details?.notYetMatureCount).toBe(1);
    expect(result.status).toBe("VALID"); // one immature observation alongside an otherwise clean, sufficient sample
  });

  it("10. unknown outcomes are reported, never counted as success or failure", () => {
    const unknownOnly = unit({ arm: "TREATMENT", status: "NOT_ANALYZABLE", maturedUnknownCandidateCount: 1 });
    const assignments = [ctx(unknownOnly), ctx(successUnit("TREATMENT", "t1")), ctx(failureUnit("CONTROL", "c1"))];
    const result = evaluateExperimentValidity(baseInput({ assignments, minimumAnalyzableSamplePerArm: 1 }));
    const check = checkFor(result, "unknown_outcomes");
    expect(check.passed).toBe(true);
    expect(check.details?.unknownOnlyUnitCount).toBe(1);
  });

  it("11. insufficient sample against a configured minimum -> INSUFFICIENT_DATA, not INVALID", () => {
    const assignments = [ctx(successUnit("TREATMENT", "t1")), ctx(failureUnit("CONTROL", "c1"))];
    const result = evaluateExperimentValidity(baseInput({ assignments, minimumAnalyzableSamplePerArm: 100 }));
    expect(checkFor(result, "sample_size_below_minimum").severity).toBe("WARNING");
    expect(result.status).toBe("INSUFFICIENT_DATA");
  });

  it("12. no configured minimum -> distinct 'cannot declare sufficiency' state, never fabricated as sufficient or insufficient", () => {
    const assignments = Array.from({ length: 100 }, (_, i) => [ctx(successUnit("TREATMENT", `t_${i}`)), ctx(failureUnit("CONTROL", `c_${i}`))]).flat();
    const result = evaluateExperimentValidity(baseInput({ assignments, minimumAnalyzableSamplePerArm: null }));
    const check = checkFor(result, "sample_size_not_configured");
    expect(check.severity).toBe("WARNING");
    expect(result.checks.find((c) => c.code === "sample_size_below_minimum")).toBeUndefined();
    expect(result.checks.find((c) => c.code === "sample_size_meets_minimum")).toBeUndefined();
    expect(result.status).toBe("INSUFFICIENT_DATA");
  });

  it("13. a customer with multiple candidates is already ONE analysis unit - validity never multiplies its weight", () => {
    // analysisUnit.ts already rolled this customer's 3 candidates into a
    // single unit before validity.ts ever sees it - this test proves
    // validity.ts treats that single row as exactly one observation.
    const customerUnit = unit({ unitType: "CUSTOMER", unitKey: "cust_multi", arm: "TREATMENT", status: "ANALYZABLE", outcome: "SUCCESS", candidateCount: 3, analyzableSuccessCount: 2, analyzableFailureCount: 1, recoveredAmount: 5000 });
    const assignments = [ctx(customerUnit), ctx(failureUnit("CONTROL", "c1"))];
    const result = evaluateExperimentValidity(baseInput({ assignments, minimumAnalyzableSamplePerArm: 1 }));
    expect(checkFor(result, "assignment_uniqueness").passed).toBe(true); // one unitKey, one row - not 3
    const treatmentCount = result.checks.find((c) => c.code === "sample_size_meets_minimum")?.details?.analyzableTreatmentCount;
    expect(treatmentCount).toBe(1);
  });

  it("14. a guest CANDIDATE-unit assignment is validated identically to a CUSTOMER unit", () => {
    const guestUnit = unit({ unitType: "CANDIDATE", unitKey: "risk_guest_1", arm: "TREATMENT", status: "ANALYZABLE", outcome: "SUCCESS", recoveredAmount: 2000 });
    const assignments = [ctx(guestUnit), ctx(failureUnit("CONTROL", "c1"))];
    const result = evaluateExperimentValidity(baseInput({ assignments, minimumAnalyzableSamplePerArm: 1 }));
    expect(result.status).toBe("VALID");
  });

  it("15. an assignment belonging to a different experiment -> INVALID, never silently combined", () => {
    const assignments = [ctx(successUnit("TREATMENT", "t1")), ctx(failureUnit("CONTROL", "c1"), "exp_other")];
    const result = evaluateExperimentValidity(baseInput({ assignments, minimumAnalyzableSamplePerArm: 1 }));
    const check = checkFor(result, "experiment_isolation");
    expect(check.passed).toBe(false);
    expect(check.details?.foreignAssignmentCount).toBe(1);
    expect(result.status).toBe("INVALID");
  });

  it("16. intention-to-treat is preserved: a contaminated observation still reports CONTROL, never TREATMENT", () => {
    const contaminated = unit({ arm: "CONTROL", status: "NOT_ANALYZABLE", exclusionReasons: ["control_contamination"] });
    const result = evaluateExperimentValidity(baseInput({ assignments: [ctx(contaminated)] }));
    expect(checkFor(result, "intention_to_treat_integrity").passed).toBe(true); // arm is correctly still CONTROL
  });

  it("17. a structurally VALID experiment with an equal (inconclusive-looking) split is still VALID - validity never depends on the size of any difference", () => {
    const assignments = [
      ...Array.from({ length: 20 }, (_, i) => ctx(successUnit("TREATMENT", `t_${i}`))),
      ...Array.from({ length: 20 }, (_, i) => ctx(successUnit("CONTROL", `c_${i}`))),
    ];
    const result = evaluateExperimentValidity(baseInput({ assignments, minimumAnalyzableSamplePerArm: 10 }));
    expect(result.status).toBe("VALID");
    // Nothing in this module computed a rate or a difference - it has no opinion on "did treatment win."
    expect(result.checks.every((c) => !("rate" in (c.details ?? {})))).toBe(true);
  });

  it("reports the documented execution-before-outcome timing limitation explicitly rather than guessing", () => {
    const result = evaluateExperimentValidity(baseInput({ assignments: [] }));
    const check = checkFor(result, "execution_before_outcome_timing_unprovable");
    expect(check.details?.provable).toBe(false);
  });

  it("zero assignments at all -> INSUFFICIENT_DATA, not INVALID and not a crash", () => {
    const result = evaluateExperimentValidity(baseInput({ assignments: [] }));
    expect(result.status).toBe("INSUFFICIENT_DATA");
  });

  it("a DRAFT experiment with assignments present is a structural contradiction -> INVALID", () => {
    const result = evaluateExperimentValidity(
      baseInput({ experimentStatus: "DRAFT", assignments: [ctx(successUnit("TREATMENT", "t1"))] })
    );
    expect(checkFor(result, "experiment_not_draft_with_assignments").passed).toBe(false);
    expect(result.status).toBe("INVALID");
  });

  it("allocation out of bounds (e.g. 100%) -> INVALID", () => {
    const assignments = Array.from({ length: 12 }, (_, i) => ctx(successUnit("TREATMENT", `t_${i}`)));
    const result = evaluateExperimentValidity(baseInput({ assignments, treatmentAllocationPercent: 100 }));
    expect(checkFor(result, "allocation_sanity").passed).toBe(false);
    expect(result.status).toBe("INVALID");
  });

  it("unconfigured allocation is reported as unverifiable, not assumed valid", () => {
    const result = evaluateExperimentValidity(baseInput({ treatmentAllocationPercent: null, assignments: [] }));
    expect(checkFor(result, "allocation_not_configured").passed).toBe(false);
  });
});
