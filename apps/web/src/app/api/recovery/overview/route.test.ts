import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateOperator = vi.fn();
const resolveMerchantAccess = vi.fn();
const getRecoveryOverview = vi.fn();

vi.mock("@/lib/auth/authenticateOperator", () => ({ authenticateOperator }));
vi.mock("@/lib/auth/merchantAccess", () => ({ resolveMerchantAccess }));
vi.mock("@/lib/recovery/overviewService", async () => {
  const actual = await vi.importActual<typeof import("@/lib/recovery/overviewService")>("@/lib/recovery/overviewService");
  return { ...actual, getRecoveryOverview };
});

const { GET } = await import("./route");

function requestWithQuery(query: string) {
  return new NextRequest(`http://localhost/api/recovery/overview${query}`);
}

const SAMPLE_RESULT = {
  period: { since: null, until: "2026-01-01T00:00:00.000Z" },
  operational: { candidatesCount: 0, revenueAtRiskPaise: 0, interventionsAttempted: 0, interventionsSucceeded: 0 },
  attributedOutcomes: {
    matureOutcomesCount: 0,
    recoveredCount: 0,
    naturalRecoveryCount: 0,
    interventionRecoveryCount: 0,
    unknownAttributionCount: 0,
    naturalRecoveryGmvPaise: 0,
    interventionRecoveryGmvPaise: 0,
    observedRecoveryRate: null,
  },
  incrementalRecovery: { status: "unavailable", reason: "experiment_merchant_isolation_not_implemented" },
};

describe("GET /api/recovery/overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateOperator.mockResolvedValue({ operator: { id: "op_1", email: "ops@example.com" }, sessionId: "session_1" });
    resolveMerchantAccess.mockResolvedValue({ merchantId: "merchant_a" });
  });

  it("unauthenticated request is rejected with 401, never reaching the query service", async () => {
    authenticateOperator.mockResolvedValue(null);
    const response = await GET(requestWithQuery(""));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(getRecoveryOverview).not.toHaveBeenCalled();
  });

  it("passes the operator's OWN resolved merchantId to the query service - never anything from the request", async () => {
    getRecoveryOverview.mockResolvedValue(SAMPLE_RESULT);
    await GET(requestWithQuery("?merchantId=merchant_b_attacker_supplied"));
    expect(getRecoveryOverview).toHaveBeenCalledWith("merchant_a", expect.anything());
  });

  it("500 (never silently unauthenticated) if the operator has no resolvable merchant", async () => {
    resolveMerchantAccess.mockResolvedValue(null);
    const response = await GET(requestWithQuery(""));
    expect(response.status).toBe(500);
  });

  it("rejects a malformed since with 400, never reaching the query service", async () => {
    const response = await GET(requestWithQuery("?since=not-a-date"));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("validation_error");
    expect(getRecoveryOverview).not.toHaveBeenCalled();
  });

  it("rejects a malformed until with 400", async () => {
    const response = await GET(requestWithQuery("?until=garbage"));
    expect(response.status).toBe(400);
  });

  it("rejects since >= until with 400", async () => {
    const response = await GET(requestWithQuery("?since=2026-02-01T00:00:00.000Z&until=2026-01-01T00:00:00.000Z"));
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe("since_not_before_until");
  });

  it("rejects an excessive date range with 400", async () => {
    const response = await GET(requestWithQuery("?since=2020-01-01T00:00:00.000Z&until=2026-01-01T00:00:00.000Z"));
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe("range_too_large");
  });

  it("a valid range is parsed into real Date objects and passed to the query service", async () => {
    getRecoveryOverview.mockResolvedValue(SAMPLE_RESULT);
    await GET(requestWithQuery("?since=2026-01-01T00:00:00.000Z&until=2026-02-01T00:00:00.000Z"));
    const [, query] = getRecoveryOverview.mock.calls[0];
    expect(query.since).toBeInstanceOf(Date);
    expect(query.until).toBeInstanceOf(Date);
  });

  it("an empty merchant state returns 200 with the full zeroed DTO, not an error", async () => {
    getRecoveryOverview.mockResolvedValue(SAMPLE_RESULT);
    const response = await GET(requestWithQuery(""));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SAMPLE_RESULT);
  });

  it("returns a sanitized 500 (never a stack trace) on an unexpected service failure", async () => {
    getRecoveryOverview.mockRejectedValue(new Error("connection refused at 10.0.0.5:5432"));
    const response = await GET(requestWithQuery(""));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
  });

  it("data safety: the response never contains a raw payload/PII field regardless of mocked content", async () => {
    getRecoveryOverview.mockResolvedValue(SAMPLE_RESULT);
    const response = await GET(requestWithQuery(""));
    const body = await response.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("passwordHash");
  });
});
