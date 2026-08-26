import { FailureReason, RecoveryContext, Strategy } from "./types";
import { estimateNaturalRecovery, ModelEstimate } from "./naturalRecoveryModel";

const MODEL_VERSION = "intervention-baseline-v1";
const FEATURE_VERSION = "features-v1";

// Synthetic uplift added on top of the natural-recovery probability, by
// strategy and failure reason. Calibrated by hand for this prototype, NOT
// fit to real outcome data - see docs/decision-engine.md.
const UPLIFT: Record<Strategy, Record<FailureReason, number>> = {
  RETRY: {
    NETWORK_DEGRADATION: 0.35,
    STATE_UNCERTAIN: 0.2,
    PENDING: 0.15,
    OTHER_RECOVERABLE: 0.1,
    CUSTOMER_ABANDONMENT: 0.02,
    CONFIRMED_FAILURE: 0.0,
  },
  PAYMENT_LINK: {
    CUSTOMER_ABANDONMENT: 0.45,
    OTHER_RECOVERABLE: 0.25,
    STATE_UNCERTAIN: 0.15,
    PENDING: 0.1,
    NETWORK_DEGRADATION: 0.1,
    CONFIRMED_FAILURE: 0.03,
  },
  OTHER_ALLOWED_STRATEGY: {
    CONFIRMED_FAILURE: 0.05,
    PENDING: 0.05,
    STATE_UNCERTAIN: 0.05,
    CUSTOMER_ABANDONMENT: 0.05,
    NETWORK_DEGRADATION: 0.05,
    OTHER_RECOVERABLE: 0.05,
  },
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Deterministic, transparent baseline for "will this payment recover IF we
 * apply `strategy`" - natural recovery plus a hand-set uplift. Explicitly
 * NOT a trained production model (see docs/decision-engine.md).
 */
export function estimateInterventionResponse(
  context: RecoveryContext,
  strategy: Strategy
): ModelEstimate {
  const natural = estimateNaturalRecovery(context);
  const uplift = UPLIFT[strategy][context.failureReason];
  const probability = clamp01(natural.probability + uplift);

  return {
    probability,
    modelVersion: MODEL_VERSION,
    featureVersion: FEATURE_VERSION,
    confidence: natural.confidence,
  };
}
