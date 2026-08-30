import { describe, expect, it } from "vitest";
import { hashRateLimitKey } from "./rateLimitKey";

describe("hashRateLimitKey", () => {
  it("hashes deterministically - the same input always hashes the same", () => {
    expect(hashRateLimitKey("someone@example.com")).toBe(hashRateLimitKey("someone@example.com"));
  });

  it("hashes two different inputs to two different hashes", () => {
    expect(hashRateLimitKey("someone@example.com")).not.toBe(hashRateLimitKey("someone-else@example.com"));
  });

  it("produces a hex-encoded SHA-256 digest (64 hex characters)", () => {
    expect(hashRateLimitKey("someone@example.com")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never contains the raw input in its output", () => {
    const raw = "someone@example.com";
    expect(hashRateLimitKey(raw)).not.toContain(raw);
  });
});
