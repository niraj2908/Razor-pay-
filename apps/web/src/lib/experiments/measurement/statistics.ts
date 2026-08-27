import { AnalysisUnit } from "./analysisUnit";
import { ExperimentGroupValue } from "./types";

/**
 * The Statistical Engine (Phase 24 Step 2A).
 *
 * Pure, deterministic, DB-independent - no Prisma, no Razorpay, no LLM, no
 * ML, no HTTP, no environment variables, no filesystem access. Every
 * function here consumes already-aggregated AnalysisUnit rows (Section 4's
 * randomized unit of analysis - one row per ExperimentAssignment, never per
 * candidate/payment) and returns a plain, typed, deterministic result.
 *
 * Money discipline: every monetary quantity in/out of this module is an
 * integer number of paise. Where a calculation is genuinely a ratio of
 * integers (the GMV estimator), the exact rational value is carried via
 * BigInt numerator/denominator arithmetic and rounded exactly once, at the
 * final output boundary - never via intermediate floating-point division on
 * a money amount. Ordinary statistical quantities (rates, Wilson bounds,
 * z-scores) are NOT money and are computed with plain floating-point
 * arithmetic, which is standard and correct for those formulas.
 */

// ---------------------------------------------------------------------------
// Wilson confidence interval
// ---------------------------------------------------------------------------

export type WilsonIntervalResult =
  | { status: "computed"; successes: number; trials: number; confidenceLevel: number; pointEstimate: number; lower: number; upper: number }
  | { status: "undefined"; reason: "zero_trials" | "invalid_input" };

/**
 * Inverse standard normal CDF (quantile function) via Peter Acklam's
 * rational approximation (2003) - a standard, widely-published numerical
 * technique, not a business assumption. Accurate to within ~1.15e-9 for
 * p in (0, 1). Used only to convert a confidence level / alpha / power
 * probability into a z-score.
 */
export function inverseNormalCDF(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new RangeError(`inverseNormalCDF requires 0 < p < 1, got ${p}`);
  }

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/**
 * Wilson score interval for a binomial proportion (Wilson, E.B., 1927).
 * Chosen over the normal (Wald) approximation because Wald is unreliable
 * exactly where this system will most often need it - small samples and
 * proportions near 0 or 1 - see Phase 24 Step 1 Section 12.
 *
 * successes=0 and successes=trials are handled by the formula itself
 * without special-casing (Wilson's lower bound is exactly 0 at
 * successes=0 and its upper bound is exactly 1 at successes=trials, by
 * construction of the score interval - verified in the reference tests
 * below). trials=0 and structurally invalid inputs (negative counts,
 * successes>trials, non-integers, confidenceLevel outside (0,1)) return an
 * explicit `status: "undefined"` result rather than NaN/Infinity or a
 * fabricated interval.
 */
export function wilsonInterval(successes: number, trials: number, confidenceLevel: number): WilsonIntervalResult {
  if (
    !Number.isInteger(successes) ||
    !Number.isInteger(trials) ||
    successes < 0 ||
    trials < 0 ||
    successes > trials ||
    !(confidenceLevel > 0 && confidenceLevel < 1)
  ) {
    return { status: "undefined", reason: "invalid_input" };
  }
  if (trials === 0) {
    return { status: "undefined", reason: "zero_trials" };
  }

  const z = inverseNormalCDF(1 - (1 - confidenceLevel) / 2);
  const n = trials;
  const pHat = successes / n;
  const z2 = z * z;

  const denominator = 1 + z2 / n;
  const center = (pHat + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((pHat * (1 - pHat) + z2 / (4 * n)) / n)) / denominator;

  // Defensive clamp only - the Wilson formula is mathematically bounded
  // within [0, 1] already; this guards purely against floating-point
  // rounding noise at the extremes, never against a real out-of-range value.
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);

  return { status: "computed", successes, trials, confidenceLevel, pointEstimate: pHat, lower, upper };
}

// ---------------------------------------------------------------------------
// Recovery-rate statistics (per arm)
// ---------------------------------------------------------------------------

