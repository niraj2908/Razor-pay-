import { FailureReason, RecoveryContext } from "./types";

export type ModelEstimate = {
  probability: number;
  modelVersion: string;
  featureVersion: string;
  confidence: number;
};

const MODEL_VERSION = "baseline-v1";
const FEATURE_VERSION = "features-v1";

// Transparent, hand-set baseline probabilities by failure reason - NOT
// trained on real Razorpay production data (see docs/decision-engine.md).
const BASE_PROBABILITY_BY_REASON: Record<FailureReason, number> = {
  CONFIRMED_FAILURE: 0.05,
  // Pending payments are typically still resolving organically (e.g. a UPI
  // collect request awaiting the customer's bank confirmation) - hand-set
  // high on purpose, so "wait, don't spend money intervening" is the
  // correct baseline call for a clearly-in-flight payment.
  PENDING: 0.78,
  STATE_UNCERTAIN: 0.35,
  CUSTOMER_ABANDONMENT: 0.25,
  NETWORK_DEGRADATION: 0.55,
  OTHER_RECOVERABLE: 0.4,
};

// How much we trust that base rate for each reason - e.g. a confirmed
// decline is a very confident 0.05, while "state uncertain" is genuinely
// uncertain in both directions.
const BASE_CONFIDENCE_BY_REASON: Record<FailureReason, number> = {
  CONFIRMED_FAILURE: 0.9,
  PENDING: 0.6,
  STATE_UNCERTAIN: 0.35,
  CUSTOMER_ABANDONMENT: 0.7,
  NETWORK_DEGRADATION: 0.75,
  OTHER_RECOVERABLE: 0.55,
};

const RETRY_DECAY_PER_ATTEMPT = 0.08;
const CONFIDENCE_DECAY_PER_ATTEMPT = 0.03;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Deterministic, transparent baseline for "will this payment recover with
 * NO intervention" - a hand-set lookup table plus a retry-count decay, not
 * a trained model. See docs/decision-engine.md for why this is intentional
 * for the current phase.
 */
export function estimateNaturalRecovery(context: RecoveryContext): ModelEstimate {
  const base = BASE_PROBABILITY_BY_REASON[context.failureReason];
  const probability = clamp01(base - context.retryCount * RETRY_DECAY_PER_ATTEMPT);

  const confidence = clamp01(
    BASE_CONFIDENCE_BY_REASON[context.failureReason] -
      context.retryCount * CONFIDENCE_DECAY_PER_ATTEMPT
  );

  return { probability, modelVersion: MODEL_VERSION, featureVersion: FEATURE_VERSION, confidence };
}
