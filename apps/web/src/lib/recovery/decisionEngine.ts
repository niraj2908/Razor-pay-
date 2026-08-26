import { randomUUID } from "node:crypto";
import { RecoveryAction, RecoveryContext, Strategy } from "./types";
import { estimateNaturalRecovery, ModelEstimate } from "./naturalRecoveryModel";
import { estimateInterventionResponse } from "./interventionResponseModel";
import { calculateExpectedIncrementalValue, EconomicResult } from "./economics";
import { DEFAULT_POLICY, evaluatePolicy, PolicyConfig, PolicyResult } from "./policy";
import { evaluateSafety, SafetyResult } from "./safetyGate";

// Above this natural-recovery probability, intervening when it wouldn't
// add incremental value is treated as unnecessary spend, not a missed
// opportunity - see docs/decision-engine.md, golden scenario 1.
const HIGH_NATURAL_RECOVERY_THRESHOLD = 0.75;

// Synthetic per-strategy intervention costs (paise) for this prototype.
const INTERVENTION_COST: Record<Strategy, number> = {
  RETRY: 0,
  PAYMENT_LINK: 200, // ₹2 - notification/SMS cost placeholder
  OTHER_ALLOWED_STRATEGY: 100,
};
const DEFAULT_RISK_PENALTY = 0;

export type StrategyEvaluation = {
  strategy: Strategy;
  intervention: ModelEstimate;
  economics: EconomicResult;
};

export type RecoveryDecisionTrace = {
  decisionId: string;
  paymentId: string;
  modelVersion: string;
  featureVersion: string;
  policyVersion: string;
  naturalRecoveryProbability: number;
  naturalRecoveryConfidence: number;
  interventionProbability: number | null;
  candidateStrategies: StrategyEvaluation[];
  expectedValues: Record<string, number>;
  selectedAction: RecoveryAction;
  selectedStrategy: Strategy | null;
  safetyResults: SafetyResult;
  policyResults: PolicyResult | null;
  reason: string;
  timestamp: string;
};

function pickBestStrategy(evaluations: StrategyEvaluation[]): StrategyEvaluation {
  return evaluations.reduce((best, current) =>
    current.economics.expectedIncrementalValue > best.economics.expectedIncrementalValue
      ? current
      : best
  );
}

/**
 * Orchestrates the full recovery decision pipeline (Phase 21.10):
 * estimate natural recovery -> estimate intervention response per
 * candidate strategy -> calculate economics -> evaluate policy -> evaluate
 * safety -> choose ACT/WAIT/STOP/ESCALATE -> return a full trace.
 *
 * Deterministic for a given (context, policy): same input, same model
 * versions in, same decision out. No LLM is involved anywhere in this
 * function, and none may be added - see docs/decision-engine.md.
 */
export function evaluateRecoveryDecision(
  context: RecoveryContext,
  policy: PolicyConfig = DEFAULT_POLICY
): RecoveryDecisionTrace {
  const decisionId = randomUUID();
  const timestamp = new Date().toISOString();

  const naturalRecovery = estimateNaturalRecovery(context);
  const strategies = context.candidateStrategies ?? policy.allowedStrategies;

  const evaluations: StrategyEvaluation[] = strategies.map((strategy) => {
    const intervention = estimateInterventionResponse(context, strategy);
    const economics = calculateExpectedIncrementalValue({
      amount: context.amount,
      naturalRecoveryProbability: naturalRecovery.probability,
      interventionRecoveryProbability: intervention.probability,
      interventionCost: INTERVENTION_COST[strategy],
      riskPenalty: DEFAULT_RISK_PENALTY,
    });
    return { strategy, intervention, economics };
  });

  const best = pickBestStrategy(evaluations);
  const safetyResult = evaluateSafety(context, policy);
  const policyResult = safetyResult.safe
    ? evaluatePolicy(
        {
          strategy: best.strategy,
          paymentMethod: context.paymentMethod,
          customerContactCount: context.customerContactCount,
        },
        policy
      )
    : null;

  const expectedValues = Object.fromEntries(
    evaluations.map((e) => [e.strategy, e.economics.expectedIncrementalValue])
  );

  let selectedAction: RecoveryAction;
  let selectedStrategy: Strategy | null = null;
  let reason: string;

  if (!safetyResult.safe) {
    selectedAction = safetyResult.recommendedFallback as RecoveryAction;
    reason = `safety_gate:${safetyResult.reasons.join(",")}`;
  } else if (!policyResult!.allowed) {
    selectedAction = "STOP";
    reason = `policy_violation:${policyResult!.violations.join(",")}`;
  } else if (naturalRecovery.confidence < policy.minConfidence) {
    selectedAction = "ESCALATE";
    reason = "confidence_below_threshold";
  } else if (
    naturalRecovery.probability >= HIGH_NATURAL_RECOVERY_THRESHOLD &&
    best.economics.expectedIncrementalValue <= 0
  ) {
    selectedAction = "WAIT";
    reason = "high_natural_recovery_no_incremental_value";
  } else if (best.economics.expectedIncrementalValue >= policy.minExpectedIncrementalValue) {
    selectedAction = "ACT";
    selectedStrategy = best.strategy;
    reason = "positive_expected_incremental_value";
  } else if (best.economics.expectedIncrementalValue <= 0) {
    selectedAction = "STOP";
    reason = "non_positive_expected_incremental_value";
  } else {
    selectedAction = "WAIT";
    reason = "expected_value_below_action_threshold";
  }

  return {
    decisionId,
    paymentId: context.paymentId,
    modelVersion: naturalRecovery.modelVersion,
    featureVersion: naturalRecovery.featureVersion,
    policyVersion: policy.version,
    naturalRecoveryProbability: naturalRecovery.probability,
    naturalRecoveryConfidence: naturalRecovery.confidence,
    interventionProbability: selectedStrategy
      ? evaluations.find((e) => e.strategy === selectedStrategy)!.intervention.probability
      : null,
    candidateStrategies: evaluations,
    expectedValues,
    selectedAction,
    selectedStrategy,
    safetyResults: safetyResult,
    policyResults: policyResult,
    reason,
    timestamp,
  };
}
