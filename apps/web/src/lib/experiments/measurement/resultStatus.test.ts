import { describe, expect, it } from "vitest";
import { composeMeasurementResult, ResultStatusInput } from "./resultStatus";
import { ObservedDifferenceResult } from "./statistics";

function computedDifference(observedDifference: number, lower: number, upper: number): ObservedDifferenceResult {
  return {
    status: "computed",
    label: "OBSERVED_TREATMENT_CONTROL_DIFFERENCE",
    treatmentRate: 0.5 + observedDifference / 2,
    controlRate: 0.5 - observedDifference / 2,
    observedDifference,
    confidenceInterval: { lower, upper },
  };
}

function baseInput(overrides: Partial<ResultStatusInput> = {}): ResultStatusInput {
  return {
    experimentStatus: "RUNNING",
    validityStatus: "VALID",
    observedDifference: computedDifference(0, -0.01, 0.01),
    minimumPracticalEffect: null,
    fullyMatured: false,
    ...overrides,
  };
}

describe("composeMeasurementResult", () => {
  it("1. INVALID experiment -> resultStatus INVALID regardless of the observed difference", () => {
    const result = composeMeasurementResult(
      baseInput({ validityStatus: "INVALID", observedDifference: computedDifference(0.5, 0.4, 0.6) })
    );
    expect(result.resultStatus).toBe("INVALID");
  });

  it("2. insufficient sample -> resultStatus INSUFFICIENT_DATA regardless of the observed difference", () => {
    const result = composeMeasurementResult(
      baseInput({ validityStatus: "INSUFFICIENT_DATA", observedDifference: computedDifference(0.5, 0.4, 0.6) })
    );
    expect(result.resultStatus).toBe("INSUFFICIENT_DATA");
  });

  it("3. VALID but no detectable effect (CI straddles zero) -> VALID_INCONCLUSIVE", () => {
    const result = composeMeasurementResult(
      baseInput({
        validityStatus: "VALID",
        observedDifference: computedDifference(0.01, -0.05, 0.07),
        minimumPracticalEffect: { minimumRateDifference: 0.02 },
      })
    );
    expect(result.resultStatus).toBe("VALID_INCONCLUSIVE");
  });

  it("4. CRITICAL: a large positive effect with NO configured practical threshold is NEVER VALID_EFFECT", () => {
    // treatment vastly outperforms control (0.9 vs 0.1) and the CI is
    // nowhere near zero - this is exactly the case the critical refinement
    // forbids from becoming VALID_EFFECT on its own.
    const result = composeMeasurementResult(
      baseInput({
        validityStatus: "VALID",
        observedDifference: computedDifference(0.8, 0.7, 0.9),
        minimumPracticalEffect: null,
      })
    );
    expect(result.resultStatus).toBe("VALID_INCONCLUSIVE");
  });

  it("5. positive effect WITH a configured practical threshold it clears -> VALID_EFFECT", () => {
    const result = composeMeasurementResult(
      baseInput({
        validityStatus: "VALID",
        observedDifference: computedDifference(0.1, 0.06, 0.14), // lower bound 0.06 clears the 0.05 threshold
        minimumPracticalEffect: { minimumRateDifference: 0.05 },
      })
    );
    expect(result.resultStatus).toBe("VALID_EFFECT");
  });

  it("5b. positive effect WITH a configured threshold it does NOT clear (CI lower below threshold) -> VALID_INCONCLUSIVE", () => {
    const result = composeMeasurementResult(
      baseInput({
        validityStatus: "VALID",
        observedDifference: computedDifference(0.06, 0.01, 0.11), // lower bound 0.01 does NOT clear 0.05
        minimumPracticalEffect: { minimumRateDifference: 0.05 },
      })
    );
    expect(result.resultStatus).toBe("VALID_INCONCLUSIVE");
  });

  it("6. negative effect that clears the threshold in the harmful direction -> VALID_EFFECT", () => {
    const result = composeMeasurementResult(
      baseInput({
        validityStatus: "VALID",
        observedDifference: computedDifference(-0.1, -0.14, -0.06), // upper bound -0.06 clears -0.05
        minimumPracticalEffect: { minimumRateDifference: 0.05 },
      })
    );
    expect(result.resultStatus).toBe("VALID_EFFECT");
  });

  it("6b. negative effect that does NOT clear the threshold -> VALID_INCONCLUSIVE", () => {
    const result = composeMeasurementResult(
      baseInput({
        validityStatus: "VALID",
        observedDifference: computedDifference(-0.03, -0.08, 0.02), // CI straddles zero
        minimumPracticalEffect: { minimumRateDifference: 0.05 },
      })
    );
    expect(result.resultStatus).toBe("VALID_INCONCLUSIVE");
  });

  it("7. exactly zero effect -> VALID_INCONCLUSIVE regardless of threshold configuration", () => {
    const result = composeMeasurementResult(
      baseInput({
        validityStatus: "VALID",
        observedDifference: computedDifference(0, -0.02, 0.02),
        minimumPracticalEffect: { minimumRateDifference: 0.01 },
      })
    );
    expect(result.resultStatus).toBe("VALID_INCONCLUSIVE");
  });

  it("8. statistically uncertain effect (very wide CI spanning positive, zero, and negative) -> VALID_INCONCLUSIVE", () => {
    const result = composeMeasurementResult(
      baseInput({
        validityStatus: "VALID",
        observedDifference: computedDifference(0.05, -0.3, 0.4),
        minimumPracticalEffect: { minimumRateDifference: 0.05 },
      })
    );
    expect(result.resultStatus).toBe("VALID_INCONCLUSIVE");
  });

  it("9. a boundary effect exactly AT the threshold (CI lower == threshold) qualifies as VALID_EFFECT (inclusive boundary)", () => {
    const result = composeMeasurementResult(
      baseInput({
        validityStatus: "VALID",
        observedDifference: computedDifference(0.1, 0.05, 0.15),
        minimumPracticalEffect: { minimumRateDifference: 0.05 },
      })
    );
    expect(result.resultStatus).toBe("VALID_EFFECT");
  });

  it("defensive: VALID validity but an undefined observed-difference result -> VALID_INCONCLUSIVE, never a crash or fabricated status", () => {
    const result = composeMeasurementResult(
      baseInput({
        validityStatus: "VALID",
        observedDifference: { status: "undefined", reason: "insufficient_data" },
        minimumPracticalEffect: { minimumRateDifference: 0.05 },
      })
    );
    expect(result.resultStatus).toBe("VALID_INCONCLUSIVE");
  });

  describe("resultKind: FINAL vs INTERIM", () => {
    it("10. RUNNING experiment -> always INTERIM, regardless of maturity", () => {
      const result = composeMeasurementResult(baseInput({ experimentStatus: "RUNNING", fullyMatured: true }));
      expect(result.resultKind).toBe("INTERIM");
    });

    it("COMPLETED but NOT fully matured -> still INTERIM, never FINAL", () => {
      const result = composeMeasurementResult(baseInput({ experimentStatus: "COMPLETED", fullyMatured: false }));
      expect(result.resultKind).toBe("INTERIM");
    });

    it("COMPLETED and fully matured -> FINAL", () => {
      const result = composeMeasurementResult(baseInput({ experimentStatus: "COMPLETED", fullyMatured: true }));
      expect(result.resultKind).toBe("FINAL");
    });

    it("PAUSED experiment -> INTERIM even if fully matured", () => {
      const result = composeMeasurementResult(baseInput({ experimentStatus: "PAUSED", fullyMatured: true }));
      expect(result.resultKind).toBe("INTERIM");
    });

    it("resultKind is independent of resultStatus - an INVALID result can still be labeled FINAL", () => {
      const result = composeMeasurementResult(
        baseInput({ experimentStatus: "COMPLETED", fullyMatured: true, validityStatus: "INVALID" })
      );
      expect(result).toEqual({ resultStatus: "INVALID", resultKind: "FINAL" });
    });
  });
});
