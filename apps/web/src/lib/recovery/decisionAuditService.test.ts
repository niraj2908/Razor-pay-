import { beforeEach, describe, expect, it, vi } from "vitest";

const decisionFindFirst = vi.fn();
const auditEventFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    decision: { findFirst: decisionFindFirst },
    auditEvent: { findMany: auditEventFindMany },
  },
}));

const { getDecisionAuditTrail, isValidAuditEntityType } = await import("./decisionAuditService");

function baseAuditRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "claudit0001",
    entityType: "Decision",
    action: "decision.act",
    actorType: "SYSTEM",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    details: { decisionId: "cldecision1", paymentId: "clpayment1", selectedAction: "ACT", selectedStrategy: "PAYMENT_LINK", policyVersion: "policy-v1", modelVersion: "baseline-v1", reason: "positive_expected_incremental_value" },
    ...overrides,
  };
}

function decisionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cldecision1",
    executions: [],
    outcome: null,
    ...overrides,
  };
}

describe("decisionAuditService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isValidAuditEntityType", () => {
    it("accepts only Decision/Execution/Outcome", () => {
      expect(isValidAuditEntityType("Decision")).toBe(true);
      expect(isValidAuditEntityType("Execution")).toBe(true);
      expect(isValidAuditEntityType("Outcome")).toBe(true);
      expect(isValidAuditEntityType("PaymentEvent")).toBe(false);
      expect(isValidAuditEntityType("ExperimentAssignment")).toBe(false);
      expect(isValidAuditEntityType("ExperimentMeasurementResult")).toBe(false);
      expect(isValidAuditEntityType("bogus")).toBe(false);
    });
  });

  describe("merchant isolation", () => {
    it("scopes the decision lookup to (id, merchantId) via revenueRiskEvent - never queries AuditEvent.merchantId", async () => {
      decisionFindFirst.mockResolvedValue(null);
      await getDecisionAuditTrail("merchant_a", "cldecision1", {});
      expect(decisionFindFirst).toHaveBeenCalledWith({
        where: { id: "cldecision1", revenueRiskEvent: { merchantId: "merchant_a" } },
        include: { executions: true, outcome: true },
      });
      expect(auditEventFindMany).not.toHaveBeenCalled();
    });

    it("returns not_found (never a different shape) for a foreign-merchant or nonexistent decision", async () => {
      decisionFindFirst.mockResolvedValue(null);
      const result = await getDecisionAuditTrail("merchant_a", "belongs_to_merchant_b", {});
      expect(result).toEqual({ status: "not_found" });
    });
  });

  describe("DTO sanitization - the exposure security boundary", () => {
    it("Decision: keeps only the allowlisted fields", async () => {
      decisionFindFirst.mockResolvedValue(decisionRow());
      auditEventFindMany.mockResolvedValue([baseAuditRow()]);
      const result = await getDecisionAuditTrail("merchant_a", "cldecision1", {});
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.items[0].details).toEqual({
          decisionId: "cldecision1",
          paymentId: "clpayment1",
          selectedAction: "ACT",
          selectedStrategy: "PAYMENT_LINK",
          policyVersion: "policy-v1",
          modelVersion: "baseline-v1",
          reason: "positive_expected_incremental_value",
        });
      }
    });

    it("Execution: keeps only the allowlisted fields, including numeric amount and non-secret razorpayReferenceId", async () => {
      decisionFindFirst.mockResolvedValue(decisionRow({ executions: [{ id: "clexec1" }] }));
      auditEventFindMany.mockResolvedValue([
        baseAuditRow({
          id: "claudit_exec",
          entityType: "Execution",
          action: "execution.succeeded",
          details: { decisionId: "cldecision1", razorpayReferenceId: "plink_abc123" },
        }),
      ]);
      const result = await getDecisionAuditTrail("merchant_a", "cldecision1", {});
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.items[0].details).toEqual({ decisionId: "cldecision1", razorpayReferenceId: "plink_abc123" });
      }
    });

    it("Outcome: keeps only the allowlisted fields, preserving a null attributionStatus", async () => {
      decisionFindFirst.mockResolvedValue(decisionRow({ outcome: { id: "cloutcome1" } }));
      auditEventFindMany.mockResolvedValue([
        baseAuditRow({
          id: "claudit_outcome",
          entityType: "Outcome",
          action: "outcome.created",
          details: { decisionId: "cldecision1", outcomeStatus: "PENDING", attributionStatus: null, reason: "window_open", attributionPolicyVersion: "attribution-v1" },
        }),
      ]);
      const result = await getDecisionAuditTrail("merchant_a", "cldecision1", {});
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.items[0].details).toEqual({
          decisionId: "cldecision1",
          outcomeStatus: "PENDING",
          attributionStatus: null,
          reason: "window_open",
          attributionPolicyVersion: "attribution-v1",
        });
      }
    });

    it("drops a field not in the allowlist, and drops a wrongly-typed value under an allowlisted key, instead of ever forwarding it", async () => {
      decisionFindFirst.mockResolvedValue(decisionRow());
      auditEventFindMany.mockResolvedValue([
        baseAuditRow({
          details: {
            decisionId: "cldecision1",
            reason: "x",
            // Not in the Decision allowlist at all - must never appear.
            unitKey: "clcustomer_real_id_should_never_leak",
            // In the allowlist by key name, but wrong type (object, not string) - must be dropped.
            paymentId: { nested: "object" },
          },
        }),
      ]);
      const result = await getDecisionAuditTrail("merchant_a", "cldecision1", {});
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.items[0].details).toEqual({ decisionId: "cldecision1", reason: "x" });
        expect(JSON.stringify(result.items[0].details)).not.toContain("unitKey");
        expect(JSON.stringify(result.items[0].details)).not.toContain("clcustomer_real_id_should_never_leak");
      }
    });

    it("never serializes AuditEvent.details wholesale - a completely unexpected details shape yields an empty object, never a passthrough", async () => {
      decisionFindFirst.mockResolvedValue(decisionRow());
      auditEventFindMany.mockResolvedValue([baseAuditRow({ details: { somethingEntirelyNew: "future field", nested: { a: 1 } } })]);
      const result = await getDecisionAuditTrail("merchant_a", "cldecision1", {});
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.items[0].details).toEqual({});
      }
    });
  });

  describe("entity scope - PaymentEvent/ExperimentAssignment can never appear", () => {
    it("queries AuditEvent only by the Decision/Execution/Outcome entityRefs it derived - never a broader filter", async () => {
      decisionFindFirst.mockResolvedValue(decisionRow({ executions: [{ id: "clexec1" }], outcome: { id: "cloutcome1" } }));
      auditEventFindMany.mockResolvedValue([]);
      await getDecisionAuditTrail("merchant_a", "cldecision1", {});
      expect(auditEventFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { entityType: "Decision", entityId: "cldecision1" },
              { entityType: "Execution", entityId: "clexec1" },
              { entityType: "Outcome", entityId: "cloutcome1" },
            ],
          }),
        })
      );
    });

    it("a WAIT/STOP/ESCALATE decision (no Execution, no Outcome) queries only the Decision entityRef", async () => {
      decisionFindFirst.mockResolvedValue(decisionRow());
      auditEventFindMany.mockResolvedValue([baseAuditRow()]);
      await getDecisionAuditTrail("merchant_a", "cldecision1", {});
      expect(auditEventFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ OR: [{ entityType: "Decision", entityId: "cldecision1" }] }) })
      );
    });

    it("an entityType filter for a stage that doesn't exist on this decision returns an empty trail without querying AuditEvent", async () => {
      decisionFindFirst.mockResolvedValue(decisionRow()); // no executions
      const result = await getDecisionAuditTrail("merchant_a", "cldecision1", { entityType: "Execution" });
      expect(result).toEqual({ status: "found", items: [], nextCursor: null });
      expect(auditEventFindMany).not.toHaveBeenCalled();
    });
  });

  describe("pagination", () => {
    it("detects a next page via the limit+1 probe row", async () => {
      decisionFindFirst.mockResolvedValue(decisionRow());
      auditEventFindMany.mockResolvedValue([
        baseAuditRow({ id: "a" }),
        baseAuditRow({ id: "b" }),
      ]);
      const result = await getDecisionAuditTrail("merchant_a", "cldecision1", { limit: 1 });
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.items).toHaveLength(1);
        expect(result.nextCursor).toBe("a");
      }
    });

    it("returns nextCursor: null when there is no further page", async () => {
      decisionFindFirst.mockResolvedValue(decisionRow());
      auditEventFindMany.mockResolvedValue([baseAuditRow({ id: "a" })]);
      const result = await getDecisionAuditTrail("merchant_a", "cldecision1", { limit: 25 });
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.nextCursor).toBeNull();
      }
    });

    it("orders chronologically (createdAt asc, id asc tiebreak)", async () => {
      decisionFindFirst.mockResolvedValue(decisionRow());
      auditEventFindMany.mockResolvedValue([]);
      await getDecisionAuditTrail("merchant_a", "cldecision1", {});
      expect(auditEventFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
      );
    });
  });
});
