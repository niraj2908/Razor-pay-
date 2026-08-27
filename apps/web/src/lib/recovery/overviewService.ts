import { prisma } from "@/lib/db";

/**
 * The Recovery Overview query service (Phase 25 Step 4B).
 *
 * A read-only aggregation over EXISTING domain tables
 * (RevenueRiskEvent/Payment/Execution/Outcome) - contains NO decision
 * logic, NO economics, NO statistics, and NEVER computes or estimates an
 * incremental/causal effect. `merchantId` MUST already be the caller's own
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
 * Incremental/causal GMV is UNCONDITIONALLY unavailable - Experiment/
 * ExperimentAssignment/ExperimentMeasurementResult have no merchant
 * boundary at all (Phase 25 Step 1 audit), so no query, however
 * authorized, can safely attribute a share of any measurement result to
 * one merchant. This is never computed, estimated, or approximated here.
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
  incrementalRecovery: { status: "unavailable"; reason: "experiment_merchant_isolation_not_implemented" };
};

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

  const [openRiskEvents, candidatesCount, executionsByStatus, outcomes] = await Promise.all([
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
    // Unconditional - see this module's doc comment. Never computed from
    // ExperimentMeasurementResult here, regardless of what exists in the
    // database, because that table has no merchant boundary to safely
    // filter by (Phase 25 Step 1 audit finding, reaffirmed in Step 4).
    incrementalRecovery: { status: "unavailable", reason: "experiment_merchant_isolation_not_implemented" },
  };
}
