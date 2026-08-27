import { describe, expect, it } from "vitest";
import { AnalysisUnit } from "./analysisUnit";
import {
  computeGMVStats,
  computeIncrementalGMV,
  computeObservedDifference,
  computeRecoveryRateStats,
  computeRequiredSampleSize,
  computeUnknownSensitivity,
  inverseNormalCDF,
  wilsonInterval,
} from "./statistics";

function unit(overrides: Partial<AnalysisUnit> = {}): AnalysisUnit {
  return {
    assignmentId: "a1",
    unitType: "CANDIDATE",
    unitKey: "k1",
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

function successUnit(arm: "TREATMENT" | "CONTROL", amount: number, unitKey = "k"): AnalysisUnit {
  return unit({ arm, unitKey, status: "ANALYZABLE", outcome: "SUCCESS", analyzableSuccessCount: 1, recoveredAmount: amount });
}
function failureUnit(arm: "TREATMENT" | "CONTROL", unitKey = "k"): AnalysisUnit {
  return unit({ arm, unitKey, status: "ANALYZABLE", outcome: "FAILURE", analyzableFailureCount: 1 });
}
function unknownOnlyUnit(arm: "TREATMENT" | "CONTROL", unitKey = "k"): AnalysisUnit {
  return unit({ arm, unitKey, status: "NOT_ANALYZABLE", maturedUnknownCandidateCount: 1 });
}

describe("inverseNormalCDF", () => {
  it("matches well-known reference z-scores", () => {
    expect(inverseNormalCDF(0.975)).toBeCloseTo(1.959964, 5);
    expect(inverseNormalCDF(0.8)).toBeCloseTo(0.841621, 5);
    expect(inverseNormalCDF(0.995)).toBeCloseTo(2.575829, 5);
  });

  it("is 0 at p=0.5", () => {
    expect(inverseNormalCDF(0.5)).toBeCloseTo(0, 9);
  });

  it("is antisymmetric: invNorm(p) = -invNorm(1-p)", () => {
    expect(inverseNormalCDF(0.9)).toBeCloseTo(-inverseNormalCDF(0.1), 6);
  });

  it("throws on out-of-range input rather than returning a misleading number", () => {
    expect(() => inverseNormalCDF(0)).toThrow(RangeError);
    expect(() => inverseNormalCDF(1)).toThrow(RangeError);
    expect(() => inverseNormalCDF(-0.1)).toThrow(RangeError);
  });
});

describe("wilsonInterval", () => {
  it("zero trials -> explicit undefined, never NaN/Infinity", () => {
    const result = wilsonInterval(0, 0, 0.95);
    expect(result).toEqual({ status: "undefined", reason: "zero_trials" });
  });

  it("zero successes -> lower bound is exactly 0 (proven algebraically, not approximated)", () => {
    const result = wilsonInterval(0, 1, 0.95);
    expect(result.status).toBe("computed");
    if (result.status === "computed") {
      expect(result.lower).toBe(0);
      expect(result.upper).toBeCloseTo(0.7935, 3); // z^2/(n+z^2) with n=1
      expect(result.upper).toBeLessThan(1);
    }
  });

  it("all successes -> upper bound is exactly 1 (symmetric to the zero-success case)", () => {
    const result = wilsonInterval(1, 1, 0.95);
    expect(result.status).toBe("computed");
    if (result.status === "computed") {
      expect(result.upper).toBe(1);
      expect(result.lower).toBeCloseTo(1 - 0.7935, 3);
      expect(result.lower).toBeGreaterThan(0);
    }
  });

  it("known reference case: 10/20 (p=0.5) at 95% -> [0.299, 0.701] (Agresti-Coull 1998 comparison table)", () => {
    const result = wilsonInterval(10, 20, 0.95);
    expect(result.status).toBe("computed");
    if (result.status === "computed") {
      expect(result.pointEstimate).toBe(0.5);
      expect(result.lower).toBeCloseTo(0.299, 3);
      expect(result.upper).toBeCloseTo(0.701, 3);
    }
  });

  it("very small n still returns a well-formed (very wide) interval, not a crash", () => {
    const result = wilsonInterval(1, 2, 0.95);
    expect(result.status).toBe("computed");
    if (result.status === "computed") {
      expect(result.lower).toBeGreaterThanOrEqual(0);
      expect(result.upper).toBeLessThanOrEqual(1);
      expect(result.upper - result.lower).toBeGreaterThan(0.5); // genuinely wide at n=2
    }
  });

  it("normal interior case: bounds bracket the point estimate", () => {
    const result = wilsonInterval(37, 100, 0.95);
    expect(result.status).toBe("computed");
    if (result.status === "computed") {
      expect(result.lower).toBeLessThan(result.pointEstimate);
      expect(result.pointEstimate).toBeLessThan(result.upper);
    }
  });

  it("invalid inputs are rejected explicitly rather than silently computed", () => {
    expect(wilsonInterval(-1, 10, 0.95)).toEqual({ status: "undefined", reason: "invalid_input" });
    expect(wilsonInterval(11, 10, 0.95)).toEqual({ status: "undefined", reason: "invalid_input" });
    expect(wilsonInterval(5, 10, 0)).toEqual({ status: "undefined", reason: "invalid_input" });
    expect(wilsonInterval(5, 10, 1)).toEqual({ status: "undefined", reason: "invalid_input" });
    expect(wilsonInterval(5.5, 10, 0.95)).toEqual({ status: "undefined", reason: "invalid_input" });
  });
});

describe("computeRecoveryRateStats", () => {
  it("counts only ANALYZABLE units of the requested arm", () => {
    const units = [
      successUnit("TREATMENT", 1000, "t1"),
      failureUnit("TREATMENT", "t2"),
      successUnit("CONTROL", 500, "c1"),
      unit({ arm: "TREATMENT", unitKey: "t3", status: "NOT_ANALYZABLE" }), // excluded
    ];
    const stats = computeRecoveryRateStats(units, "TREATMENT", 0.95);
    expect(stats).toMatchObject({ arm: "TREATMENT", analyzableUnits: 2, successes: 1, failures: 1, rate: 0.5 });
    expect(stats.confidenceInterval.status).toBe("computed");
  });

  it("CONTROL and TREATMENT are computed independently", () => {
    const units = [successUnit("TREATMENT", 1000), successUnit("TREATMENT", 1000), failureUnit("CONTROL")];
    const treatment = computeRecoveryRateStats(units, "TREATMENT", 0.95);
    const control = computeRecoveryRateStats(units, "CONTROL", 0.95);
    expect(treatment.rate).toBe(1);
    expect(control.rate).toBe(0);
  });

  it("zero analyzable units -> rate null, interval undefined, not NaN", () => {
    const stats = computeRecoveryRateStats([], "TREATMENT", 0.95);
    expect(stats.rate).toBeNull();
    expect(stats.confidenceInterval).toEqual({ status: "undefined", reason: "zero_trials" });
  });
});

describe("computeObservedDifference", () => {
  it("treatment > control produces a positive observed difference, explicitly labeled", () => {
    const units = [
      successUnit("TREATMENT", 1000, "t1"), successUnit("TREATMENT", 1000, "t2"), failureUnit("TREATMENT", "t3"), failureUnit("TREATMENT", "t4"),
      successUnit("CONTROL", 500, "c1"), failureUnit("CONTROL", "c2"), failureUnit("CONTROL", "c3"), failureUnit("CONTROL", "c4"),
    ];
    const treatment = computeRecoveryRateStats(units, "TREATMENT", 0.95);
    const control = computeRecoveryRateStats(units, "CONTROL", 0.95);
    const diff = computeObservedDifference(treatment, control);
    expect(diff.status).toBe("computed");
    if (diff.status === "computed") {
      expect(diff.label).toBe("OBSERVED_TREATMENT_CONTROL_DIFFERENCE");
      expect(diff.observedDifference).toBeCloseTo(0.5 - 0.25, 10);
      expect(diff.confidenceInterval.lower).toBeLessThanOrEqual(diff.observedDifference);
      expect(diff.confidenceInterval.upper).toBeGreaterThanOrEqual(diff.observedDifference);
    }
  });

  it("treatment < control produces a negative observed difference", () => {
    const units = [failureUnit("TREATMENT", "t1"), failureUnit("TREATMENT", "t2"), successUnit("CONTROL", 500, "c1"), successUnit("CONTROL", 500, "c2")];
    const diff = computeObservedDifference(computeRecoveryRateStats(units, "TREATMENT", 0.95), computeRecoveryRateStats(units, "CONTROL", 0.95));
    expect(diff.status).toBe("computed");
    if (diff.status === "computed") expect(diff.observedDifference).toBeLessThan(0);
  });

  it("treatment = control produces zero observed difference with a symmetric interval around 0", () => {
    const units = [
      successUnit("TREATMENT", 1000, "t1"), failureUnit("TREATMENT", "t2"),
      successUnit("CONTROL", 500, "c1"), failureUnit("CONTROL", "c2"),
    ];
    const diff = computeObservedDifference(computeRecoveryRateStats(units, "TREATMENT", 0.95), computeRecoveryRateStats(units, "CONTROL", 0.95));
    expect(diff.status).toBe("computed");
    if (diff.status === "computed") {
      expect(diff.observedDifference).toBe(0);
      expect(diff.confidenceInterval.lower).toBeCloseTo(-diff.confidenceInterval.upper, 10);
    }
  });

  it("propagates insufficient_data when either arm has zero analyzable units", () => {
    const diff = computeObservedDifference(computeRecoveryRateStats([], "TREATMENT", 0.95), computeRecoveryRateStats([successUnit("CONTROL", 500)], "CONTROL", 0.95));
    expect(diff).toEqual({ status: "undefined", reason: "insufficient_data" });
  });
});

describe("computeGMVStats", () => {
  it("sums recoveredAmount across analyzable units of one arm as exact integers", () => {
    const units = [successUnit("TREATMENT", 1234), successUnit("TREATMENT", 5000), failureUnit("TREATMENT")];
    const stats = computeGMVStats(units, "TREATMENT");
    expect(stats.recoveredGMV).toBe(6234);
    expect(Number.isInteger(stats.recoveredGMV)).toBe(true);
  });

  it("zero GMV when there are no successes", () => {
    const stats = computeGMVStats([failureUnit("TREATMENT")], "TREATMENT");
    expect(stats.recoveredGMV).toBe(0);
  });

  it("a customer unit with multiple successful candidates already carries its summed amount (from analysisUnit.ts) - GMV stats do not re-sum per candidate", () => {
    const units = [unit({ arm: "TREATMENT", status: "ANALYZABLE", outcome: "SUCCESS", recoveredAmount: 3000 + 2000, candidateCount: 2, analyzableSuccessCount: 2 })];
    expect(computeGMVStats(units, "TREATMENT").recoveredGMV).toBe(5000);
  });
});

describe("computeIncrementalGMV", () => {
  it("worked reference example: exact integer-paise result with no floating point", () => {
    // TS=2, TA=10, CS=1, CA=10, TG=10000 -> counterfactual = (1*10000*10)/(10*2) = 5000
    const treatment = { arm: "TREATMENT" as const, recoveredGMV: 10000, analyzableUnits: 10, successUnits: 2 };
    const control = { arm: "CONTROL" as const, recoveredGMV: 3000, analyzableUnits: 10, successUnits: 1 };
    const result = computeIncrementalGMV(treatment, control);
    expect(result).toEqual({
      status: "computed",
      observedTreatmentGMV: 10000,
      observedControlGMV: 3000,
      estimatedCounterfactualTreatmentGMV: 5000,
      estimatedIncrementalGMV: 5000,
    });
  });

  it("unequal allocation: equal underlying rates (10 vs 90 population) -> zero estimated incremental, proving this is NOT a raw GMV subtraction", () => {
    // Same 10% recovery rate in both arms despite 90/10 population split.
    const treatment = { arm: "TREATMENT" as const, recoveredGMV: 9000, analyzableUnits: 90, successUnits: 9 }; // 10% rate, avg 1000/success
    const control = { arm: "CONTROL" as const, recoveredGMV: 1000, analyzableUnits: 10, successUnits: 1 }; // 10% rate
    const result = computeIncrementalGMV(treatment, control);
    expect(result.status).toBe("computed");
    if (result.status === "computed") {
      expect(result.estimatedIncrementalGMV).toBe(0);
      // A naive raw subtraction (9000 - 1000 = 8000) would be wildly wrong here.
      expect(result.estimatedIncrementalGMV).not.toBe(result.observedTreatmentGMV - result.observedControlGMV);
    }
  });

  it("zero control successes -> counterfactual is 0, entire treatment GMV counted as incremental", () => {
    const treatment = { arm: "TREATMENT" as const, recoveredGMV: 5000, analyzableUnits: 10, successUnits: 1 };
    const control = { arm: "CONTROL" as const, recoveredGMV: 0, analyzableUnits: 10, successUnits: 0 };
    const result = computeIncrementalGMV(treatment, control);
    expect(result).toEqual({
      status: "computed",
      observedTreatmentGMV: 5000,
      observedControlGMV: 0,
      estimatedCounterfactualTreatmentGMV: 0,
      estimatedIncrementalGMV: 5000,
    });
  });

  it("zero treatment successes -> undefined, not a fabricated zero (no anchor value to scale by)", () => {
    const result = computeIncrementalGMV(
      { arm: "TREATMENT", recoveredGMV: 0, analyzableUnits: 10, successUnits: 0 },
      { arm: "CONTROL", recoveredGMV: 1000, analyzableUnits: 10, successUnits: 1 }
    );
    expect(result).toEqual({ status: "undefined", reason: "zero_treatment_successes" });
  });

  it("zero treatment analyzable units -> undefined", () => {
    const result = computeIncrementalGMV(
      { arm: "TREATMENT", recoveredGMV: 0, analyzableUnits: 0, successUnits: 0 },
      { arm: "CONTROL", recoveredGMV: 1000, analyzableUnits: 10, successUnits: 1 }
    );
    expect(result).toEqual({ status: "undefined", reason: "zero_treatment_analyzable_units" });
  });

  it("zero control analyzable units -> undefined (no counterfactual rate to estimate from)", () => {
    const result = computeIncrementalGMV(
      { arm: "TREATMENT", recoveredGMV: 5000, analyzableUnits: 10, successUnits: 1 },
      { arm: "CONTROL", recoveredGMV: 0, analyzableUnits: 0, successUnits: 0 }
    );
    expect(result).toEqual({ status: "undefined", reason: "zero_control_analyzable_units" });
  });

  it("exact rounding: a non-terminating fraction rounds to the nearest paisa exactly once", () => {
    // (CS*TG*TA)/(CA*TS) = (1*100*3)/(3*1) = 100 exactly - pick a case that
    // is NOT exact to force real rounding: CS=1,TG=100,TA=1,CA=3,TS=1 -> 100/3 = 33.33... -> 33
    const treatment = { arm: "TREATMENT" as const, recoveredGMV: 100, analyzableUnits: 1, successUnits: 1 };
    const control = { arm: "CONTROL" as const, recoveredGMV: 999, analyzableUnits: 3, successUnits: 1 };
    const result = computeIncrementalGMV(treatment, control);
    // counterfactual = (1*100*1)/(3*1) = 33.333... -> rounds to 33
    expect(result.status).toBe("computed");
    if (result.status === "computed") {
      expect(result.estimatedCounterfactualTreatmentGMV).toBe(33);
      expect(Number.isInteger(result.estimatedCounterfactualTreatmentGMV)).toBe(true);
    }
  });
});

describe("computeUnknownSensitivity", () => {
  it("no UNKNOWN units -> best case, worst case, and observed are identical", () => {
    const units = [successUnit("TREATMENT", 1000, "t1"), failureUnit("TREATMENT", "t2")];
    const result = computeUnknownSensitivity(units, "TREATMENT");
    expect(result.label).toBe("UNKNOWN_SENSITIVITY_BOUND");
    expect(result.unknownOnlyUnitCount).toBe(0);
    expect(result.bestCase).toEqual(result.observed);
    expect(result.worstCase).toEqual(result.observed);
  });

  it("some UNKNOWN units -> best case counts them as success, worst case does not", () => {
    const units = [successUnit("TREATMENT", 1000, "t1"), failureUnit("TREATMENT", "t2"), unknownOnlyUnit("TREATMENT", "t3")];
    const result = computeUnknownSensitivity(units, "TREATMENT");
    expect(result.observed).toEqual({ successes: 1, analyzableUnits: 2, rate: 0.5 });
    expect(result.unknownOnlyUnitCount).toBe(1);
    expect(result.bestCase).toEqual({ successes: 2, analyzableUnits: 3, rate: 2 / 3 });
    expect(result.worstCase).toEqual({ successes: 1, analyzableUnits: 3, rate: 1 / 3 });
  });

  it("all UNKNOWN units (no ordinary analyzable data at all) -> observed rate is null, best/worst still computable", () => {
    const units = [unknownOnlyUnit("TREATMENT", "t1"), unknownOnlyUnit("TREATMENT", "t2")];
    const result = computeUnknownSensitivity(units, "TREATMENT");
    expect(result.observed).toEqual({ successes: 0, analyzableUnits: 0, rate: null });
    expect(result.bestCase).toEqual({ successes: 2, analyzableUnits: 2, rate: 1 });
    expect(result.worstCase).toEqual({ successes: 0, analyzableUnits: 2, rate: 0 });
  });

  it("a unit that already has an analyzable success is never double-counted as unknown-only, even if it also has an unknown candidate", () => {
    const mixedUnit = unit({
      arm: "TREATMENT",
      status: "ANALYZABLE",
      outcome: "SUCCESS",
      recoveredAmount: 4000,
      maturedUnknownCandidateCount: 1, // this unit has BOTH a resolved success and an unknown candidate
    });
    const result = computeUnknownSensitivity([mixedUnit], "TREATMENT");
    expect(result.unknownOnlyUnitCount).toBe(0); // not unknown-ONLY - it already contributed via the success
    expect(result.observed).toEqual({ successes: 1, analyzableUnits: 1, rate: 1 });
  });
});

describe("computeRequiredSampleSize", () => {
  it("reference case: baseline 10%, MDE 5pp, alpha 0.05, power 0.8, 50/50 allocation", () => {
    const result = computeRequiredSampleSize({
      baselineRate: 0.1,
      minimumDetectableEffect: 0.05,
      alpha: 0.05,
      power: 0.8,
      treatmentAllocationPercent: 50,
    });
    expect(result.status).toBe("computed");
    if (result.status === "computed") {
      // Hand-derived via the same formula: ~683 per arm - allow a small
      // tolerance for manual-arithmetic rounding, not for the code's own
      // (deterministic) computation.
      expect(result.requiredControlUnits).toBeGreaterThan(670);
      expect(result.requiredControlUnits).toBeLessThan(700);
      expect(result.requiredTreatmentUnits).toBe(result.requiredControlUnits); // kappa=1 at 50/50
      expect(result.requiredTotalUnits).toBe(result.requiredControlUnits + result.requiredTreatmentUnits);
    }
  });

  it("higher power requires a larger sample, all else equal", () => {
    const base = { baselineRate: 0.1, minimumDetectableEffect: 0.05, alpha: 0.05, treatmentAllocationPercent: 50 };
    const lowPower = computeRequiredSampleSize({ ...base, power: 0.8 });
    const highPower = computeRequiredSampleSize({ ...base, power: 0.9 });
    if (lowPower.status === "computed" && highPower.status === "computed") {
      expect(highPower.requiredTotalUnits).toBeGreaterThan(lowPower.requiredTotalUnits);
    } else {
      throw new Error("expected both to compute");
    }
  });

  it("a larger minimum detectable effect requires a smaller sample, all else equal", () => {
    const base = { baselineRate: 0.1, alpha: 0.05, power: 0.8, treatmentAllocationPercent: 50 };
    const smallMDE = computeRequiredSampleSize({ ...base, minimumDetectableEffect: 0.02 });
    const largeMDE = computeRequiredSampleSize({ ...base, minimumDetectableEffect: 0.1 });
    if (smallMDE.status === "computed" && largeMDE.status === "computed") {
      expect(largeMDE.requiredTotalUnits).toBeLessThan(smallMDE.requiredTotalUnits);
    } else {
      throw new Error("expected both to compute");
    }
  });

  it("unequal allocation scales treatment/control units by the allocation ratio (kappa)", () => {
    const result = computeRequiredSampleSize({
      baselineRate: 0.1,
      minimumDetectableEffect: 0.05,
      alpha: 0.05,
      power: 0.8,
      treatmentAllocationPercent: 10, // kappa = 10/90
    });
    expect(result.status).toBe("computed");
    if (result.status === "computed") {
      expect(result.requiredTreatmentUnits).toBeLessThan(result.requiredControlUnits);
    }
  });

  it("rejects invalid inputs explicitly rather than dividing by zero or returning NaN", () => {
    const base = { baselineRate: 0.1, minimumDetectableEffect: 0.05, alpha: 0.05, power: 0.8, treatmentAllocationPercent: 50 };
    expect(computeRequiredSampleSize({ ...base, treatmentAllocationPercent: 0 })).toEqual({ status: "undefined", reason: "invalid_input" });
    expect(computeRequiredSampleSize({ ...base, treatmentAllocationPercent: 100 })).toEqual({ status: "undefined", reason: "invalid_input" });
    expect(computeRequiredSampleSize({ ...base, baselineRate: 0 })).toEqual({ status: "undefined", reason: "invalid_input" });
    expect(computeRequiredSampleSize({ ...base, baselineRate: 0.98, minimumDetectableEffect: 0.05 })).toEqual({ status: "undefined", reason: "invalid_input" });
    expect(computeRequiredSampleSize({ ...base, alpha: 1 })).toEqual({ status: "undefined", reason: "invalid_input" });
    expect(computeRequiredSampleSize({ ...base, power: 0 })).toEqual({ status: "undefined", reason: "invalid_input" });
  });
});