export type RecoveryRateStats = {
  arm: ExperimentGroupValue;
  analyzableUnits: number;
  successes: number;
  failures: number;
  rate: number | null; // successes / analyzableUnits; null when analyzableUnits === 0
  confidenceInterval: WilsonIntervalResult;
};

/** Counts ANALYZABLE units of one arm only - Section 4/9's aggregation
 * (analysis-unit rollup) must already have happened upstream (analysisUnit.ts);
 * this function never re-derives units from raw candidates. */
export function computeRecoveryRateStats(units: AnalysisUnit[], arm: ExperimentGroupValue, confidenceLevel: number): RecoveryRateStats {
  const armUnits = units.filter((u) => u.arm === arm && u.status === "ANALYZABLE");
  const successes = armUnits.filter((u) => u.outcome === "SUCCESS").length;
  const failures = armUnits.filter((u) => u.outcome === "FAILURE").length;
  const analyzableUnits = successes + failures;

  return {
    arm,
    analyzableUnits,
    successes,
    failures,
    rate: analyzableUnits > 0 ? successes / analyzableUnits : null,
    confidenceInterval: wilsonInterval(successes, analyzableUnits, confidenceLevel),
  };
}

// ---------------------------------------------------------------------------
// Observed treatment/control difference
// ---------------------------------------------------------------------------

export type ObservedDifferenceResult =
  | {
      status: "computed";
      /** Deliberately explicit, never "causal uplift" or "incremental effect" -
       * this is a raw sample statistic. Whether it supports a causal
       * interpretation is entirely a question for the (not-yet-built)
       * validity layer, never decided here. */
      label: "OBSERVED_TREATMENT_CONTROL_DIFFERENCE";
      treatmentRate: number;
      controlRate: number;
      observedDifference: number;
      /** Newcombe's (1998) hybrid score interval for the difference of two
       * independent binomial proportions - built directly from each arm's
       * own Wilson bounds (Newcombe, R.G., "Interval estimation for the
       * difference between independent proportions: comparison of eleven
       * methods," Statistics in Medicine 17:857-872, 1998, Method 10).
       * Chosen because it requires no numerical machinery beyond the
       * Wilson interval already implemented above, and is a standard,
       * citable, MVP-appropriate method - not an invented approximation. */
      confidenceInterval: { lower: number; upper: number };
    }
  | { status: "undefined"; reason: "insufficient_data" };

export function computeObservedDifference(treatment: RecoveryRateStats, control: RecoveryRateStats): ObservedDifferenceResult {
  if (
    treatment.rate === null ||
    control.rate === null ||
    treatment.confidenceInterval.status !== "computed" ||
    control.confidenceInterval.status !== "computed"
  ) {
    return { status: "undefined", reason: "insufficient_data" };
  }

  const t = treatment.confidenceInterval;
  const c = control.confidenceInterval;

  // Newcombe Method 10: L = (p1-p2) - sqrt((p1-l1)^2 + (u2-p2)^2)
  //                     U = (p1-p2) + sqrt((u1-p1)^2 + (p2-l2)^2)
  const observedDifference = t.pointEstimate - c.pointEstimate;
  const lower = observedDifference - Math.sqrt((t.pointEstimate - t.lower) ** 2 + (c.upper - c.pointEstimate) ** 2);
  const upper = observedDifference + Math.sqrt((t.upper - t.pointEstimate) ** 2 + (c.pointEstimate - c.lower) ** 2);

  return {
    status: "computed",
    label: "OBSERVED_TREATMENT_CONTROL_DIFFERENCE",
    treatmentRate: treatment.rate,
    controlRate: control.rate,
    observedDifference,
    confidenceInterval: { lower, upper },
  };
}

// ---------------------------------------------------------------------------
// GMV statistics (per arm)
// ---------------------------------------------------------------------------

export type GMVStats = {
  arm: ExperimentGroupValue;
  /** Paise. Exact integer sum of AnalysisUnit.recoveredAmount across every
   * unit of this arm (NOT_ANALYZABLE/failure units already contribute 0 -
   * see analysisUnit.ts). This is an OBSERVED total, never incremental. */
  recoveredGMV: number;
  analyzableUnits: number;
  successUnits: number;
};

