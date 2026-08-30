import { describe, expect, it } from "vitest";
import { rateLimitHeaders } from "./rateLimitHttp";
import type { RateLimitResult } from "./rateLimiter";

describe("rateLimitHeaders", () => {
  it("includes limit/remaining/reset for an allowed result, with no Retry-After", () => {
    const result: RateLimitResult = { allowed: true, limit: 5, remaining: 3, resetAt: new Date(60_000) };
    const headers = rateLimitHeaders(result);
    expect(headers["X-RateLimit-Limit"]).toBe("5");
    expect(headers["X-RateLimit-Remaining"]).toBe("3");
    expect(headers["X-RateLimit-Reset"]).toBe("60");
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("includes Retry-After for a denied result", () => {
    const result: RateLimitResult = {
      allowed: false,
      limit: 5,
      remaining: 0,
      resetAt: new Date(60_000),
      retryAfterSeconds: 42,
    };
    const headers = rateLimitHeaders(result);
    expect(headers["Retry-After"]).toBe("42");
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
  });
});
