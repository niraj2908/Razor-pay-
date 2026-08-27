import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyOperatorCredentials = vi.fn();
const createOperatorSession = vi.fn();

vi.mock("@/lib/auth/authService", () => ({
  verifyOperatorCredentials,
  createOperatorSession,
}));

const { POST } = await import("./route");

function jsonRequest(body: unknown) {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 and sets a session cookie on valid credentials", async () => {
    verifyOperatorCredentials.mockResolvedValue({ status: "valid", operator: { id: "op_1", email: "ops@example.com" } });
    createOperatorSession.mockResolvedValue({ token: "a-generated-token-value", expiresAt: new Date(Date.now() + 1000) });

    const response = await POST(jsonRequest({ email: "ops@example.com", password: "correct-password" }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ operator: { id: "op_1", email: "ops@example.com" } });

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("operator_session=a-generated-token-value");
    expect(setCookie.toLowerCase()).toContain("httponly");
  });

  it("returns 401 and never creates a session on invalid credentials", async () => {
    verifyOperatorCredentials.mockResolvedValue({ status: "invalid_credentials" });

    const response = await POST(jsonRequest({ email: "ops@example.com", password: "wrong" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_credentials" });
    expect(createOperatorSession).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed JSON body without ever calling verifyOperatorCredentials", async () => {
    const response = await POST(jsonRequest("{not valid json"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "malformed_body" });
    expect(verifyOperatorCredentials).not.toHaveBeenCalled();
  });

  it("returns 400 validation_error when email or password is missing", async () => {
    const missingPassword = await POST(jsonRequest({ email: "ops@example.com" }));
    expect(missingPassword.status).toBe(400);
    expect((await missingPassword.json()).error).toBe("validation_error");

    const missingEmail = await POST(jsonRequest({ password: "something" }));
    expect(missingEmail.status).toBe(400);

    const wrongTypes = await POST(jsonRequest({ email: 123, password: true }));
    expect(wrongTypes.status).toBe(400);

    expect(verifyOperatorCredentials).not.toHaveBeenCalled();
  });

  it("never leaks a database error or stack trace on an unexpected failure", async () => {
    verifyOperatorCredentials.mockRejectedValue(new Error("connection refused at 10.0.0.5:5432 user=postgres"));

    const response = await POST(jsonRequest({ email: "ops@example.com", password: "correct-password" }));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
    expect(JSON.stringify(body)).not.toContain("postgres");
  });
});
