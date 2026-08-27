import { describe, expect, it } from "vitest";
import { generateSessionToken, hashSessionToken, isPlausibleSessionToken, SESSION_TTL_MS } from "./sessionToken";

describe("session tokens", () => {
  it("generates a base64url token of the expected length", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,50}$/);
  });

  it("generates a different token on each call", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
  });

  it("hashes deterministically - the same token always hashes the same", () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it("hashes two different tokens to two different hashes", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(hashSessionToken(a)).not.toBe(hashSessionToken(b));
  });

  it("produces a hex-encoded SHA-256 digest (64 hex characters)", () => {
    const hash = hashSessionToken(generateSessionToken());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  describe("isPlausibleSessionToken", () => {
    it("accepts a real generated token", () => {
      expect(isPlausibleSessionToken(generateSessionToken())).toBe(true);
    });

    it("rejects missing, non-string, and malformed values without throwing", () => {
      expect(isPlausibleSessionToken(undefined)).toBe(false);
      expect(isPlausibleSessionToken(null)).toBe(false);
      expect(isPlausibleSessionToken(123)).toBe(false);
      expect(isPlausibleSessionToken("")).toBe(false);
      expect(isPlausibleSessionToken("short")).toBe(false);
      expect(isPlausibleSessionToken("has spaces in it which is not valid base64url")).toBe(false);
      expect(isPlausibleSessionToken("<script>alert(1)</script>")).toBe(false);
    });
  });

  it("SESSION_TTL_MS is a sane positive duration (documented as 12 hours)", () => {
    expect(SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });
});
