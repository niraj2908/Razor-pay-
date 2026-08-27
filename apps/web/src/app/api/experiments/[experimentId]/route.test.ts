import { describe, expect, it, vi, beforeEach } from "vitest";

const authenticateOperator = vi.fn();
const resolveMerchantAccess = vi.fn();
const getExperimentDetail = vi.fn();

vi.mock("@/lib/auth/authenticateOperator", () => ({ authenticateOperator }));
vi.mock("@/lib/auth/merchantAccess", () => ({ resolveMerchantAccess }));
vi.mock("@/lib/experiments/measurement/experimentQueryService", async () => {
  const actual = await vi.importActual<typeof import("@/lib/experiments/measurement/experimentQueryService")>(
    "@/lib/experiments/measurement/experimentQueryService"
  );
  return { ...actual, getExperimentDetail };
});

const { GET } = await import("./route");

function contextFor(experimentId: string) {
  return { params: Promise.resolve({ experimentId }) };
}

// cuid()-shaped fixture ids, matching isPlausibleId's real-id shape.
const REAL_EXPERIMENT_ID = "clexperiment0001abc";
const NONEXISTENT_EXPERIMENT_ID = "clexperimentdoesnotexist";
const OTHER_MERCHANT_EXPERIMENT_ID = "clexperimentownedbymerchantb";

const DUMMY_REQUEST = new Request(`http://localhost/api/experiments/${REAL_EXPERIMENT_ID}`);

describe("GET /api/experiments/[experimentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateOperator.mockResolvedValue({ operator: { id: "op_1", email: "ops@example.com" }, sessionId: "session_1" });
    resolveMerchantAccess.mockResolvedValue({ merchantId: "merchant_a" });
  });

  it("unauthenticated request is rejected with 401, never reaching the query service", async () => {
    authenticateOperator.mockResolvedValue(null);
    const response = await GET(DUMMY_REQUEST, contextFor(REAL_EXPERIMENT_ID));
    expect(response.status).toBe(401);
    expect(getExperimentDetail).not.toHaveBeenCalled();
  });

  it("passes the operator's OWN resolved merchantId to the query service", async () => {
    getExperimentDetail.mockResolvedValue({ status: "not_found" });
    await GET(DUMMY_REQUEST, contextFor(REAL_EXPERIMENT_ID));
    expect(getExperimentDetail).toHaveBeenCalledWith("merchant_a", REAL_EXPERIMENT_ID);
  });

  it("rejects a malformed experiment id with 400 before ever querying", async () => {
    const response = await GET(DUMMY_REQUEST, contextFor("../../etc/passwd"));
    expect(response.status).toBe(400);
    expect(getExperimentDetail).not.toHaveBeenCalled();
  });

  it("a nonexistent experiment returns 404", async () => {
    getExperimentDetail.mockResolvedValue({ status: "not_found" });
    const response = await GET(DUMMY_REQUEST, contextFor(NONEXISTENT_EXPERIMENT_ID));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("an experiment belonging to another merchant ALSO returns 404 (identical body) - never distinguishable from not-found", async () => {
    getExperimentDetail.mockResolvedValue({ status: "not_found" });
    const response = await GET(DUMMY_REQUEST, contextFor(OTHER_MERCHANT_EXPERIMENT_ID));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("a valid, accessible experiment returns 200 with its detail", async () => {
    const dto = { id: REAL_EXPERIMENT_ID, name: "Retry copy test", latestResult: null };
    getExperimentDetail.mockResolvedValue({ status: "found", experiment: dto });
    const response = await GET(DUMMY_REQUEST, contextFor(REAL_EXPERIMENT_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(dto);
  });

  it("returns a sanitized 500 on an unexpected service failure", async () => {
    getExperimentDetail.mockRejectedValue(new Error("connection refused at 10.0.0.5:5432"));
    const response = await GET(DUMMY_REQUEST, contextFor(REAL_EXPERIMENT_ID));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
  });

  it("500 if the operator has no resolvable merchant", async () => {
    resolveMerchantAccess.mockResolvedValue(null);
    const response = await GET(DUMMY_REQUEST, contextFor(REAL_EXPERIMENT_ID));
    expect(response.status).toBe(500);
  });
});
