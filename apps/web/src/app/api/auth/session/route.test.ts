import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateOperator = vi.fn();
const resolveMerchantAccess = vi.fn();

vi.mock("@/lib/auth/authenticateOperator", () => ({ authenticateOperator }));
vi.mock("@/lib/auth/merchantAccess", () => ({ resolveMerchantAccess }));

const { GET } = await import("./route");

describe("GET /api/auth/session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the authenticated operator identity and their merchantId for a valid session", async () => {
    authenticateOperator.mockResolvedValue({ operator: { id: "op_1", email: "ops@example.com" }, sessionId: "session_1" });
    resolveMerchantAccess.mockResolvedValue({ merchantId: "merchant_1" });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ operator: { id: "op_1", email: "ops@example.com" }, merchantId: "merchant_1" });
    expect(resolveMerchantAccess).toHaveBeenCalledWith("op_1");
  });

  it("returns 401 unauthenticated when there is no valid session, never calling resolveMerchantAccess", async () => {
    authenticateOperator.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(resolveMerchantAccess).not.toHaveBeenCalled();
  });

  it("never returns sessionId or any field beyond operator identity and merchantId", async () => {
    authenticateOperator.mockResolvedValue({ operator: { id: "op_1", email: "ops@example.com" }, sessionId: "session_1" });
    resolveMerchantAccess.mockResolvedValue({ merchantId: "merchant_1" });

    const response = await GET();
    const body = await response.json();

    expect(Object.keys(body).sort()).toEqual(["merchantId", "operator"]);
    expect(JSON.stringify(body)).not.toContain("session_1");
  });

  it("returns a sanitized 500 (never an internal detail) if an authenticated operator has no resolvable merchant", async () => {
    authenticateOperator.mockResolvedValue({ operator: { id: "op_1", email: "ops@example.com" }, sessionId: "session_1" });
    resolveMerchantAccess.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });
});