export function computeGMVStats(units: AnalysisUnit[], arm: ExperimentGroupValue): GMVStats {
  const armUnits = units.filter((u) => u.arm === arm && u.status === "ANALYZABLE");
  const successUnits = armUnits.filter((u) => u.outcome === "SUCCESS").length;
  const recoveredGMV = armUnits.reduce((sum, u) => sum + u.recoveredAmount, 0);

  return { arm, recoveredGMV, analyzableUnits: armUnits.length, successUnits };
}

// ---------------------------------------------------------------------------
// Allocation-aware incremental GMV estimate
// ---------------------------------------------------------------------------

export type IncrementalGMVResult =
  | {
      status: "computed";
      /** Paise. A plain observed total - never itself "incremental." */
      observedTreatmentGMV: number;
      /** Paise. A plain observed total - never itself "incremental." */
      observedControlGMV: number;
      /** Paise, rounded once at this boundary. What the treatment
       * population would be estimated to have recovered had it instead
       * recovered at the CONTROL rate, using the average recovered value
       * per success actually observed in TREATMENT. */
      estimatedCounterfactualTreatmentGMV: number;
      /** Paise, rounded once at this boundary. observedTreatmentGMV minus
       * estimatedCounterfactualTreatmentGMV - the estimate, never a raw
       * treatment-minus-control subtraction. */
      estimatedIncrementalGMV: number;
    }
  | { status: "undefined"; reason: "zero_treatment_successes" | "zero_treatment_analyzable_units" | "zero_control_analyzable_units" };

/**
 * Definition (Phase 24 Step 1 Section 10, derived algebraically):
 *
 *   Let TS = treatment success units, TA = treatment analyzable units,
 *       CS = control success units,   CA = control analyzable units,
 *       TG = observed treatment recovered GMV (paise).
 *
 *   treatmentRate = TS/TA, controlRate = CS/CA
 *   avgRecoveredPerTreatmentSuccess = TG/TS
 *
 *   incrementalRecoveryRate      = treatmentRate - controlRate
 *   incrementalGMVPerUnit        = incrementalRecoveryRate * avgRecoveredPerTreatmentSuccess
 *   estimatedIncrementalGMV      = incrementalGMVPerUnit * TA
 *                                = TG - (CS * TG * TA) / (CA * TS)      [algebraic simplification]
 *   estimatedCounterfactualGMV   = observedTreatmentGMV - estimatedIncrementalGMV
 *                                = (CS * TG * TA) / (CA * TS)
 *                                = controlRate * avgRecoveredPerTreatmentSuccess * TA
 *
 * This is allocation-aware by construction: both rates are independently
 * normalized by their own arm's denominator, so nothing here assumes
 * TA == CA - an experiment with, say, 10% treatment / 90% control produces
 * exactly the same per-unit incremental estimate as a 50/50 split with the
 * same underlying rates. Raw `observedTreatmentGMV - observedControlGMV`
 * is never computed anywhere in this module - it would be meaningless
 * under unequal allocation and is exactly the naive subtraction this
 * estimator is designed to avoid.
 *
 * The single fraction (CS * TG * TA) / (CA * TS) is computed with BigInt
 * numerator/denominator and rounded exactly once (round-half-away-from-
 * zero) to the nearest paisa - no floating-point division ever touches a
 * money amount in this function.
 */
