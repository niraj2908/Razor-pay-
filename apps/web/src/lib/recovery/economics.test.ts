import { describe, expect, it } from "vitest";
import { calculateExpectedIncrementalValue } from "./economics";

describe("calculateExpectedIncrementalValue", () => {
  it("returns a positive value when intervention uplift outweighs cost", () => {
    const result = calculateExpectedIncrementalValue({
      amount: 10000, // ₹100
      naturalRecoveryProbability: 0.2,
      interventionRecoveryProbability: 0.6,
      interventionCost: 100,
      riskPenalty: 0,
    });
    // 10000 * 0.4 - 100 = 3900
    expect(result.expectedIncrementalValue).toBe(3900);
    expect(result.incrementalRecoveryProbability).toBeCloseTo(0.4);
    expect(result.calculationVersion).toBe("economics-v1");
  });

  it("returns a negative value when intervention makes things worse than doing nothing", () => {
    const result = calculateExpectedIncrementalValue({
      amount: 10000,
      naturalRecoveryProbability: 0.6,
      interventionRecoveryProbability: 0.5,
      interventionCost: 50,
      riskPenalty: 0,
    });
    // 10000 * -0.1 - 50 = -1050
    expect(result.expectedIncrementalValue).toBe(-1050);
    expect(result.incrementalRecoveryProbability).toBeCloseTo(-0.1);
  });

  it("returns exactly the negative cost/penalty when uplift is zero", () => {
    const result = calculateExpectedIncrementalValue({
      amount: 10000,
      naturalRecoveryProbability: 0.4,
      interventionRecoveryProbability: 0.4,
      interventionCost: 200,
      riskPenalty: 50,
    });
    expect(result.expectedIncrementalValue).toBe(-250);
    expect(result.incrementalRecoveryProbability).toBe(0);
  });

  it("produces a small value when natural recovery is already high", () => {
    const result = calculateExpectedIncrementalValue({
      amount: 10000,
      naturalRecoveryProbability: 0.85,
      interventionRecoveryProbability: 0.9,
      interventionCost: 200,
      riskPenalty: 0,
    });
    // 10000 * 0.05 - 200 = 300
    expect(result.expectedIncrementalValue).toBe(300);
  });

  it("produces a large value for high intervention uplift", () => {
    const result = calculateExpectedIncrementalValue({
      amount: 100000, // ₹1000
      naturalRecoveryProbability: 0.05,
      interventionRecoveryProbability: 0.8,
      interventionCost: 200,
      riskPenalty: 0,
    });
    // 100000 * 0.75 - 200 = 74800
    expect(result.expectedIncrementalValue).toBe(74800);
  });

  it("goes negative when intervention cost is high relative to the uplift", () => {
    const result = calculateExpectedIncrementalValue({
      amount: 5000, // ₹50
      naturalRecoveryProbability: 0.3,
      interventionRecoveryProbability: 0.5,
      interventionCost: 2000, // ₹20 - disproportionate to a ₹50 payment
      riskPenalty: 0,
    });
    // 5000 * 0.2 - 2000 = -1000
    expect(result.expectedIncrementalValue).toBe(-1000);
  });

  it("returns exactly -(cost+penalty) for a zero-amount payment regardless of probabilities", () => {
    const result = calculateExpectedIncrementalValue({
      amount: 0,
      naturalRecoveryProbability: 0.1,
      interventionRecoveryProbability: 0.9,
      interventionCost: 100,
      riskPenalty: 25,
    });
    expect(result.expectedIncrementalValue).toBe(-125);
  });

  it("throws for a probability outside [0,1]", () => {
    expect(() =>
      calculateExpectedIncrementalValue({
        amount: 1000,
        naturalRecoveryProbability: 1.1,
        interventionRecoveryProbability: 0.5,
        interventionCost: 0,
        riskPenalty: 0,
      })
    ).toThrow(/naturalRecoveryProbability/);

    expect(() =>
      calculateExpectedIncrementalValue({
        amount: 1000,
        naturalRecoveryProbability: 0.5,
        interventionRecoveryProbability: -0.01,
        interventionCost: 0,
        riskPenalty: 0,
      })
    ).toThrow(/interventionRecoveryProbability/);
  });

  it("accepts exact boundary probabilities 0 and 1 without throwing", () => {
    expect(() =>
      calculateExpectedIncrementalValue({
        amount: 1000,
        naturalRecoveryProbability: 0,
        interventionRecoveryProbability: 1,
        interventionCost: 0,
        riskPenalty: 0,
      })
    ).not.toThrow();
  });

  it("rounds fractional-paise results once, at the output", () => {
    const result = calculateExpectedIncrementalValue({
      amount: 333, // deliberately chosen to produce a non-integer raw value
      naturalRecoveryProbability: 0.1,
      interventionRecoveryProbability: 0.55, // delta 0.45 * 333 = 149.85
      interventionCost: 0,
      riskPenalty: 0,
    });
    expect(result.expectedIncrementalValue).toBe(150); // rounds 149.85 -> 150
    expect(Number.isInteger(result.expectedIncrementalValue)).toBe(true);
  });

  it("throws when amount is not an integer number of paise", () => {
    expect(() =>
      calculateExpectedIncrementalValue({
        amount: 100.5,
        naturalRecoveryProbability: 0.1,
        interventionRecoveryProbability: 0.2,
        interventionCost: 0,
        riskPenalty: 0,
      })
    ).toThrow(/amount/);
  });
});
