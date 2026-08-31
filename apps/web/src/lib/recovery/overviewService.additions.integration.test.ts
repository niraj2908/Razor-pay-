import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getDecisionMix, getRecoveryOpportunityPaise } from "./overviewService";
import { getRecentActivity } from "./activityFeedService";
import { getPaymentActivity } from "@/lib/reports/reportingService";

/**
 * Real-database integration coverage for the Phase 28C additive
 * aggregations (`getDecisionMix`, `getRecoveryOpportunityPaise`,
 * `getRecentActivity`, `getPaymentActivity`). Builds its own small, real
 * dataset (one Merchant/Operator, a handful of Payment/RevenueRiskEvent/
 * Decision rows with known values) rather than depending on the Demo
 * Workspace's seed state - hermetic and independent of whether the demo
 * happens to be seeded when this suite runs.
 */
describe("Phase 28C additive overview/reporting aggregations against a real database", () => {
  let merchantId: string;
  let openActDecisionId: string;
  let openWaitDecisionId: string;

  beforeAll(async () => {
    const tag = randomUUID();
    const merchant = await prisma.merchant.create({ data: { name: `phase28c-additions-${tag}` } });
    merchantId = merchant.id;

    const paymentAct = await prisma.payment.create({ data: { merchantId, amount: 50000, status: "FAILED", method: "upi" } });
    const paymentWait = await prisma.payment.create({ data: { merchantId, amount: 30000, status: "FAILED", method: "card" } });

    const riskEventAct = await prisma.revenueRiskEvent.create({
      data: { merchantId, paymentId: paymentAct.id, diagnosis: "CONFIRMED_FAILURE", amountAtRisk: 50000, detectedAt: new Date("2026-01-01T00:00:00Z") },
    });
    const riskEventWait = await prisma.revenueRiskEvent.create({
      data: { merchantId, paymentId: paymentWait.id, diagnosis: "PENDING", amountAtRisk: 30000, detectedAt: new Date("2026-01-01T00:00:00Z") },
    });

    const actDecision = await prisma.decision.create({
      data: {
        revenueRiskEventId: riskEventAct.id,
        decisionType: "ACT",
        decidedAt: new Date("2026-01-01T00:05:00Z"),
        expectedIncrementalValue: 12000,
      },
    });
    const waitDecision = await prisma.decision.create({
      data: {
        revenueRiskEventId: riskEventWait.id,
        decisionType: "WAIT",
        decidedAt: new Date("2026-01-01T00:05:00Z"),
        expectedIncrementalValue: null,
      },
    });
    openActDecisionId = actDecision.id;
    openWaitDecisionId = waitDecision.id;

    await prisma.auditEvent.create({
      data: { entityType: "Decision", entityId: actDecision.id, action: "decision.act", actorType: "SYSTEM", details: { decisionId: actDecision.id, selectedAction: "ACT" } },
    });
  }, 30_000);

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { entityId: { in: [openActDecisionId, openWaitDecisionId] } } });
    await prisma.merchant.delete({ where: { id: merchantId } });
    await prisma.$disconnect();
  }, 30_000);

  it("getDecisionMix counts each open candidate's latest decision exactly once, by type", async () => {
    const mix = await getDecisionMix(merchantId);
    expect(mix).toEqual({ ACT: 1, WAIT: 1, STOP: 0, ESCALATE: 0 });
  });

  it("getRecoveryOpportunityPaise sums real expectedIncrementalValue across open decisions, treating null as zero", async () => {
    const opportunity = await getRecoveryOpportunityPaise(merchantId);
    expect(opportunity).toBe(12000);
  });

  it("getRecentActivity returns the real, sanitized audit event for this merchant's decision", async () => {
    const activity = await getRecentActivity(merchantId, 10);
    expect(activity.length).toBeGreaterThanOrEqual(1);
    const event = activity.find((e) => e.details.decisionId === openActDecisionId);
    expect(event).toBeDefined();
    expect(event?.entityType).toBe("Decision");
    expect(event?.action).toBe("decision.act");
    // Never exposes a raw field beyond the sanitized allowlist.
    expect(Object.keys(event?.details ?? {}).sort()).toEqual(["decisionId", "selectedAction"].sort());
  });

  it("getPaymentActivity aggregates real Payment rows by status and method for this merchant only", async () => {
    const activity = await getPaymentActivity(merchantId, {});
    expect(activity.totalCount).toBe(2);
    expect(activity.totalAmountPaise).toBe(80000);
    expect(activity.byStatus.FAILED).toEqual({ count: 2, amountPaise: 80000 });
    const methods = new Set(activity.byMethod.map((m) => m.method));
    expect(methods).toEqual(new Set(["upi", "card"]));
  });

  it("every aggregation is scoped to its own merchant and never leaks another merchant's rows", async () => {
    const tag = randomUUID();
    const otherMerchant = await prisma.merchant.create({ data: { name: `phase28c-control-${tag}` } });
    try {
      const mix = await getDecisionMix(otherMerchant.id);
      const opportunity = await getRecoveryOpportunityPaise(otherMerchant.id);
      const activity = await getRecentActivity(otherMerchant.id, 10);
      const paymentActivity = await getPaymentActivity(otherMerchant.id, {});

      expect(mix).toEqual({ ACT: 0, WAIT: 0, STOP: 0, ESCALATE: 0 });
      expect(opportunity).toBe(0);
      expect(activity).toEqual([]);
      expect(paymentActivity.totalCount).toBe(0);
    } finally {
      await prisma.merchant.delete({ where: { id: otherMerchant.id } });
    }
  });
});
