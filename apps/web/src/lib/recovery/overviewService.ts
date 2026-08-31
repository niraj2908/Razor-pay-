import type { RecoveryDecision } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * The Recovery Overview query service (Phase 25 Step 4B).
 *
 * A read-only aggregation over EXISTING domain tables
 * (RevenueRiskEvent/Payment/Execution/Outcome) - contains NO decision
 * logic, NO economics, NO statistics, and NEVER itself computes or
 * estimates an incremental/causal effect (see `computeIncrementalRecovery`
 * below - it only reads and honors an already-computed, already-validated
 * `ExperimentMeasurementResult`, never derives one). `merchantId` MUST
 * already be the caller's own
 * authorized merchant (see recoveryQueueService.ts/decisionDetailService.ts
 * for the identical trust contract) - this function applies it directly in
 * every query's WHERE clause, never fetch-then-filter.
 *
 * AGGREGATION GRAIN (Phase 25 Step 4 audit, approved in Step 4B):
 *   - Candidate/decision/execution COUNTS use their natural entity grain -
 *     a RevenueRiskEvent row IS a candidate, an Execution row IS an
 *     attempt, counted as they are, even if two rows exist for the same
 *     underlying Payment (candidateBuilder.ts has no dedup-by-payment
 *     check - see this module's own report for the verified evidence).
 *   - MONETARY sums (revenueAtRiskPaise, recovered GMV) are deduplicated
 *     by DISTINCT Payment.id - the same payment's amount is never summed
 *     twice, regardless of how many RevenueRiskEvent/Decision/Outcome rows
 *     reference it. This is a read-side safeguard only; it does not fix
 *     (and this step does not touch) the upstream duplicate-creation
 *     behavior in candidateBuilder.ts.
 *
 * Incremental/causal GMV (`incrementalRecovery`) is computed conservatively,
 * not unconditionally unavailable: Phase 25 Step 5 gave Experiment a real
 * merchant boundary, so `computeIncrementalRecovery` below CAN now safely
 * scope a measurement result to this merchant. It only ever reports
 * `available` when the merchant has exactly one experiment whose latest
 * measurement result is `VALID_EFFECT` with real, non-null persisted
 * estimate fields - the exact same condition
 * `experimentQueryService.ts`'s `mapIncrementalEstimate` already enforces
 * for the Experiment Results API, never duplicated or relaxed here. It
 * NEVER computes, estimates, or approximates a number itself, never treats
 * `observedDifference` as causal, and NEVER picks a value when a merchant
 * has more than one experiment with its own VALID_EFFECT result - that
 * "which one counts" aggregation question remains a genuine, unresolved
 * product decision (flagged repeatedly since Step 4), so it is reported as
 * unavailable rather than guessed.
 */

// 366 days - a deliberate, documented cap on an explicit (since AND until)
// range, not a limit on how far back an open-ended ("all time") query may
// reach (see this module's doc comment: unbounded is the deliberate
// default for current-state fields, and the real bound on the windowed
// fields is the merchant's own row count, not calendar span, at current
// scale). Rejects an obviously-pathological explicit range rather than
// serving as this endpoint's only defense against real scale growth.
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

export function parseDateParam(value: string): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type DateRangeValidation =
  | { valid: true; since?: Date; until?: Date }
  | { valid: false; reason: "invalid_since" | "invalid_until" | "since_not_before_until" | "range_too_large" };

/** Validates the two optional query params together (never one at a time)
 * so `since >= until` and an oversized explicit range are both caught
 * before any query runs - never a raw string reaching Prisma. */
export function validateDateRange(sinceRaw: string | null, untilRaw: string | null): DateRangeValidation {
  let since: Date | undefined;
  let until: Date | undefined;

  if (sinceRaw !== null) {
    const parsed = parseDateParam(sinceRaw);
    if (!parsed) return { valid: false, reason: "invalid_since" };
    since = parsed;
  }
  if (untilRaw !== null) {
    const parsed = parseDateParam(untilRaw);
    if (!parsed) return { valid: false, reason: "invalid_until" };
    until = parsed;
  }
  if (since && until) {
    if (since.getTime() >= until.getTime()) {
      return { valid: false, reason: "since_not_before_until" };
    }
    if (until.getTime() - since.getTime() > MAX_RANGE_MS) {
      return { valid: false, reason: "range_too_large" };
    }
  }
  return { valid: true, since, until };
}

export type RecoveryOverviewQuery = { since?: Date; until?: Date };

export type RecoveryOverviewResult = {
  period: { since: string | null; until: string };
  operational: {
    candidatesCount: number;
    revenueAtRiskPaise: number;
    interventionsAttempted: number;
    interventionsSucceeded: number;
  };
  attributedOutcomes: {
    matureOutcomesCount: number;
    recoveredCount: number;
    naturalRecoveryCount: number;
    interventionRecoveryCount: number;
    unknownAttributionCount: number;
    naturalRecoveryGmvPaise: number;
    interventionRecoveryGmvPaise: number;
    observedRecoveryRate: number | null;
  };
  incrementalRecovery: IncrementalRecoveryResult;
};

export type IncrementalRecoveryResult =
  | {
      status: "unavailable";
      reason: "no_experiment_configured" | "no_valid_effect_result" | "ambiguous_multiple_valid_effect_experiments";
    }
  | { status: "available"; estimatedIncrementalGMVPaise: number; estimatedCounterfactualTreatmentGMVPaise: number };

/** Sums `amountPaise` once per distinct `paymentId` - the core anti-double-
 * counting rule (see this module's doc comment). Rows sharing a paymentId
 * are expected to carry the same amount (candidateBuilder.ts always sets
 * amountAtRisk from the same Payment.amount) - the FIRST occurrence's
 * amount is used, never summed again. */
function sumDistinctByPayment(rows: Array<{ paymentId: string; amountPaise: number }>): number {
  const seen = new Set<string>();
  let total = 0;
  for (const row of rows) {
    if (seen.has(row.paymentId)) continue;
    seen.add(row.paymentId);
    total += row.amountPaise;
  }
  return total;
}

/**
 * Determines whether this merchant currently has a safe, honest
 * incremental-GMV figure to report (Phase 25 backend-gap audit, Fix #2).
 *
 * Deliberately conservative:
 *   - No `Experiment` row for this merchant at all -> `no_experiment_configured`.
 *   - This merchant has experiment(s), but none of their LATEST measurement
 *     results is `VALID_EFFECT` with real (non-null) persisted estimate
 *     fields -> `no_valid_effect_result`. This single reason covers
 *     VALID_INCONCLUSIVE, INVALID, INSUFFICIENT_DATA, no result ever
 *     computed, and a VALID_EFFECT row with unexpectedly-null estimate
 *     fields - every one of those is honestly "no valid effect to report,"
 *     never fabricated into a number.
 *   - More than one experiment's latest result is independently
 *     `VALID_EFFECT` -> `ambiguous_multiple_valid_effect_experiments`.
 *     Picking one arbitrarily (e.g. "the newest") would be inventing an
 *     aggregation rule nobody has approved - reported as unavailable
 *     instead of guessed.
 *   - Exactly one qualifying experiment -> `available`, with that
 *     experiment's own persisted paise values, verbatim - never recomputed,
 *     never derived from `observedDifference` (never read here at all).
 *
 * "Latest" per experiment uses the same `ORDER BY generatedAt DESC`
 * convention already established in experimentQueryService.ts - `distinct`
 * combined with that `orderBy` gives Postgres's `DISTINCT ON` semantics
 * (one row per experimentId, the most recently generated one), in a single
 * query with no N+1.
 */
async function computeIncrementalRecovery(merchantId: string): Promise<IncrementalRecoveryResult> {
  const experiments = await prisma.experiment.findMany({
    where: { merchantId },
    select: { id: true },
  });
  if (experiments.length === 0) {
    return { status: "unavailable", reason: "no_experiment_configured" };
  }

  const latestPerExperiment = await prisma.experimentMeasurementResult.findMany({
    where: { experimentId: { in: experiments.map((e) => e.id) } },
    orderBy: { generatedAt: "desc" },
    distinct: ["experimentId"],
    select: {
      resultStatus: true,
      estimatedIncrementalGMVPaise: true,
      estimatedCounterfactualTreatmentGMVPaise: true,
    },
  });

  const validEffectResults = latestPerExperiment.filter(
    (r) =>
      r.resultStatus === "VALID_EFFECT" &&
      r.estimatedIncrementalGMVPaise !== null &&
      r.estimatedCounterfactualTreatmentGMVPaise !== null
  );

  if (validEffectResults.length === 0) {
    return { status: "unavailable", reason: "no_valid_effect_result" };
  }
  if (validEffectResults.length > 1) {
    return { status: "unavailable", reason: "ambiguous_multiple_valid_effect_experiments" };
  }

  const result = validEffectResults[0];
  return {
    status: "available",
    estimatedIncrementalGMVPaise: result.estimatedIncrementalGMVPaise as number,
    estimatedCounterfactualTreatmentGMVPaise: result.estimatedCounterfactualTreatmentGMVPaise as number,
  };
}

/**
 * Computes the Recovery Overview for one merchant.
 *
 * `operational.candidatesCount`/`revenueAtRiskPaise` describe CURRENT STATE
 * (open, i.e. `resolvedAt IS NULL`, RevenueRiskEvents) and are NEVER
 * time-windowed by `since`/`until` - "what is at risk right now" is a
 * present-tense question, not a historical range (Phase 25 Step 4 audit
 * Section I). `interventionsAttempted`/`Succeeded` are windowed by
 * `Execution.executedAt`; everything under `attributedOutcomes` is
 * windowed by `Outcome.observedAt` and always excludes `status: PENDING`
 * (an attribution window still open is neither a success nor a failure -
 * never counted as either, mirroring the measurement layer's own maturity
 * discipline without duplicating its logic).
 */
export async function getRecoveryOverview(merchantId: string, query: RecoveryOverviewQuery): Promise<RecoveryOverviewResult> {
  const until = query.until ?? new Date();

  const [openRiskEvents, candidatesCount, executionsByStatus, outcomes, incrementalRecovery] = await Promise.all([
    prisma.revenueRiskEvent.findMany({
      where: { merchantId, resolvedAt: null },
      distinct: ["paymentId"],
      select: { paymentId: true, amountAtRisk: true },
    }),
    prisma.revenueRiskEvent.count({
      where: { merchantId, resolvedAt: null },
    }),
    prisma.execution.groupBy({
      by: ["status"],
      where: {
        payment: { merchantId },
        executedAt: { ...(query.since ? { gte: query.since } : {}), lt: until },
      },
      _count: true,
    }),
    prisma.outcome.findMany({
      where: {
        payment: { merchantId },
        status: { not: "PENDING" },
        observedAt: { ...(query.since ? { gte: query.since } : {}), lt: until },
      },
      select: { paymentId: true, status: true, attributionStatus: true, recoveredAmount: true },
    }),
    computeIncrementalRecovery(merchantId),
  ]);

  const revenueAtRiskPaise = sumDistinctByPayment(
    openRiskEvents.map((r) => ({ paymentId: r.paymentId, amountPaise: r.amountAtRisk }))
  );

  const interventionsAttempted = executionsByStatus.reduce((sum, g) => sum + g._count, 0);
  const interventionsSucceeded = executionsByStatus.find((g) => g.status === "SUCCEEDED")?._count ?? 0;

  const matureOutcomesCount = outcomes.length;
  const recoveredCount = outcomes.filter((o) => o.status === "RECOVERED").length;
  const naturalRecoveryOutcomes = outcomes.filter((o) => o.attributionStatus === "NATURAL_RECOVERY");
  const interventionRecoveryOutcomes = outcomes.filter((o) => o.attributionStatus === "INTERVENTION_RECOVERY");
  const unknownAttributionCount = outcomes.filter((o) => o.attributionStatus === "UNKNOWN").length;

  const naturalRecoveryGmvPaise = sumDistinctByPayment(
    naturalRecoveryOutcomes.map((o) => ({ paymentId: o.paymentId, amountPaise: o.recoveredAmount ?? 0 }))
  );
  const interventionRecoveryGmvPaise = sumDistinctByPayment(
    interventionRecoveryOutcomes.map((o) => ({ paymentId: o.paymentId, amountPaise: o.recoveredAmount ?? 0 }))
  );

  return {
    period: { since: query.since?.toISOString() ?? null, until: until.toISOString() },
    operational: {
      candidatesCount,
      revenueAtRiskPaise,
      interventionsAttempted,
      interventionsSucceeded,
    },
    attributedOutcomes: {
      matureOutcomesCount,
      recoveredCount,
      naturalRecoveryCount: naturalRecoveryOutcomes.length,
      interventionRecoveryCount: interventionRecoveryOutcomes.length,
      unknownAttributionCount,
      naturalRecoveryGmvPaise,
      interventionRecoveryGmvPaise,
      observedRecoveryRate: matureOutcomesCount > 0 ? recoveredCount / matureOutcomesCount : null,
    },
    incrementalRecovery,
  };
}

/**
 * Decision-type breakdown across this merchant's currently OPEN recovery
 * candidates (Phase 28C Overview redesign, additive - never modifies
 * `getRecoveryOverview`'s existing return shape or any existing caller).
 * Same current-state, unwindowed framing as `operational.candidatesCount`
 * above: "what does the queue look like right now," not a historical
 * count. A RevenueRiskEvent can have at most the decisions actually
 * persisted for it; this counts the LATEST decision per open risk event
 * (mirroring `recoveryQueueService.ts`'s own "most recent decision per
 * candidate" convention), never double-counting a re-decided candidate.
 */
export type DecisionMix = Record<RecoveryDecision, number>;

export async function getDecisionMix(merchantId: string): Promise<DecisionMix> {
  const openRiskEvents = await prisma.revenueRiskEvent.findMany({
    where: { merchantId, resolvedAt: null },
    select: {
      decisions: {
        orderBy: { decidedAt: "desc" },
        take: 1,
        select: { decisionType: true },
      },
    },
  });

  const mix: DecisionMix = { ACT: 0, WAIT: 0, STOP: 0, ESCALATE: 0 };
  for (const event of openRiskEvents) {
    const latest = event.decisions[0];
    if (latest) mix[latest.decisionType] += 1;
  }
  return mix;
}

/**
 * Sum of `expectedIncrementalValuePaise` across this merchant's currently
 * open candidates' latest decisions (Phase 28C Overview redesign,
 * additive). This is a real, already-persisted field on `Decision` -
 * summing it is not a new estimate or invented metric, just an honest
 * total of a value the Decision Engine already computed per-candidate.
 * Decisions with a null expected value (WAIT/STOP/ESCALATE do not
 * ordinarily set one) contribute zero, never treated as missing/excluded
 * from the count the way a null recovery-rate would be.
 */
export async function getRecoveryOpportunityPaise(merchantId: string): Promise<number> {
  const openRiskEvents = await prisma.revenueRiskEvent.findMany({
    where: { merchantId, resolvedAt: null },
    select: {
      decisions: {
        orderBy: { decidedAt: "desc" },
        take: 1,
        select: { expectedIncrementalValue: true },
      },
    },
  });

  return openRiskEvents.reduce((sum, event) => sum + (event.decisions[0]?.expectedIncrementalValue ?? 0), 0);
}
