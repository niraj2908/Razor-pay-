import { NextRequest } from "next/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

const authenticateOperator = vi.fn();
const resolveMerchantAccess = vi.fn();
const getDecisionAuditTrail = vi.fn();

vi.mock("@/lib/auth/authenticateOperator", () => ({ authenticateOperator }));
vi.mock("@/lib/auth/merchantAccess", () => ({ resolveMerchantAccess }));
vi.mock("@/lib/recovery/decisionAuditService", async () => {
  const actual = await vi.importActual<typeof import("@/lib/recovery/decisionAuditService")>(
    "@/lib/recovery/decisionAuditService"
  );
  return { ...actual, getDecisionAuditTrail };
});

const { GET } = await import("./route");

const REAL_DECISION_ID = "cldecision0001abc";
const OTHER_MERCHANT_DECISION_ID = "cldecisionownedbymerchantb";

function contextFor(decisionId: string) {
  return { params: Promise.resolve({ decisionId }) };
}

function requestFor(decisionId: string, query = "") {
  return new NextRequest(`http://localhost/api/recovery/decisions/${decisionId}/audit${query}`);
}

describe("GET /api/recovery/decisions/[decisionId]/audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateOperator.mockResolvedValue({ operator: { id: "op_1", email: "ops@example.com" }, sessionId: "session_1" });
    resolveMerchantAccess.mockResolvedValue({ merchantId: "merchant_a" });
  });

  it("unauthenticated request is rejected with 401, never reaching the query service", async () => {
    authenticateOperator.mockResolvedValue(null);
    const response = await GET(requestFor(REAL_DECISION_ID), contextFor(REAL_DECISION_ID));
    expect(response.status).toBe(401);
    expect(getDecisionAuditTrail).not.toHaveBeenCalled();
  });

  it("passes the operator's OWN resolved merchantId to the query service", async () => {
    getDecisionAuditTrail.mockResolvedValue({ status: "found", items: [], nextCursor: null });
    await GET(requestFor(REAL_DECISION_ID), contextFor(REAL_DECISION_ID));
    expect(getDecisionAuditTrail).toHaveBeenCalledWith("merchant_a", REAL_DECISION_ID, expect.anything());
  });

  it("rejects a malformed decision id with 400 before ever querying", async () => {
    const response = await GET(requestFor("../../etc/passwd"), contextFor("../../etc/passwd"));
    expect(response.status).toBe(400);
    expect(getDecisionAuditTrail).not.toHaveBeenCalled();
  });

  it("rejects an invalid entityType with 400 (PaymentEvent/ExperimentAssignment are not valid filters)", async () => {
    const response1 = await GET(requestFor(REAL_DECISION_ID, "?entityType=PaymentEvent"), contextFor(REAL_DECISION_ID));
    expect(response1.status).toBe(400);
    const response2 = await GET(requestFor(REAL_DECISION_ID, "?entityType=ExperimentAssignment"), contextFor(REAL_DECISION_ID));
    expect(response2.status).toBe(400);
    expect(getDecisionAuditTrail).not.toHaveBeenCalled();
  });

  it("accepts a valid entityType filter and passes it through", async () => {
    getDecisionAuditTrail.mockResolvedValue({ status: "found", items: [], nextCursor: null });
    await GET(requestFor(REAL_DECISION_ID, "?entityType=Execution"), contextFor(REAL_DECISION_ID));
    expect(getDecisionAuditTrail).toHaveBeenCalledWith(
      "merchant_a",
      REAL_DECISION_ID,
      expect.objectContaining({ entityType: "Execution" })
    );
  });

  it("rejects a malformed cursor with 400", async () => {
    const response = await GET(requestFor(REAL_DECISION_ID, "?cursor=../../etc/passwd"), contextFor(REAL_DECISION_ID));
    expect(response.status).toBe(400);
  });

  it("rejects an out-of-range limit with 400", async () => {
    const response = await GET(requestFor(REAL_DECISION_ID, "?limit=99999"), contextFor(REAL_DECISION_ID));
    expect(response.status).toBe(400);
  });

  it("rejects an invalid date range with 400", async () => {
    const response = await GET(requestFor(REAL_DECISION_ID, "?since=not-a-date"), contextFor(REAL_DECISION_ID));
    expect(response.status).toBe(400);
  });

  it("a nonexistent decision returns 404", async () => {
    getDecisionAuditTrail.mockResolvedValue({ status: "not_found" });
    const response = await GET(requestFor(REAL_DECISION_ID), contextFor(REAL_DECISION_ID));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("a decision belonging to another merchant ALSO returns 404 (identical body)", async () => {
    getDecisionAuditTrail.mockResolvedValue({ status: "not_found" });
    const response = await GET(requestFor(OTHER_MERCHANT_DECISION_ID), contextFor(OTHER_MERCHANT_DECISION_ID));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("returns 200 with items/nextCursor on success", async () => {
    const dto = { id: "claudit1", entityType: "Decision", action: "decision.act", actorType: "SYSTEM", createdAt: "2026-01-01T00:00:00.000Z", details: {} };
    getDecisionAuditTrail.mockResolvedValue({ status: "found", items: [dto], nextCursor: null });
    const response = await GET(requestFor(REAL_DECISION_ID), contextFor(REAL_DECISION_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [dto], nextCursor: null });
  });

  it("returns a sanitized 500 on an unexpected service failure", async () => {
    getDecisionAuditTrail.mockRejectedValue(new Error("connection refused at 10.0.0.5:5432"));
    const response = await GET(requestFor(REAL_DECISION_ID), contextFor(REAL_DECISION_ID));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
  });

  it("500 if the operator has no resolvable merchant", async () => {
    resolveMerchantAccess.mockResolvedValue(null);
    const response = await GET(requestFor(REAL_DECISION_ID), contextFor(REAL_DECISION_ID));
    expect(response.status).toBe(500);
  });
});
