import { describe, expect, it } from "vitest";
import { hashPassword, isPasswordLongEnough, MINIMUM_PASSWORD_LENGTH, verifyPassword } from "./password";

describe("password hashing", () => {
  it("hashes and verifies a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("produces a different hash for the same password on each call (random salt)", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password", a)).toBe(true);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  it("encodes the hash in the self-describing scrypt:N:r:p:salt:hash format", async () => {
    const hash = await hashPassword("some password");
    expect(hash).toMatch(/^scrypt:\d+:\d+:\d+:[0-9a-f]+:[0-9a-f]+$/);
  });

  it("never throws on a malformed stored hash - treats it as a failed verification", async () => {
    await expect(verifyPassword("anything", "not-a-real-hash")).resolves.toBe(false);
    await expect(verifyPassword("anything", "")).resolves.toBe(false);
    await expect(verifyPassword("anything", "scrypt:not:numbers:here:zz:zz")).resolves.toBe(false);
  });

  it("case-sensitively distinguishes passwords", async () => {
    const hash = await hashPassword("Password123");
    expect(await verifyPassword("password123", hash)).toBe(false);
  });

  describe("isPasswordLongEnough", () => {
    it(`rejects passwords shorter than ${MINIMUM_PASSWORD_LENGTH} characters`, () => {
      expect(isPasswordLongEnough("short")).toBe(false);
      expect(isPasswordLongEnough("")).toBe(false);
    });

    it(`accepts passwords at least ${MINIMUM_PASSWORD_LENGTH} characters`, () => {
      expect(isPasswordLongEnough("a".repeat(MINIMUM_PASSWORD_LENGTH))).toBe(true);
      expect(isPasswordLongEnough("a".repeat(MINIMUM_PASSWORD_LENGTH + 5))).toBe(true);
    });
  });
});
