import { NextRequest } from "next/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

const authenticateOperator = vi.fn();
const resolveMerchantAccess = vi.fn();
const listExperimentResults = vi.fn();

vi.mock("@/lib/auth/authenticateOperator", () => ({ authenticateOperator }));
vi.mock("@/lib/auth/merchantAccess", () => ({ resolveMerchantAccess }));
vi.mock("@/lib/experiments/measurement/experimentQueryService", async () => {
  const actual = await vi.importActual<typeof import("@/lib/experiments/measurement/experimentQueryService")>(
    "@/lib/experiments/measurement/experimentQueryService"
  );
  return { ...actual, listExperimentResults };
});

const { GET } = await import("./route");

const REAL_EXPERIMENT_ID = "clexperiment0001abc";
const OTHER_MERCHANT_EXPERIMENT_ID = "clexperimentownedbymerchantb";

function contextFor(experimentId: string) {
  return { params: Promise.resolve({ experimentId }) };
}

function requestWithQuery(experimentId: string, query = "") {
  return new NextRequest(`http://localhost/api/experiments/${experimentId}/results${query}`);
}

describe("GET /api/experiments/[experimentId]/results", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateOperator.mockResolvedValue({ operator: { id: "op_1", email: "ops@example.com" }, sessionId: "session_1" });
    resolveMerchantAccess.mockResolvedValue({ merchantId: "merchant_a" });
  });

  it("unauthenticated request is rejected with 401, never reaching the query service", async () => {
    authenticateOperator.mockResolvedValue(null);
    const response = await GET(requestWithQuery(REAL_EXPERIMENT_ID), contextFor(REAL_EXPERIMENT_ID));
    expect(response.status).toBe(401);
    expect(listExperimentResults).not.toHaveBeenCalled();
  });

  it("passes the operator's OWN resolved merchantId to the query service", async () => {
    listExperimentResults.mockResolvedValue({ status: "found", items: [], nextCursor: null });
    await GET(requestWithQuery(REAL_EXPERIMENT_ID), contextFor(REAL_EXPERIMENT_ID));
    expect(listExperimentResults).toHaveBeenCalledWith("merchant_a", REAL_EXPERIMENT_ID, expect.anything());
  });

  it("rejects a malformed experiment id with 400 before ever querying", async () => {
    const response = await GET(requestWithQuery("../../etc/passwd"), contextFor("../../etc/passwd"));
    expect(response.status).toBe(400);
    expect(listExperimentResults).not.toHaveBeenCalled();
  });

  it("rejects an invalid kind filter with 400", async () => {
    const response = await GET(requestWithQuery(REAL_EXPERIMENT_ID, "?kind=bogus"), contextFor(REAL_EXPERIMENT_ID));
    expect(response.status).toBe(400);
    expect(listExperimentResults).not.toHaveBeenCalled();
  });

  it("rejects a malformed cursor with 400", async () => {
    const response = await GET(requestWithQuery(REAL_EXPERIMENT_ID, "?cursor=../etc"), contextFor(REAL_EXPERIMENT_ID));
    expect(response.status).toBe(400);
  });

  it("rejects an out-of-range limit with 400", async () => {
    const response = await GET(requestWithQuery(REAL_EXPERIMENT_ID, "?limit=0"), contextFor(REAL_EXPERIMENT_ID));
    expect(response.status).toBe(400);
  });

  it("a nonexistent experiment returns 404", async () => {
    listExperimentResults.mockResolvedValue({ status: "not_found" });
    const response = await GET(requestWithQuery(REAL_EXPERIMENT_ID), contextFor(REAL_EXPERIMENT_ID));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("an experiment belonging to another merchant ALSO returns 404 (identical body)", async () => {
    listExperimentResults.mockResolvedValue({ status: "not_found" });
    const response = await GET(requestWithQuery(OTHER_MERCHANT_EXPERIMENT_ID), contextFor(OTHER_MERCHANT_EXPERIMENT_ID));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("valid filters pass straight through to the query service", async () => {
    listExperimentResults.mockResolvedValue({ status: "found", items: [], nextCursor: null });
    await GET(requestWithQuery(REAL_EXPERIMENT_ID, "?kind=FINAL&limit=5"), contextFor(REAL_EXPERIMENT_ID));
    expect(listExperimentResults).toHaveBeenCalledWith("merchant_a", REAL_EXPERIMENT_ID, {
      kind: "FINAL",
      cursor: undefined,
      limit: 5,
    });
  });

  it("returns 200 with items/nextCursor on success", async () => {
    listExperimentResults.mockResolvedValue({ status: "found", items: [{ id: "r1" }], nextCursor: "r1" });
    const response = await GET(requestWithQuery(REAL_EXPERIMENT_ID), contextFor(REAL_EXPERIMENT_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [{ id: "r1" }], nextCursor: "r1" });
  });

  it("returns a sanitized 500 on an unexpected service failure", async () => {
    listExperimentResults.mockRejectedValue(new Error("connection refused at 10.0.0.5:5432"));
    const response = await GET(requestWithQuery(REAL_EXPERIMENT_ID), contextFor(REAL_EXPERIMENT_ID));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
  });

  it("500 if the operator has no resolvable merchant", async () => {
    resolveMerchantAccess.mockResolvedValue(null);
    const response = await GET(requestWithQuery(REAL_EXPERIMENT_ID), contextFor(REAL_EXPERIMENT_ID));
    expect(response.status).toBe(500);
  });
});
