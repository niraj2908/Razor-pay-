import type { RazorpayPaymentStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getRecoveryOverview, getDecisionMix, getRecoveryOpportunityPaise, type RecoveryOverviewResult, type DecisionMix } from "@/lib/recovery/overviewService";
import { listExperiments, getExperimentDetail, type ExperimentDetailDTO } from "@/lib/experiments/measurement/experimentQueryService";
import { getRecentActivity } from "@/lib/recovery/activityFeedService";
import type { AuditEventDTO } from "@/lib/recovery/decisionAuditService";

/**
 * Reports aggregation (Phase 28C). Every figure here is either a direct
 * reuse of an existing, already-authorized query service (`overviewService`,
 * `experimentQueryService`, `activityFeedService`) or a new, additive,
 * read-only Prisma aggregation over the EXISTING `Payment` table
 * (`getPaymentActivity` below) - no schema change, no new estimate, no
 * invented figure. `merchantId` MUST already be the caller's own
 * authorized merchant, identical trust contract to every other query
 * service in this codebase.
 *
 * This module deliberately contains no PDF/CSV formatting - see
 * `src/app/api/reports/export/route.ts` for that. Keeping data assembly
 * separate from document rendering means the same `ReportData` backs both
 * the on-screen /reports page and both export formats, so they can never
 * drift apart.
 */

export type PaymentActivity = {
  totalCount: number;
  totalAmountPaise: number;
  byStatus: Partial<Record<RazorpayPaymentStatus, { count: number; amountPaise: number }>>;
  byMethod: Array<{ method: string; count: number; amountPaise: number }>;
};

/** `since`/`until` reuse `overviewService.ts`'s own `validateDateRange`
 * contract at the route layer - this function trusts already-validated
 * Date objects, exactly like `getRecoveryOverview`. */
export async function getPaymentActivity(merchantId: string, range: { since?: Date; until?: Date }): Promise<PaymentActivity> {
  const where = {
    merchantId,
    createdAt: { ...(range.since ? { gte: range.since } : {}), ...(range.until ? { lt: range.until } : {}) },
  };

  const [byStatusRows, byMethodRows] = await Promise.all([
    prisma.payment.groupBy({ by: ["status"], where, _count: true, _sum: { amount: true } }),
    prisma.payment.groupBy({ by: ["method"], where, _count: true, _sum: { amount: true } }),
  ]);

  const byStatus: PaymentActivity["byStatus"] = {};
  let totalCount = 0;
  let totalAmountPaise = 0;
  for (const row of byStatusRows) {
    byStatus[row.status] = { count: row._count, amountPaise: row._sum.amount ?? 0 };
    totalCount += row._count;
    totalAmountPaise += row._sum.amount ?? 0;
  }

  const byMethod = byMethodRows
    .map((row) => ({ method: row.method ?? "Not recorded", count: row._count, amountPaise: row._sum.amount ?? 0 }))
    .sort((a, b) => b.amountPaise - a.amountPaise);

  return { totalCount, totalAmountPaise, byStatus, byMethod };
}

export type ReportData = {
  generatedAt: string;
  period: { since: string | null; until: string };
  paymentActivity: PaymentActivity;
  overview: RecoveryOverviewResult;
  decisionMix: DecisionMix;
  recoveryOpportunityPaise: number;
  experiments: ExperimentDetailDTO[];
  recentActivity: AuditEventDTO[];
};

const MAX_EXPERIMENTS_IN_REPORT = 10;

/**
 * Assembles the full Reports payload for one merchant/date-range. Fetches
 * at most `MAX_EXPERIMENTS_IN_REPORT` experiments' full detail (not just
 * the summary list) so the report can show each one's real measurement
 * result - bounded rather than unbounded to keep this a small, predictable
 * query set at any real scale; a merchant with more experiments than that
 * sees the report note the cap rather than silently truncating unnoticed
 * (see the /reports page's own rendering).
 */
export async function getReportData(merchantId: string, range: { since?: Date; until?: Date }): Promise<ReportData> {
  const [paymentActivity, overview, decisionMix, recoveryOpportunityPaise, experimentList, recentActivity] = await Promise.all([
    getPaymentActivity(merchantId, range),
    getRecoveryOverview(merchantId, range),
    getDecisionMix(merchantId),
    getRecoveryOpportunityPaise(merchantId),
    listExperiments(merchantId, { limit: MAX_EXPERIMENTS_IN_REPORT }),
    getRecentActivity(merchantId, 25),
  ]);

  const experimentDetails = await Promise.all(
    experimentList.items.map(async (summary) => {
      const detail = await getExperimentDetail(merchantId, summary.id);
      return detail.status === "found" ? detail.experiment : null;
    })
  );

  return {
    generatedAt: new Date().toISOString(),
    period: overview.period,
    paymentActivity,
    overview,
    decisionMix,
    recoveryOpportunityPaise,
    experiments: experimentDetails.filter((e): e is ExperimentDetailDTO => e !== null),
    recentActivity,
  };
}
