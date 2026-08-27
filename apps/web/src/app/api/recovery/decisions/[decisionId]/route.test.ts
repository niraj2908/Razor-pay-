import { describe, expect, it, vi, beforeEach } from "vitest";

const authenticateOperator = vi.fn();
const resolveMerchantAccess = vi.fn();
const getDecisionDetail = vi.fn();

vi.mock("@/lib/auth/authenticateOperator", () => ({ authenticateOperator }));
vi.mock("@/lib/auth/merchantAccess", () => ({ resolveMerchantAccess }));
vi.mock("@/lib/recovery/decisionDetailService", () => ({ getDecisionDetail }));

const { GET } = await import("./route");

function contextFor(decisionId: string) {
  return { params: Promise.resolve({ decisionId }) };
}

// Real Prisma cuid()s are lowercase alphanumeric only (no underscores) -
// these fixture ids match that shape so they pass isPlausibleId, exactly
// like a real decision id would.
const REAL_DECISION_ID = "cldecision0001abc";
const NONEXISTENT_DECISION_ID = "cldecisiondoesnotexist";
const OTHER_MERCHANT_DECISION_ID = "cldecisionownedbymerchantb";

const DUMMY_REQUEST = new Request(`http://localhost/api/recovery/decisions/${REAL_DECISION_ID}`);

describe("GET /api/recovery/decisions/[decisionId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateOperator.mockResolvedValue({ operator: { id: "op_1", email: "ops@example.com" }, sessionId: "session_1" });
    resolveMerchantAccess.mockResolvedValue({ merchantId: "merchant_a" });
  });

  it("2. unauthenticated decision request is rejected with 401, never reaching the query service", async () => {
    authenticateOperator.mockResolvedValue(null);
    const response = await GET(DUMMY_REQUEST, contextFor(REAL_DECISION_ID));
    expect(response.status).toBe(401);
    expect(getDecisionDetail).not.toHaveBeenCalled();
  });

  it("passes the operator's OWN resolved merchantId to the query service", async () => {
    getDecisionDetail.mockResolvedValue({ status: "not_found" });
    await GET(DUMMY_REQUEST, contextFor(REAL_DECISION_ID));
    expect(getDecisionDetail).toHaveBeenCalledWith("merchant_a", REAL_DECISION_ID);
  });

  it("rejects a malformed decision id with 400 before ever querying", async () => {
    const response = await GET(DUMMY_REQUEST, contextFor("../../etc/passwd"));
    expect(response.status).toBe(400);
    expect(getDecisionDetail).not.toHaveBeenCalled();
  });

  it("12. a nonexistent decision returns 404", async () => {
    getDecisionDetail.mockResolvedValue({ status: "not_found" });
    const response = await GET(DUMMY_REQUEST, contextFor(NONEXISTENT_DECISION_ID));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("13. a decision belonging to another merchant ALSO returns 404 (identical body) - never distinguishable from not-found", async () => {
    getDecisionDetail.mockResolvedValue({ status: "not_found" });
    const response = await GET(DUMMY_REQUEST, contextFor(OTHER_MERCHANT_DECISION_ID));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("11. a valid, accessible decision returns 200 with its detail", async () => {
    const dto = { id: REAL_DECISION_ID, decisionType: "ACT" };
    getDecisionDetail.mockResolvedValue({ status: "found", decision: dto });
    const response = await GET(DUMMY_REQUEST, contextFor(REAL_DECISION_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(dto);
  });

  it("returns a sanitized 500 on an unexpected service failure", async () => {
    getDecisionDetail.mockRejectedValue(new Error("connection refused at 10.0.0.5:5432"));
    const response = await GET(DUMMY_REQUEST, contextFor(REAL_DECISION_ID));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
  });

  it("500 if the operator has no resolvable merchant", async () => {
    resolveMerchantAccess.mockResolvedValue(null);
    const response = await GET(DUMMY_REQUEST, contextFor(REAL_DECISION_ID));
    expect(response.status).toBe(500);
  });
});
