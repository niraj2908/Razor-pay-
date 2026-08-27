import { afterEach, describe, expect, it, vi } from "vitest";
import { clearedSessionCookieOptions, sessionCookieOptions } from "./sessionCookie";

describe("session cookie security flags", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is always httpOnly, sameSite=lax, path=/ regardless of environment", () => {
    const options = sessionCookieOptions(new Date());
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
  });

  it("sets secure=true in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookieOptions(new Date()).secure).toBe(true);
  });

  it("sets secure=false outside production (so local http://localhost dev works)", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(sessionCookieOptions(new Date()).secure).toBe(false);
  });

  it("carries the session's real expiry as the cookie's own expiry", () => {
    const expiresAt = new Date(Date.now() + 60_000);
    expect(sessionCookieOptions(expiresAt).expires).toBe(expiresAt);
  });

  describe("clearedSessionCookieOptions", () => {
    it("expires immediately (maxAge=0) while preserving the same security flags", () => {
      vi.stubEnv("NODE_ENV", "production");
      const options = clearedSessionCookieOptions();
      expect(options.maxAge).toBe(0);
      expect(options.httpOnly).toBe(true);
      expect(options.secure).toBe(true);
      expect(options.sameSite).toBe("lax");
    });
  });
});