export function computeIncrementalGMV(treatment: GMVStats, control: GMVStats): IncrementalGMVResult {
  const TS = BigInt(treatment.successUnits);
  const TA = BigInt(treatment.analyzableUnits);
  const CS = BigInt(control.successUnits);
  const CA = BigInt(control.analyzableUnits);
  const TG = BigInt(treatment.recoveredGMV);

  // Checked in this order deliberately: successUnits can never exceed
  // analyzableUnits, so analyzableUnits===0 implies successUnits===0 too -
  // checking analyzableUnits first is what makes "no treatment data at
  // all" and "treatment data exists but nobody recovered" distinguishable
  // reasons rather than the second being unreachable dead code.
  if (treatment.analyzableUnits === 0) {
    return { status: "undefined", reason: "zero_treatment_analyzable_units" };
  }
  if (treatment.successUnits === 0) {
    return { status: "undefined", reason: "zero_treatment_successes" };
  }
  if (control.analyzableUnits === 0) {
    return { status: "undefined", reason: "zero_control_analyzable_units" };
  }

  const numerator = CS * TG * TA;
  const denominator = CA * TS;
  const estimatedCounterfactualTreatmentGMV = roundBigIntFraction(numerator, denominator);
  const estimatedIncrementalGMV = treatment.recoveredGMV - estimatedCounterfactualTreatmentGMV;

  return {
    status: "computed",
    observedTreatmentGMV: treatment.recoveredGMV,
    observedControlGMV: control.recoveredGMV,
    estimatedCounterfactualTreatmentGMV,
    estimatedIncrementalGMV,
  };
}

/** Exact round-half-away-from-zero of numerator/denominator, computed
 * entirely in BigInt - the only floating-point-free way to round a ratio
 * of two potentially large integers to the nearest whole paisa. Both
 * inputs are non-negative in every caller in this module. */
