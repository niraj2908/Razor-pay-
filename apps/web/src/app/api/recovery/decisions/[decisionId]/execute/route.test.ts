import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateOperator = vi.fn();
const resolveMerchantAccess = vi.fn();
const executeDecision = vi.fn();

vi.mock("@/lib/auth/authenticateOperator", () => ({ authenticateOperator }));
vi.mock("@/lib/auth/merchantAccess", () => ({ resolveMerchantAccess }));
vi.mock("@/lib/recovery/decisionExecutionService", () => ({ executeDecision }));

const { POST } = await import("./route");

function call(decisionId = "decision1") {
  return POST(new Request("http://localhost/api/recovery/decisions/decision1/execute", { method: "POST" }), {
    params: Promise.resolve({ decisionId }),
  });
}

describe("POST /api/recovery/decisions/[decisionId]/execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateOperator.mockResolvedValue({ operator: { id: "op_1", email: "ops@example.com" }, sessionId: "s_1" });
    resolveMerchantAccess.mockResolvedValue({ merchantId: "merchant_a" });
  });

  it("rejects an unauthenticated request with 401 without ever reaching the service", async () => {
    authenticateOperator.mockResolvedValue(null);

    const response = await call();

    expect(response.status).toBe(401);
    expect(executeDecision).not.toHaveBeenCalled();
  });

  it("derives the merchant from the session only - the caller cannot name one", async () => {
    executeDecision.mockResolvedValue({ status: "not_found" });

    await call();

    expect(executeDecision).toHaveBeenCalledWith("merchant_a", "decision1");
  });

  it("returns 404 for a decision that does not exist or belongs to another merchant", async () => {
    executeDecision.mockResolvedValue({ status: "not_found" });

    const response = await call();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("returns 200 with the Razorpay reference when the execution succeeds", async () => {
    executeDecision.mockResolvedValue({
      status: "executed",
      result: { status: "succeeded", executionId: "exec_1", razorpayReferenceId: "plink_123" },
    });

    const response = await call();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "succeeded",
      executionId: "exec_1",
      razorpayReferenceId: "plink_123",
    });
  });

  it("reports a replayed execution as 200 'existing', never as a second success", async () => {
    executeDecision.mockResolvedValue({
      status: "executed",
      result: { status: "existing", executionId: "exec_1", executionStatus: "SUCCEEDED" },
    });

    const response = await call();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "existing" });
  });

  it("returns 202 for an ambiguous result, so a client cannot read it as failure", async () => {
    executeDecision.mockResolvedValue({
      status: "executed",
      result: { status: "ambiguous", executionId: "exec_1", errorCategory: "timeout" },
    });

    const response = await call();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ status: "ambiguous" });
  });

  it("returns 502 when Razorpay definitively failed the action", async () => {
    executeDecision.mockResolvedValue({
      status: "executed",
      result: { status: "failed", executionId: "exec_1", errorCategory: "razorpay_rejected" },
    });

    const response = await call();

    expect(response.status).toBe(502);
  });

  it.each([
    ["decision_not_act"],
    ["no_chosen_action"],
    ["payment_missing"],
  ])("returns 409 with the reason when the decision is refused (%s)", async (reason) => {
    executeDecision.mockResolvedValue({ status: "refused", reason });

    const response = await call();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "not_executable", reason });
  });

  it.each([
    ["decision_stale"],
    ["control_arm_forbidden"],
    ["unsupported_strategy"],
  ])("surfaces an Execution Service rejection as 409 with its reason (%s)", async (reason) => {
    executeDecision.mockResolvedValue({ status: "executed", result: { status: "rejected", reason } });

    const response = await call();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "not_executable", reason });
  });

  it("rejects an implausible decision id before touching the service", async () => {
    const response = await call("../../etc/passwd");

    expect(response.status).toBe(400);
    expect(executeDecision).not.toHaveBeenCalled();
  });

  it("returns a sanitized 500 - never a stack trace - on an unexpected failure", async () => {
    executeDecision.mockRejectedValue(new Error("connection refused at 10.0.0.5:5432"));

    const response = await call();

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
  });
});
