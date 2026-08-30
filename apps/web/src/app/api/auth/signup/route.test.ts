import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signUpNewWorkspace = vi.fn();
const createOperatorSession = vi.fn();

vi.mock("@/lib/auth/signupService", () => ({ signUpNewWorkspace }));
// Same reasoning as login/route.test.ts: `normalizeEmail` must stay real
// because `signupRateLimit.ts` calls it to build the email rate-limit key.
vi.mock("@/lib/auth/authService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authService")>();
  return { ...actual, createOperatorSession };
});

const { POST } = await import("./route");
const { __resetSignupRateLimitersForTests, SIGNUP_RATE_LIMIT_POLICY } = await import("@/lib/auth/signupRateLimit");

function jsonRequest(body: unknown, extraHeaders: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function validSignup() {
  signUpNewWorkspace.mockResolvedValue({
    status: "created",
    operator: { id: "op_new", email: "new@example.com" },
    merchantId: "merchant_new",
  });
  createOperatorSession.mockResolvedValue({ token: "a-generated-token-value", expiresAt: new Date(Date.now() + 1000) });
}

describe("POST /api/auth/signup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSignupRateLimitersForTests();
  });

  it("returns 201 and sets a session cookie on a successful signup", async () => {
    validSignup();
    const response = await POST(jsonRequest({ email: "new@example.com", password: "a-real-password", workspaceName: "Acme" }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ operator: { id: "op_new", email: "new@example.com" } });
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("operator_session=a-generated-token-value");
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(createOperatorSession).toHaveBeenCalledWith("op_new");
  });

  it("returns 409 on a duplicate email without ever creating a session", async () => {
    signUpNewWorkspace.mockResolvedValue({ status: "email_already_exists" });
    const response = await POST(jsonRequest({ email: "taken@example.com", password: "a-real-password", workspaceName: "Acme" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "email_already_exists" });
    expect(createOperatorSession).not.toHaveBeenCalled();
  });

  it("returns 400 validation_error for a weak/invalid password", async () => {
    signUpNewWorkspace.mockResolvedValue({ status: "invalid_password" });
    const response = await POST(jsonRequest({ email: "ops@example.com", password: "short", workspaceName: "Acme" }));

    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe("invalid_password");
  });

  it("returns 400 validation_error for an invalid/empty workspace name", async () => {
    signUpNewWorkspace.mockResolvedValue({ status: "invalid_workspace_name" });
    const response = await POST(jsonRequest({ email: "ops@example.com", password: "a-real-password", workspaceName: "   " }));

    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe("invalid_workspace_name");
  });

  it("returns 400 for a malformed JSON body without ever calling signUpNewWorkspace", async () => {
    const response = await POST(jsonRequest("{not valid json"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "malformed_body" });
    expect(signUpNewWorkspace).not.toHaveBeenCalled();
  });

  it("returns 400 when email, password, or workspaceName is missing, and never consumes rate-limit budget for it", async () => {
    const missingWorkspace = await POST(jsonRequest({ email: "ops@example.com", password: "a-real-password" }));
    expect(missingWorkspace.status).toBe(400);
    expect(signUpNewWorkspace).not.toHaveBeenCalled();

    // confirm no budget was consumed: this same email can still succeed
    // up to the real limit afterward.
    validSignup();
    for (let i = 0; i < SIGNUP_RATE_LIMIT_POLICY.email.limit; i++) {
      const response = await POST(jsonRequest({ email: "ops@example.com", password: "a-real-password", workspaceName: "Acme" }));
      expect(response.status).not.toBe(429);
    }
  });

  it("ignores a client-supplied merchantId - there is no such field in the contract at all", async () => {
    validSignup();
    const response = await POST(
      jsonRequest({
        email: "attacker@example.com",
        password: "a-real-password",
        workspaceName: "Acme",
        merchantId: "someone-elses-real-merchant-id",
      })
    );

    expect(response.status).toBe(201);
    // signUpNewWorkspace is only ever called with (email, password,
    // workspaceName) - a 4th argument, even if present in the request
    // body, is never read or passed through.
    expect(signUpNewWorkspace).toHaveBeenCalledWith("attacker@example.com", "a-real-password", "Acme");
  });

  it("never leaks a database error or stack trace on an unexpected failure", async () => {
    signUpNewWorkspace.mockRejectedValue(new Error("connection refused at 10.0.0.5:5432 user=postgres"));
    const response = await POST(jsonRequest({ email: "ops@example.com", password: "a-real-password", workspaceName: "Acme" }));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
    expect(JSON.stringify(body)).not.toContain("postgres");
  });

  describe("rate limiting", () => {
    it("returns 429 once the signup email limit is exceeded", async () => {
      validSignup();
      for (let i = 0; i < SIGNUP_RATE_LIMIT_POLICY.email.limit; i++) {
        await POST(jsonRequest({ email: "repeat-target@example.com", password: "a-real-password", workspaceName: `Acme ${i}` }));
      }
      const oneTooMany = await POST(
        jsonRequest({ email: "repeat-target@example.com", password: "a-real-password", workspaceName: "Acme final" })
      );

      expect(oneTooMany.status).toBe(429);
      expect(await oneTooMany.json()).toEqual({ error: "rate_limited" });
      expect(signUpNewWorkspace).toHaveBeenCalledTimes(SIGNUP_RATE_LIMIT_POLICY.email.limit);
    });

    it("returns 429 once the signup IP limit is exceeded, even across many different emails", async () => {
      validSignup();
      const sameIp = { "x-forwarded-for": "203.0.113.9" };
      for (let i = 0; i < SIGNUP_RATE_LIMIT_POLICY.ip.limit; i++) {
        await POST(jsonRequest({ email: `distinct-${i}@example.com`, password: "a-real-password", workspaceName: `Acme ${i}` }, sameIp));
      }
      const oneTooMany = await POST(
        jsonRequest({ email: "yet-another@example.com", password: "a-real-password", workspaceName: "Acme" }, sameIp)
      );

      expect(oneTooMany.status).toBe(429);
    });

    it("a 429 rate-limit response reveals nothing about whether the account exists and includes correct headers", async () => {
      validSignup();
      for (let i = 0; i < SIGNUP_RATE_LIMIT_POLICY.email.limit; i++) {
        await POST(jsonRequest({ email: "headers-test@example.com", password: "a-real-password", workspaceName: `Acme ${i}` }));
      }
      const response = await POST(
        jsonRequest({ email: "headers-test@example.com", password: "a-real-password", workspaceName: "Acme" })
      );

      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: "rate_limited" });
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    });

    it("fails closed when the rate limiter itself throws, never falling through to workspace creation", async () => {
      const rateLimitModule = await import("@/lib/auth/signupRateLimit");
      const spy = vi.spyOn(rateLimitModule, "checkSignupRateLimit").mockImplementation(() => {
        throw new Error("simulated rate limiter failure");
      });

      const response = await POST(jsonRequest({ email: "ops@example.com", password: "a-real-password", workspaceName: "Acme" }));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal_error" });
      expect(signUpNewWorkspace).not.toHaveBeenCalled();

      spy.mockRestore();
    });

    it("never places the raw password into any rate-limit key material", async () => {
      validSignup();
      for (let i = 0; i < SIGNUP_RATE_LIMIT_POLICY.email.limit; i++) {
        await POST(
          jsonRequest({ email: "password-key-test@example.com", password: `totally-different-password-${i}`, workspaceName: `Acme ${i}` })
        );
      }
      const blocked = await POST(
        jsonRequest({ email: "password-key-test@example.com", password: "yet-another-one", workspaceName: "Acme" })
      );
      expect(blocked.status).toBe(429);
    });
  });
});
