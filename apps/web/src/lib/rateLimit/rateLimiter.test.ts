import { describe, expect, it, vi } from "vitest";
import { RateLimiter, type RateLimitStore, type WindowCounter } from "./rateLimiter";
import { InMemoryRateLimitStore } from "./inMemoryRateLimitStore";

function limiter(limit: number, windowMs: number, store: RateLimitStore = new InMemoryRateLimitStore()) {
  return new RateLimiter({ limit, windowMs }, store);
}

describe("RateLimiter - fixed window", () => {
  it("allows the first request for a key", () => {
    const result = limiter(3, 1000).check("key-a", 0);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("keeps allowing requests below the threshold", () => {
    const rl = limiter(3, 1000);
    expect(rl.check("key-a", 0).allowed).toBe(true);
    expect(rl.check("key-a", 10).allowed).toBe(true);
    const third = rl.check("key-a", 20);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
  });

  it("denies exactly the request that crosses the threshold", () => {
    const rl = limiter(3, 1000);
    rl.check("key-a", 0);
    rl.check("key-a", 10);
    rl.check("key-a", 20);
    const fourth = rl.check("key-a", 30);
    expect(fourth.allowed).toBe(false);
  });

  it("continues denying further requests once over the threshold", () => {
    const rl = limiter(2, 1000);
    rl.check("key-a", 0);
    rl.check("key-a", 10);
    expect(rl.check("key-a", 20).allowed).toBe(false);
    expect(rl.check("key-a", 30).allowed).toBe(false);
    expect(rl.check("key-a", 40).allowed).toBe(false);
  });

  it("reports a correct resetAt and retryAfterSeconds for a denied request", () => {
    const rl = limiter(1, 5000);
    rl.check("key-a", 1_000);
    const denied = rl.check("key-a", 2_000);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      // window started at 1_000, so it ends at 6_000; "now" is 2_000
      expect(denied.resetAt.getTime()).toBe(6_000);
      expect(denied.retryAfterSeconds).toBe(4);
    }
  });

  it("resets once a new window begins", () => {
    const rl = limiter(1, 1000);
    expect(rl.check("key-a", 0).allowed).toBe(true);
    expect(rl.check("key-a", 500).allowed).toBe(false);
    // exactly at the window boundary - a fresh window
    expect(rl.check("key-a", 1000).allowed).toBe(true);
  });

  it("isolates distinct keys from each other", () => {
    const rl = limiter(1, 1000);
    expect(rl.check("key-a", 0).allowed).toBe(true);
    expect(rl.check("key-a", 10).allowed).toBe(false);
    // a different key has its own independent counter
    expect(rl.check("key-b", 10).allowed).toBe(true);
  });

  it("rejects an empty key safely, never granting it its own unlimited bucket", () => {
    const rl = limiter(5, 1000);
    const result = rl.check("", 0);
    expect(result.allowed).toBe(false);
  });

  it("rejects a non-string key safely without throwing", () => {
    const rl = limiter(5, 1000);
    // @ts-expect-error - deliberately testing a malformed caller
    expect(() => rl.check(undefined, 0)).not.toThrow();
    // @ts-expect-error - deliberately testing a malformed caller
    expect(rl.check(undefined, 0).allowed).toBe(false);
  });

  it("fails closed (denies) when the underlying store throws", () => {
    const throwingStore: RateLimitStore = {
      incrementAndGet(): WindowCounter {
        throw new Error("simulated storage failure");
      },
    };
    const rl = limiter(5, 1000, throwingStore);
    const result = rl.check("key-a", 0);
    expect(result.allowed).toBe(false);
  });

  it("never logs anything to the console, including on a storage failure", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const throwingStore: RateLimitStore = {
      incrementAndGet(): WindowCounter {
        throw new Error("simulated storage failure containing a sensitive-looking key");
      },
    };
    const rl = limiter(1, 1000, throwingStore);
    rl.check("someone@example.com", 0);
    rl.check("key-a", 0);

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("never includes the raw key in a result object", () => {
    const rl = limiter(1, 1000);
    const result = rl.check("someone@example.com", 0);
    expect(JSON.stringify(result)).not.toContain("someone@example.com");
  });
});
