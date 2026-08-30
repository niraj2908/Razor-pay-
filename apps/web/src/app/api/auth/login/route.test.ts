import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyOperatorCredentials = vi.fn();
const createOperatorSession = vi.fn();

// Only `verifyOperatorCredentials`/`createOperatorSession` are mocked here -
// `normalizeEmail` is spread in from the real module (via `importOriginal`)
// because `loginRateLimit.ts` (imported by the route as of the login
// rate-limiting step) calls the real `normalizeEmail` to build its email
// rate-limit key. A full mock replacement without this would leave
// `normalizeEmail` undefined on the mocked module and break every test.
vi.mock("@/lib/auth/authService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authService")>();
  return {
    ...actual,
    verifyOperatorCredentials,
    createOperatorSession,
  };
});

const { POST } = await import("./route");
const { __resetLoginRateLimitersForTests, LOGIN_RATE_LIMIT_POLICY } = await import("@/lib/auth/loginRateLimit");

function jsonRequest(body: unknown, extraHeaders: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function validCredentials() {
  verifyOperatorCredentials.mockResolvedValue({ status: "valid", operator: { id: "op_1", email: "ops@example.com" } });
  createOperatorSession.mockResolvedValue({ token: "a-generated-token-value", expiresAt: new Date(Date.now() + 1000) });
}

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every test starts with empty rate-limit counters - without this,
    // state from one test (or one describe block) would leak into the
    // next, since the limiters are module-level singletons by design (see
    // loginRateLimit.ts).
    __resetLoginRateLimitersForTests();
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

  describe("rate limiting", () => {
    it("allows normal login attempts below the threshold", async () => {
      validCredentials();
      for (let i = 0; i < LOGIN_RATE_LIMIT_POLICY.email.limit; i++) {
        const response = await POST(jsonRequest({ email: "ops@example.com", password: "correct-password" }));
        expect(response.status).toBe(200);
      }
    });

    it("returns 429 once the email limit is exceeded", async () => {
      verifyOperatorCredentials.mockResolvedValue({ status: "invalid_credentials" });

      for (let i = 0; i < LOGIN_RATE_LIMIT_POLICY.email.limit; i++) {
        await POST(jsonRequest({ email: "attacker-target@example.com", password: `guess-${i}` }));
      }
      const oneTooMany = await POST(jsonRequest({ email: "attacker-target@example.com", password: "guess-final" }));

      expect(oneTooMany.status).toBe(429);
      expect(await oneTooMany.json()).toEqual({ error: "rate_limited" });
    });

    it("returns 429 once the IP limit is exceeded, even across many different emails", async () => {
      verifyOperatorCredentials.mockResolvedValue({ status: "invalid_credentials" });
      const sameIpHeaders = { "x-forwarded-for": "203.0.113.7" };

      for (let i = 0; i < LOGIN_RATE_LIMIT_POLICY.ip.limit; i++) {
        await POST(jsonRequest({ email: `distinct-victim-${i}@example.com`, password: "guess" }, sameIpHeaders));
      }
      const oneTooMany = await POST(
        jsonRequest({ email: "yet-another-victim@example.com", password: "guess" }, sameIpHeaders)
      );

      expect(oneTooMany.status).toBe(429);
    });

    it("enforces the IP and email limits independently - exhausting one does not exhaust the other", async () => {
      verifyOperatorCredentials.mockResolvedValue({ status: "invalid_credentials" });
      const headersA = { "x-forwarded-for": "198.51.100.1" };

      // Exhaust the (tighter) email limit for one address from IP A.
      for (let i = 0; i < LOGIN_RATE_LIMIT_POLICY.email.limit; i++) {
        await POST(jsonRequest({ email: "one-account@example.com", password: "guess" }, headersA));
      }
      const emailBlocked = await POST(jsonRequest({ email: "one-account@example.com", password: "guess" }, headersA));
      expect(emailBlocked.status).toBe(429);

      // A *different* email from the same IP A is still allowed - the IP
      // budget has plenty of headroom left (limit is higher than email's).
      const differentEmailSameIp = await POST(
        jsonRequest({ email: "different-account@example.com", password: "guess" }, headersA)
      );
      expect(differentEmailSameIp.status).not.toBe(429);
    });

    it("changing the claimed email does not bypass the IP limit (anti password-spraying)", async () => {
      verifyOperatorCredentials.mockResolvedValue({ status: "invalid_credentials" });
      const attackerIp = { "x-forwarded-for": "192.0.2.55" };

      for (let i = 0; i < LOGIN_RATE_LIMIT_POLICY.ip.limit; i++) {
        const response = await POST(
          jsonRequest({ email: `probe-${i}@example.com`, password: "guess" }, attackerIp)
        );
        // every distinct email should still be allowed up to the IP ceiling
        expect(response.status).not.toBe(429);
      }
      const overIpLimit = await POST(jsonRequest({ email: "probe-final@example.com", password: "guess" }, attackerIp));
      expect(overIpLimit.status).toBe(429);
    });

    it("changing the X-Forwarded-For header does not bypass the email limit", async () => {
      verifyOperatorCredentials.mockResolvedValue({ status: "invalid_credentials" });

      for (let i = 0; i < LOGIN_RATE_LIMIT_POLICY.email.limit; i++) {
        // a different (spoofed) IP claimed on every single request
        await POST(jsonRequest({ email: "targeted-account@example.com", password: "guess" }, { "x-forwarded-for": `10.0.0.${i}` }));
      }
      const stillBlocked = await POST(
        jsonRequest({ email: "targeted-account@example.com", password: "guess" }, { "x-forwarded-for": "10.0.0.99" })
      );
      expect(stillBlocked.status).toBe(429);
    });

    it("treats differently-cased/whitespaced emails as the same rate-limit bucket, matching credential-lookup normalization", async () => {
      verifyOperatorCredentials.mockResolvedValue({ status: "invalid_credentials" });

      for (let i = 0; i < LOGIN_RATE_LIMIT_POLICY.email.limit; i++) {
        await POST(jsonRequest({ email: "  Same.Account@Example.com  ", password: "guess" }));
      }
      const blocked = await POST(jsonRequest({ email: "same.account@example.com", password: "guess" }));
      expect(blocked.status).toBe(429);
    });

    it("includes correct rate-limit headers on a 429, with a positive Retry-After", async () => {
      verifyOperatorCredentials.mockResolvedValue({ status: "invalid_credentials" });
      for (let i = 0; i < LOGIN_RATE_LIMIT_POLICY.email.limit; i++) {
        await POST(jsonRequest({ email: "headers-test@example.com", password: "guess" }));
      }
      const response = await POST(jsonRequest({ email: "headers-test@example.com", password: "guess" }));

      expect(response.status).toBe(429);
      expect(response.headers.get("X-RateLimit-Limit")).toBe(String(LOGIN_RATE_LIMIT_POLICY.email.limit));
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
      const retryAfter = Number(response.headers.get("Retry-After"));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(Math.ceil(LOGIN_RATE_LIMIT_POLICY.email.windowMs / 1000));
    });

    it("a 429 response body/headers reveal nothing about whether the account exists", async () => {
      // one target where verifyOperatorCredentials would (if called) say
      // "invalid" and one where it would say "valid" - the 429 shape must
      // be identical either way, and verifyOperatorCredentials must never
      // even be called once the limit is hit.
      verifyOperatorCredentials.mockResolvedValue({ status: "invalid_credentials" });
      for (let i = 0; i < LOGIN_RATE_LIMIT_POLICY.email.limit; i++) {
        await POST(jsonRequest({ email: "nonexistent@example.com", password: "guess" }));
      }
      const blockedNonexistent = await POST(jsonRequest({ email: "nonexistent@example.com", password: "guess" }));
      const nonexistentBody = await blockedNonexistent.json();

      validCredentials();
      for (let i = 0; i < LOGIN_RATE_LIMIT_POLICY.email.limit; i++) {
        await POST(jsonRequest({ email: "real-account@example.com", password: "wrong-guess" }));
      }
      // Cleared only now: the loop above makes exactly `limit` legitimate
      // attempts that SHOULD reach credential checking - only the next
      // (over-the-limit) call must be blocked before ever reaching it.
      verifyOperatorCredentials.mockClear();
      const blockedReal = await POST(jsonRequest({ email: "real-account@example.com", password: "wrong-guess" }));
      const realBody = await blockedReal.json();

      expect(blockedNonexistent.status).toBe(429);
      expect(blockedReal.status).toBe(429);
      expect(nonexistentBody).toEqual(realBody);
      // the one call this cleared mock could have recorded is exactly the
      // over-the-limit request - it must never reach credential checking.
      expect(verifyOperatorCredentials).not.toHaveBeenCalled();
    });

    it("malformed body and missing-field requests are rejected before rate limiting ever runs", async () => {
      const malformed = await POST(jsonRequest("{not valid json"));
      expect(malformed.status).toBe(400);

      const missingFields = await POST(jsonRequest({ email: "only-email@example.com" }));
      expect(missingFields.status).toBe(400);

      // neither of the above should have consumed any of this email's
      // rate-limit budget, since email/password were never even valid
      // enough to derive a key from.
      verifyOperatorCredentials.mockResolvedValue({ status: "invalid_credentials" });
      for (let i = 0; i < LOGIN_RATE_LIMIT_POLICY.email.limit; i++) {
        const response = await POST(jsonRequest({ email: "only-email@example.com", password: "guess" }));
        expect(response.status).not.toBe(429);
      }
    });

    it("fails closed (denies, never falls through to authentication) when the rate limiter itself throws", async () => {
      const rateLimitModule = await import("@/lib/auth/loginRateLimit");
      const spy = vi.spyOn(rateLimitModule, "checkLoginRateLimit").mockImplementation(() => {
        throw new Error("simulated rate limiter failure");
      });

      const response = await POST(jsonRequest({ email: "ops@example.com", password: "correct-password" }));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal_error" });
      expect(verifyOperatorCredentials).not.toHaveBeenCalled();

      spy.mockRestore();
    });

    it("never places the raw password into any rate-limit key material", async () => {
      // The only inputs to key derivation are IP and normalized email
      // (see loginRateLimit.ts) - this exercises the real path with a
      // distinctive password value and confirms two requests with the
      // SAME email but DIFFERENT passwords still share one counter
      // (proving the password plays no part in the key), which is the
      // observable behavior that would differ if the password ever leaked
      // into the key.
      verifyOperatorCredentials.mockResolvedValue({ status: "invalid_credentials" });
      for (let i = 0; i < LOGIN_RATE_LIMIT_POLICY.email.limit; i++) {
        await POST(jsonRequest({ email: "password-key-test@example.com", password: `totally-different-password-${i}` }));
      }
      const blocked = await POST(
        jsonRequest({ email: "password-key-test@example.com", password: "yet-another-completely-different-one" })
      );
      expect(blocked.status).toBe(429);
    });

    it("does not affect session behavior after a successful authentication", async () => {
      validCredentials();
      const response = await POST(jsonRequest({ email: "ops@example.com", password: "correct-password" }));

      expect(response.status).toBe(200);
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("operator_session=a-generated-token-value");
      expect(setCookie.toLowerCase()).toContain("httponly");
      expect(createOperatorSession).toHaveBeenCalledWith("op_1");
    });
  });
});
