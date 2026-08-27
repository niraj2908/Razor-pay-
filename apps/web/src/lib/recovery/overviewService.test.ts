import { beforeEach, describe, expect, it, vi } from "vitest";

const revenueRiskEventFindMany = vi.fn();
const revenueRiskEventCount = vi.fn();
const executionGroupBy = vi.fn();
const outcomeFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    revenueRiskEvent: { findMany: revenueRiskEventFindMany, count: revenueRiskEventCount },
    execution: { groupBy: executionGroupBy },
    outcome: { findMany: outcomeFindMany },
  },
}));

const { getRecoveryOverview, validateDateRange, parseDateParam } = await import("./overviewService");

const MERCHANT_A = "merchant_a";

function defaultMocks() {
  revenueRiskEventFindMany.mockResolvedValue([]);
  revenueRiskEventCount.mockResolvedValue(0);
  executionGroupBy.mockResolvedValue([]);
  outcomeFindMany.mockResolvedValue([]);
}

describe("overviewService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultMocks();
  });

  describe("date validation", () => {
    it("parseDateParam accepts a valid ISO date and rejects garbage", () => {
      expect(parseDateParam("2026-01-01T00:00:00.000Z")).toBeInstanceOf(Date);
      expect(parseDateParam("not-a-date")).toBeNull();
      expect(parseDateParam("")).toBeNull();
    });

    it("validateDateRange accepts no params (all-time)", () => {
      expect(validateDateRange(null, null)).toEqual({ valid: true, since: undefined, until: undefined });
    });

    it("validateDateRange rejects a malformed since or until", () => {
      expect(validateDateRange("garbage", null)).toEqual({ valid: false, reason: "invalid_since" });
      expect(validateDateRange(null, "garbage")).toEqual({ valid: false, reason: "invalid_until" });
    });

    it("validateDateRange rejects since >= until", () => {
      const result = validateDateRange("2026-02-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      expect(result).toEqual({ valid: false, reason: "since_not_before_until" });
    });

    it("validateDateRange rejects an excessive explicit range (> 366 days)", () => {
      const result = validateDateRange("2020-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      expect(result).toEqual({ valid: false, reason: "range_too_large" });
    });

    it("validateDateRange allows an open-ended (since only, or until only) range regardless of span", () => {
      expect(validateDateRange("2000-01-01T00:00:00.000Z", null).valid).toBe(true);
      expect(validateDateRange(null, "2026-01-01T00:00:00.000Z").valid).toBe(true);
    });

    it("validateDateRange accepts a valid range within the cap", () => {
      const result = validateDateRange("2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
      expect(result.valid).toBe(true);
    });
  });

  describe("getRecoveryOverview - merchant scoping", () => {
    it("scopes every query to the given merchantId - the core isolation contract", async () => {
      await getRecoveryOverview(MERCHANT_A, {});
      expect(revenueRiskEventFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ merchantId: MERCHANT_A }) }));
      expect(revenueRiskEventCount).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ merchantId: MERCHANT_A }) }));
      expect(executionGroupBy).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ payment: { merchantId: MERCHANT_A } } ) }));
      expect(outcomeFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ payment: { merchantId: MERCHANT_A } } ) }));
    });

    it("queries open (unresolved) risk events with distinct paymentId - the grain contract for revenueAtRiskPaise/candidatesCount", async () => {
      await getRecoveryOverview(MERCHANT_A, {});
      const call = revenueRiskEventFindMany.mock.calls[0][0];
      expect(call.where.resolvedAt).toBeNull();
      expect(call.distinct).toEqual(["paymentId"]);
    });

    it("excludes PENDING outcomes unconditionally", async () => {
      await getRecoveryOverview(MERCHANT_A, {});
      const call = outcomeFindMany.mock.calls[0][0];
      expect(call.where.status).toEqual({ not: "PENDING" });
    });
  });

  describe("getRecoveryOverview - aggregation and DTO shape", () => {
    it("empty merchant state: everything zero/null, never an error", async () => {
      const result = await getRecoveryOverview(MERCHANT_A, {});
      expect(result.operational).toEqual({
        candidatesCount: 0,
        revenueAtRiskPaise: 0,
        interventionsAttempted: 0,
        interventionsSucceeded: 0,
      });
      expect(result.attributedOutcomes).toEqual({
        matureOutcomesCount: 0,
        recoveredCount: 0,
        naturalRecoveryCount: 0,
        interventionRecoveryCount: 0,
        unknownAttributionCount: 0,
        naturalRecoveryGmvPaise: 0,
        interventionRecoveryGmvPaise: 0,
        observedRecoveryRate: null,
      });
    });

    it("incrementalRecovery is unconditionally unavailable, regardless of any other data", async () => {
      const result = await getRecoveryOverview(MERCHANT_A, {});
      expect(result.incrementalRecovery).toEqual({ status: "unavailable", reason: "experiment_merchant_isolation_not_implemented" });
    });

    it("CRITICAL: revenueAtRiskPaise sums a payment's amount only ONCE even if multiple RevenueRiskEvent rows reference it (Prisma distinct already applied) - the count is unaffected", async () => {
      // Prisma's own `distinct: ['paymentId']` would already collapse this
      // at the query layer - this test proves the service's OWN reducer
      // (sumDistinctByPayment) is ALSO correct in case duplicate paymentId
      // rows are ever returned (defense in depth, not reliance on Prisma alone).
      revenueRiskEventFindMany.mockResolvedValue([
        { paymentId: "payment_1", amountAtRisk: 10000 },
        { paymentId: "payment_1", amountAtRisk: 10000 }, // same payment, duplicate row
        { paymentId: "payment_2", amountAtRisk: 5000 },
      ]);
      revenueRiskEventCount.mockResolvedValue(4); // the RAW entity count can legitimately differ (natural grain)

      const result = await getRecoveryOverview(MERCHANT_A, {});
      expect(result.operational.revenueAtRiskPaise).toBe(15000); // 10000 + 5000, NOT 25000
      expect(result.operational.candidatesCount).toBe(4); // count uses natural entity grain, untouched by dedup
    });

    it("interventionsAttempted sums across all execution statuses; interventionsSucceeded isolates SUCCEEDED", async () => {
      executionGroupBy.mockResolvedValue([
        { status: "SUCCEEDED", _count: 3 },
        { status: "FAILED", _count: 2 },
        { status: "PENDING", _count: 1 },
      ]);
      const result = await getRecoveryOverview(MERCHANT_A, {});
      expect(result.operational.interventionsAttempted).toBe(6);
      expect(result.operational.interventionsSucceeded).toBe(3);
    });

    it("classifies natural recovery, intervention recovery, and UNKNOWN attribution correctly, and computes the recovery rate over mature outcomes only", async () => {
      outcomeFindMany.mockResolvedValue([
        { paymentId: "p1", status: "RECOVERED", attributionStatus: "NATURAL_RECOVERY", recoveredAmount: 1000 },
        { paymentId: "p2", status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 2000 },
        { paymentId: "p3", status: "RECOVERED", attributionStatus: "UNKNOWN", recoveredAmount: 3000 },
        { paymentId: "p4", status: "NOT_RECOVERED", attributionStatus: null, recoveredAmount: null },
      ]);

      const result = await getRecoveryOverview(MERCHANT_A, {});
      expect(result.attributedOutcomes.matureOutcomesCount).toBe(4);
      expect(result.attributedOutcomes.recoveredCount).toBe(3);
      expect(result.attributedOutcomes.naturalRecoveryCount).toBe(1);
      expect(result.attributedOutcomes.interventionRecoveryCount).toBe(1);
      expect(result.attributedOutcomes.unknownAttributionCount).toBe(1);
      expect(result.attributedOutcomes.naturalRecoveryGmvPaise).toBe(1000);
      expect(result.attributedOutcomes.interventionRecoveryGmvPaise).toBe(2000);
      expect(result.attributedOutcomes.observedRecoveryRate).toBe(0.75); // 3/4
    });

    it("CRITICAL: recovered GMV sums are deduplicated by distinct Payment - two INTERVENTION_RECOVERY outcomes for the SAME payment count as one payment's worth of money", async () => {
      outcomeFindMany.mockResolvedValue([
        { paymentId: "payment_dup", status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 5000 },
        { paymentId: "payment_dup", status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 5000 },
      ]);
      const result = await getRecoveryOverview(MERCHANT_A, {});
      expect(result.attributedOutcomes.interventionRecoveryGmvPaise).toBe(5000); // NOT 10000
      expect(result.attributedOutcomes.interventionRecoveryCount).toBe(2); // count uses natural grain, untouched
    });

    it("a null recoveredAmount contributes zero, never fabricated", async () => {
      outcomeFindMany.mockResolvedValue([{ paymentId: "p1", status: "RECOVERED", attributionStatus: "NATURAL_RECOVERY", recoveredAmount: null }]);
      const result = await getRecoveryOverview(MERCHANT_A, {});
      expect(result.attributedOutcomes.naturalRecoveryGmvPaise).toBe(0);
    });
  });

  describe("getRecoveryOverview - date windowing", () => {
    it("passes since/until through to the executedAt/observedAt window, but NEVER to the open-risk-event query", async () => {
      const since = new Date("2026-01-01T00:00:00.000Z");
      const until = new Date("2026-02-01T00:00:00.000Z");
      await getRecoveryOverview(MERCHANT_A, { since, until });

      const executionCall = executionGroupBy.mock.calls[0][0];
      expect(executionCall.where.executedAt).toEqual({ gte: since, lt: until });

      const outcomeCall = outcomeFindMany.mock.calls[0][0];
      expect(outcomeCall.where.observedAt).toEqual({ gte: since, lt: until });

      const riskEventCall = revenueRiskEventFindMany.mock.calls[0][0];
      expect(riskEventCall.where.detectedAt).toBeUndefined(); // current-state field, never windowed
    });

    it("defaults until to now and since to undefined (all-time) when omitted", async () => {
      const before = Date.now();
      const result = await getRecoveryOverview(MERCHANT_A, {});
      const after = Date.now();

      expect(result.period.since).toBeNull();
      const untilMs = new Date(result.period.until).getTime();
      expect(untilMs).toBeGreaterThanOrEqual(before);
      expect(untilMs).toBeLessThanOrEqual(after);
    });
  });

  describe("data safety", () => {
    it("never selects more than paymentId/amount fields from RevenueRiskEvent, and never selects PaymentEvent at all", async () => {
      await getRecoveryOverview(MERCHANT_A, {});
      const call = revenueRiskEventFindMany.mock.calls[0][0];
      expect(call.select).toEqual({ paymentId: true, amountAtRisk: true });
    });
  });
});
