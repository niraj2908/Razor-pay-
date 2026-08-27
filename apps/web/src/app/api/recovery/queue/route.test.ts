import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateOperator = vi.fn();
const resolveMerchantAccess = vi.fn();
const listRecoveryQueue = vi.fn();

vi.mock("@/lib/auth/authenticateOperator", () => ({ authenticateOperator }));
vi.mock("@/lib/auth/merchantAccess", () => ({ resolveMerchantAccess }));
vi.mock("@/lib/recovery/recoveryQueueService", async () => {
  const actual = await vi.importActual<typeof import("@/lib/recovery/recoveryQueueService")>("@/lib/recovery/recoveryQueueService");
  return { ...actual, listRecoveryQueue };
});

const { GET } = await import("./route");

function requestWithQuery(query: string) {
  return new NextRequest(`http://localhost/api/recovery/queue${query}`);
}

describe("GET /api/recovery/queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateOperator.mockResolvedValue({ operator: { id: "op_1", email: "ops@example.com" }, sessionId: "session_1" });
    resolveMerchantAccess.mockResolvedValue({ merchantId: "merchant_a" });
  });

  it("1. unauthenticated queue request is rejected with 401, never reaching the query service", async () => {
    authenticateOperator.mockResolvedValue(null);
    const response = await GET(requestWithQuery(""));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(listRecoveryQueue).not.toHaveBeenCalled();
  });

  it("passes the operator's OWN resolved merchantId to the query service - never anything from the request", async () => {
    listRecoveryQueue.mockResolvedValue({ items: [], nextCursor: null });
    await GET(requestWithQuery("?merchantId=merchant_b_attacker_supplied"));
    expect(listRecoveryQueue).toHaveBeenCalledWith("merchant_a", expect.anything());
  });

  it("9. rejects an invalid status filter with 400, never reaching the query service", async () => {
    const response = await GET(requestWithQuery("?status=bogus"));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("validation_error");
    expect(listRecoveryQueue).not.toHaveBeenCalled();
  });

  it("9. rejects an invalid diagnosis filter with 400", async () => {
    const response = await GET(requestWithQuery("?diagnosis=NOT_REAL"));
    expect(response.status).toBe(400);
  });

  it("9. rejects an out-of-range limit with 400", async () => {
    const response = await GET(requestWithQuery("?limit=99999"));
    expect(response.status).toBe(400);
    const response2 = await GET(requestWithQuery("?limit=0"));
    expect(response2.status).toBe(400);
    const response3 = await GET(requestWithQuery("?limit=not-a-number"));
    expect(response3.status).toBe(400);
  });

  it("9. rejects a malformed cursor with 400", async () => {
    const response = await GET(requestWithQuery("?cursor=../../etc/passwd"));
    expect(response.status).toBe(400);
  });

  it("8. valid filters pass straight through to the query service", async () => {
    listRecoveryQueue.mockResolvedValue({ items: [], nextCursor: null });
    await GET(requestWithQuery("?status=resolved&diagnosis=CUSTOMER_ABANDONMENT&decisionType=ACT&sort=amountAtRisk_desc&limit=10"));
    expect(listRecoveryQueue).toHaveBeenCalledWith("merchant_a", {
      status: "resolved",
      diagnosis: "CUSTOMER_ABANDONMENT",
      decisionType: "ACT",
      sort: "amountAtRisk_desc",
      cursor: undefined,
      limit: 10,
    });
  });

  it("10. an empty queue returns 200 with an empty items array, not an error", async () => {
    listRecoveryQueue.mockResolvedValue({ items: [], nextCursor: null });
    const response = await GET(requestWithQuery(""));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], nextCursor: null });
  });

  it("returns a sanitized 500 (never a stack trace) on an unexpected service failure", async () => {
    listRecoveryQueue.mockRejectedValue(new Error("connection refused at 10.0.0.5:5432"));
    const response = await GET(requestWithQuery(""));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
  });

  it("500 (not silently unauthenticated) if the operator has no resolvable merchant", async () => {
    resolveMerchantAccess.mockResolvedValue(null);
    const response = await GET(requestWithQuery(""));
    expect(response.status).toBe(500);
  });
});
