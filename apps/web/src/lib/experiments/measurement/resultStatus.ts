import { ObservedDifferenceResult } from "./statistics";
import { ExperimentValidityStatus } from "./validity";

/**
 * Result-Status Composition (Phase 24 Step 4).
 *
 * Pure, deterministic, DB-independent. This is the ONE new piece of
 * decision logic Step 4 adds - it does not touch statistics.ts or
 * validity.ts, and does not recompute anything either of them already
 * decided. It only COMBINES their two already-separate verdicts
 * (structural validity vs. the observed statistic) into one persisted
 * status, plus the INTERIM/FINAL lifecycle axis - while enforcing the
 * critical refinement this step requires:
 *
 *   "treatment > control" or "the confidence interval merely excludes
 *   zero" must NEVER, by themselves, produce VALID_EFFECT.
 *
 * VALID_EFFECT is reachable ONLY when a caller-configured minimum
 * practical (business) effect threshold exists AND the ENTIRE observed
 * confidence interval clears it - never invented, never defaulted, never
 * approximated from the point estimate alone. If no threshold was
 * configured, the strongest label this function will ever produce for a
 * structurally VALID experiment is VALID_INCONCLUSIVE - a deliberately
 * conservative choice that prefers "we cannot make this business claim"
 * over silently manufacturing one.
 */

export type MeasurementResultStatusValue = "INSUFFICIENT_DATA" | "INVALID" | "VALID_INCONCLUSIVE" | "VALID_EFFECT";
export type MeasurementResultKindValue = "INTERIM" | "FINAL";

/**
 * A minimum practical effect is an absolute recovery-rate difference (0-1)
 * below which even a statistically clear effect is not considered
 * business-meaningful. `null` means "not configured" - a materially
 * different state from "configured as 0," which would (correctly) treat
 * any nonzero, statistically-clear effect as meaningful. This mirrors the
 * exact null-means-unconfigured discipline already used throughout this
 * module (`minimumAnalyzableSamplePerArm`, `sampleSizeConfig`).
 */
export type MinimumPracticalEffect = { minimumRateDifference: number } | null;

export type ResultStatusInput = {
  /** Experiment.status at calculation time - used only to derive
   * resultKind (INTERIM vs. FINAL), never to influence resultStatus. */
  experimentStatus: "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";
  validityStatus: ExperimentValidityStatus;
  observedDifference: ObservedDifferenceResult;
  minimumPracticalEffect: MinimumPracticalEffect;
  /** True only when every analyzable unit's observation window has fully
   * closed - i.e. validity.ts's own "immature_observations" check reports
   * zero NOT_YET_MATURE and zero missing-outcome-past-window units. Passed
   * in by the caller (never re-derived here) to avoid this module coupling
   * to validity.ts's internal check-code strings. */
  fullyMatured: boolean;
};

export type ComposedMeasurementResult = {
  resultStatus: MeasurementResultStatusValue;
  resultKind: MeasurementResultKindValue;
};

/**
 * FINAL requires BOTH the experiment being COMPLETED (Phase 23: no further
 * assignments will ever occur once COMPLETED) AND every analyzable unit
 * having matured - a COMPLETED experiment with residual immature units is
 * still only INTERIM, since its true final numbers are not yet knowable.
 */
function deriveResultKind(experimentStatus: ResultStatusInput["experimentStatus"], fullyMatured: boolean): MeasurementResultKindValue {
  return experimentStatus === "COMPLETED" && fullyMatured ? "FINAL" : "INTERIM";
}

/**
 * Composes the persisted result status and kind from the two independent
 * upstream verdicts. Never throws for ordinary experiment states - every
 * combination of inputs maps to exactly one of the four statuses.
 */
export function composeMeasurementResult(input: ResultStatusInput): ComposedMeasurementResult {
  const resultKind = deriveResultKind(input.experimentStatus, input.fullyMatured);

  if (input.validityStatus === "INVALID") {
    return { resultStatus: "INVALID", resultKind };
  }
  if (input.validityStatus === "INSUFFICIENT_DATA") {
    return { resultStatus: "INSUFFICIENT_DATA", resultKind };
  }

  // validityStatus === "VALID" from here on.

  if (input.observedDifference.status !== "computed") {
    // Defensive: a VALID validity status should already guarantee both
    // arms have analyzable data (and therefore a computable difference),
    // but this function never assumes that guarantee holds elsewhere -
    // fall back to the conservative label rather than fabricate a status.
    return { resultStatus: "VALID_INCONCLUSIVE", resultKind };
  }

  if (input.minimumPracticalEffect === null) {
    // THE CRITICAL REFINEMENT: no configured minimum practical effect
    // means this function MUST NOT manufacture a business claim, no
    // matter how large or how statistically clear (CI excluding zero)
    // the observed difference looks. "treatment > control" is never
    // sufficient on its own.
    return { resultStatus: "VALID_INCONCLUSIVE", resultKind };
  }

  const { minimumRateDifference } = input.minimumPracticalEffect;
  const { lower, upper } = input.observedDifference.confidenceInterval;

  // The ENTIRE interval must clear the configured threshold - not the
  // point estimate alone - in EITHER direction: a meaningful effect can be
  // a real improvement (lower bound clears +threshold) or a real harm
  // (upper bound clears -threshold); both are actionable findings. This
  // simultaneously guarantees statistical significance (the interval
  // excludes zero, since the threshold is positive) AND practical
  // significance (even the most conservative end of the interval still
  // clears the configured business bar) - the exact double condition this
  // step's critical refinement requires.
  const meaningfulPositiveEffect = lower >= minimumRateDifference;
  const meaningfulNegativeEffect = upper <= -minimumRateDifference;

  if (meaningfulPositiveEffect || meaningfulNegativeEffect) {
    return { resultStatus: "VALID_EFFECT", resultKind };
  }
  return { resultStatus: "VALID_INCONCLUSIVE", resultKind };
}
