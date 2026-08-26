export type EconomicInput = {
  amount: number; // paise, integer
  naturalRecoveryProbability: number; // [0,1]
  interventionRecoveryProbability: number; // [0,1]
  interventionCost: number; // paise, integer
  riskPenalty: number; // paise, integer
};

export type EconomicResult = {
  expectedIncrementalValue: number; // paise, integer (rounded once, at output)
  incrementalRecoveryProbability: number;
  calculationVersion: string;
};

const CALCULATION_VERSION = "economics-v1";

function assertProbability(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number in [0,1], got ${value}`);
  }
}

function assertPaiseAmount(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number, got ${value}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer number of paise, got ${value}`);
  }
}

/**
 * Pure, deterministic financial calculation - normal application code, not
 * an LLM decision (see docs/decision-engine.md - Phase 21.7/21.18).
 *
 * expectedIncrementalValue =
 *   amount * (interventionProbability - naturalProbability)
 *   - interventionCost - riskPenalty
 *
 * Rounds exactly once, at the final output, to a whole number of paise -
 * intermediate values stay full-precision so rounding never compounds.
 */
export function calculateExpectedIncrementalValue(input: EconomicInput): EconomicResult {
  assertProbability(input.naturalRecoveryProbability, "naturalRecoveryProbability");
  assertProbability(input.interventionRecoveryProbability, "interventionRecoveryProbability");
  assertPaiseAmount(input.amount, "amount");
  assertPaiseAmount(input.interventionCost, "interventionCost");
  assertPaiseAmount(input.riskPenalty, "riskPenalty");

  const incrementalRecoveryProbability =
    input.interventionRecoveryProbability - input.naturalRecoveryProbability;

  const rawValue =
    input.amount * incrementalRecoveryProbability - input.interventionCost - input.riskPenalty;

  return {
    expectedIncrementalValue: Math.round(rawValue),
    incrementalRecoveryProbability,
    calculationVersion: CALCULATION_VERSION,
  };
}