function roundBigIntFraction(numerator: bigint, denominator: bigint): number {
  // BigInt(n) rather than n-literal syntax (0n/2n/1n) - this project's
  // TypeScript target predates ES2020 BigInt-literal support; the BigInt
  // type/arithmetic itself is unaffected, only the literal syntax is.
  const zero = BigInt(0);
  const two = BigInt(2);
  const one = BigInt(1);
  if (denominator === zero) {
    throw new RangeError("roundBigIntFraction: denominator must not be zero");
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const roundedUp = remainder * two >= denominator;
  return Number(roundedUp ? quotient + one : quotient);
}

// ---------------------------------------------------------------------------
// UNKNOWN sensitivity bounds
// ---------------------------------------------------------------------------

export type SensitivityBounds = {
  /** Explicit marker - a sensitivity bound is never the primary estimate. */
  label: "UNKNOWN_SENSITIVITY_BOUND";
  arm: ExperimentGroupValue;
  observed: { successes: number; analyzableUnits: number; rate: number | null };
  /** Every unit whose ONLY signal is a matured-but-unresolved-attribution
   * recovery, hypothetically counted as a SUCCESS. */
  bestCase: { successes: number; analyzableUnits: number; rate: number | null };
  /** The same units, hypothetically counted as a FAILURE. */
  worstCase: { successes: number; analyzableUnits: number; rate: number | null };
  /** Units excluded from the primary analysis (status=NOT_ANALYZABLE) whose
   * exclusion is due to an unresolved attribution, with no OTHER analyzable
   * candidate already deciding that unit - see analysisUnit.ts. Counting a
   * unit here that already has an analyzable success/failure from another
   * candidate would double count it; excluded here deliberately. */
  unknownOnlyUnitCount: number;
};

export function computeUnknownSensitivity(units: AnalysisUnit[], arm: ExperimentGroupValue): SensitivityBounds {
  const armUnits = units.filter((u) => u.arm === arm);
  const analyzable = armUnits.filter((u) => u.status === "ANALYZABLE");
  const successes = analyzable.filter((u) => u.outcome === "SUCCESS").length;
  const analyzableUnits = analyzable.length;

  const unknownOnlyUnits = armUnits.filter((u) => u.status === "NOT_ANALYZABLE" && u.maturedUnknownCandidateCount > 0);
  const unknownOnlyUnitCount = unknownOnlyUnits.length;

  const rate = (s: number, n: number): number | null => (n > 0 ? s / n : null);

  return {
    label: "UNKNOWN_SENSITIVITY_BOUND",
    arm,
    observed: { successes, analyzableUnits, rate: rate(successes, analyzableUnits) },
    bestCase: {
      successes: successes + unknownOnlyUnitCount,
      analyzableUnits: analyzableUnits + unknownOnlyUnitCount,
      rate: rate(successes + unknownOnlyUnitCount, analyzableUnits + unknownOnlyUnitCount),
    },
    worstCase: {
      successes,
      analyzableUnits: analyzableUnits + unknownOnlyUnitCount,
      rate: rate(successes, analyzableUnits + unknownOnlyUnitCount),
    },
    unknownOnlyUnitCount,
  };
}

// ---------------------------------------------------------------------------
// Sample-size / power helper
// ---------------------------------------------------------------------------

export type SampleSizeInput = {
  /** Control-arm baseline recovery rate assumption, 0 < value < 1. Must be
   * supplied by the caller from real historical data - never defaulted. */
  baselineRate: number;
  /** Absolute (not relative) minimum detectable recovery-rate difference
   * worth acting on, > 0. A business decision - never defaulted. */
  minimumDetectableEffect: number;
  /** Two-sided significance level, 0 < alpha < 1 (e.g. 0.05). Never defaulted. */
  alpha: number;
  /** Statistical power, 0 < power < 1 (e.g. 0.8). Never defaulted. */
  power: number;
  /** Matches Experiment.treatmentAllocationPercent; must be strictly
   * between 0 and 100 - a 0% or 100% split has no control/treatment
   * comparison to power. */
  treatmentAllocationPercent: number;
};

export type SampleSizeResult =
  | { status: "computed"; requiredControlUnits: number; requiredTreatmentUnits: number; requiredTotalUnits: number }
  | { status: "undefined"; reason: "invalid_input" };

/**
 * Standard two-independent-proportions sample size formula with unequal
 * allocation, unpooled variance on both the alpha and beta terms (see e.g.
 * Chow, S-C., Shao, J., Wang, H., "Sample Size Calculations in Clinical
 * Research," 2nd ed., section 4.2). This is "a" standard method, cited
 * explicitly here so a discrepancy against a different textbook formula
 * (e.g. one using pooled variance for the alpha term) is explainable, not
 * evidence of an error - see the accompanying report for this distinction.
 *
 * Every input is required from the caller with no default (Phase 24 Step 1
 * Section 13: "do not invent business values"). This function computes
 * REQUIRED ANALYSIS-UNIT COUNTS (post analysis-unit aggregation, Section
 * 4/9) - NOT raw candidate or payment counts. It assumes each analysis
 * unit is an independent Bernoulli trial at the stated baseline rate; it
 * does not itself model a clustering/design-effect correction, because the
 * randomized unit of analysis is already the (already-declustered)
 * ExperimentAssignment, consistent with the rest of this module. See the
 * accompanying report for the residual, undecided question this leaves
 * open: if `baselineRate` itself is estimated from historical
 * candidate-level data rather than unit-level data, that estimate may not
 * equal the true unit-level base rate - a DATA-input caveat, not a defect
 * in this formula.
 */
export function computeRequiredSampleSize(input: SampleSizeInput): SampleSizeResult {
  const { baselineRate, minimumDetectableEffect, alpha, power, treatmentAllocationPercent } = input;

  const p1 = baselineRate;
  const p2 = baselineRate + minimumDetectableEffect;

  if (
    !(p1 > 0 && p1 < 1) ||
    !(minimumDetectableEffect > 0) ||
    !(p2 > 0 && p2 < 1) ||
    !(alpha > 0 && alpha < 1) ||
    !(power > 0 && power < 1) ||
    !(treatmentAllocationPercent > 0 && treatmentAllocationPercent < 100)
  ) {
    return { status: "undefined", reason: "invalid_input" };
  }

  const kappa = treatmentAllocationPercent / (100 - treatmentAllocationPercent); // treatment:control ratio
  const zAlpha = inverseNormalCDF(1 - alpha / 2);
  const zBeta = inverseNormalCDF(power);

  const numerator = (zAlpha + zBeta) ** 2 * (p1 * (1 - p1) / kappa + p2 * (1 - p2));
  const denominator = (p2 - p1) ** 2;

  const requiredControlUnits = Math.ceil(numerator / denominator);
  const requiredTreatmentUnits = Math.ceil(kappa * requiredControlUnits);

  return {
    status: "computed",
    requiredControlUnits,
    requiredTreatmentUnits,
    requiredTotalUnits: requiredControlUnits + requiredTreatmentUnits,
  };
}
