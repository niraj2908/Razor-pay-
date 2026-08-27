import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { revenueRiskEvent: { findMany } },
}));

const { listRecoveryQueue, isValidStatusFilter, isValidSort, isValidDiagnosis, isValidDecisionType, isPlausibleId } = await import("./recoveryQueueService");

const MERCHANT_A = "merchant_a";

function fixtureRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "risk_1",
    merchantId: MERCHANT_A,
    diagnosis: "CUSTOMER_ABANDONMENT",
    amountAtRisk: 10000,
    naturalRecoveryProbability: 0.3,
    detectedAt: new Date("2026-01-01T00:00:00.000Z"),
    resolvedAt: null,
    payment: { id: "payment_1", status: "FAILED", method: "card", amount: 10000, currency: "INR" },
    decisions: [
      {
        id: "decision_1",
        decisionType: "ACT",
        decidedAt: new Date("2026-01-01T00:05:00.000Z"),
        expectedIncrementalValue: 5000,
        chosenAction: { actionType: "PAYMENT_LINK", predictedSuccessProbability: 0.6 },
      },
    ],
    ...overrides,
  };
}

describe("recoveryQueueService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validation guards", () => {
    it("isValidStatusFilter accepts only open/resolved/all", () => {
      expect(isValidStatusFilter("open")).toBe(true);
      expect(isValidStatusFilter("resolved")).toBe(true);
      expect(isValidStatusFilter("all")).toBe(true);
      expect(isValidStatusFilter("bogus")).toBe(false);
      expect(isValidStatusFilter(123)).toBe(false);
    });

    it("isValidSort accepts only the allowlisted sort keys", () => {
      expect(isValidSort("detectedAt_asc")).toBe(true);
      expect(isValidSort("amountAtRisk_desc")).toBe(true);
      expect(isValidSort("'; DROP TABLE revenue_risk_events; --")).toBe(false);
    });

    it("isValidDiagnosis accepts only real RiskDiagnosis enum values", () => {
      expect(isValidDiagnosis("CUSTOMER_ABANDONMENT")).toBe(true);
      expect(isValidDiagnosis("NOT_A_REAL_DIAGNOSIS")).toBe(false);
    });

    it("isValidDecisionType accepts only real RecoveryDecision enum values", () => {
      expect(isValidDecisionType("ACT")).toBe(true);
      expect(isValidDecisionType("MAYBE")).toBe(false);
    });

    it("isPlausibleId rejects malformed/oversized/injection-shaped identifiers", () => {
      expect(isPlausibleId("cljk3n4p90000abc")).toBe(true);
      expect(isPlausibleId("")).toBe(false);
      expect(isPlausibleId("a".repeat(41))).toBe(false);
      expect(isPlausibleId("../../etc/passwd")).toBe(false);
      expect(isPlausibleId("1 OR 1=1")).toBe(false);
      expect(isPlausibleId(null)).toBe(false);
    });
  });

  describe("listRecoveryQueue", () => {
    it("scopes the query to the given merchantId - the core isolation contract", async () => {
      findMany.mockResolvedValue([]);
      await listRecoveryQueue(MERCHANT_A, {});
      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ merchantId: MERCHANT_A }) }));
    });

    it("defaults to status=open (resolvedAt: null)", async () => {
      findMany.mockResolvedValue([]);
      await listRecoveryQueue(MERCHANT_A, {});
      const call = findMany.mock.calls[0][0];
      expect(call.where.resolvedAt).toBeNull();
    });

    it("status=all applies no resolvedAt filter", async () => {
      findMany.mockResolvedValue([]);
      await listRecoveryQueue(MERCHANT_A, { status: "all" });
      const call = findMany.mock.calls[0][0];
      expect(call.where.resolvedAt).toBeUndefined();
    });

    it("maps rows into the documented DTO shape, in paise, with no chosenAction when none exists", async () => {
      findMany.mockResolvedValue([fixtureRow(), fixtureRow({ id: "risk_2", decisions: [] })]);
      const result = await listRecoveryQueue(MERCHANT_A, {});

      expect(result.items[0]).toEqual({
        id: "risk_1",
        detectedAt: "2026-01-01T00:00:00.000Z",
        resolvedAt: null,
        diagnosis: "CUSTOMER_ABANDONMENT",
        amountAtRiskPaise: 10000,
        naturalRecoveryProbability: 0.3,
        payment: { id: "payment_1", status: "FAILED", method: "card", amountPaise: 10000, currency: "INR" },
        decision: {
          id: "decision_1",
          decisionType: "ACT",
          decidedAt: "2026-01-01T00:05:00.000Z",
          expectedIncrementalValuePaise: 5000,
          chosenAction: { actionType: "PAYMENT_LINK", predictedSuccessProbability: 0.6 },
        },
      });
      expect(result.items[1].decision).toBeNull(); // no decision yet -> null, never fabricated
    });

    it("paginates: requests limit+1 rows and returns nextCursor only when there IS a next page", async () => {
      findMany.mockResolvedValue(Array.from({ length: 3 }, (_, i) => fixtureRow({ id: `risk_${i}` })));
      const result = await listRecoveryQueue(MERCHANT_A, { limit: 2 });

      const call = findMany.mock.calls[0][0];
      expect(call.take).toBe(3); // limit + 1

      expect(result.items).toHaveLength(2); // the extra probe row is trimmed off
      expect(result.nextCursor).toBe("risk_1"); // the last row actually returned
    });

    it("no next page when fewer rows than the limit come back", async () => {
      findMany.mockResolvedValue([fixtureRow()]);
      const result = await listRecoveryQueue(MERCHANT_A, { limit: 25 });
      expect(result.nextCursor).toBeNull();
    });

    it("empty queue returns an empty items array, not an error", async () => {
      findMany.mockResolvedValue([]);
      const result = await listRecoveryQueue(MERCHANT_A, {});
      expect(result).toEqual({ items: [], nextCursor: null });
    });

    it("clamps an out-of-range limit rather than trusting it directly", async () => {
      findMany.mockResolvedValue([]);
      await listRecoveryQueue(MERCHANT_A, { limit: 99999 });
      const call = findMany.mock.calls[0][0];
      expect(call.take).toBeLessThanOrEqual(101); // MAX_LIMIT(100) + 1
    });

    it("passes the cursor through as a Prisma cursor object with skip:1", async () => {
      findMany.mockResolvedValue([]);
      await listRecoveryQueue(MERCHANT_A, { cursor: "risk_5" });
      const call = findMany.mock.calls[0][0];
      expect(call.cursor).toEqual({ id: "risk_5" });
      expect(call.skip).toBe(1);
    });
  });
});
