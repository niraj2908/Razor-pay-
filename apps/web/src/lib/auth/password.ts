import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Operator password hashing (Phase 25 Step 2A).
 *
 * Uses Node's built-in `crypto.scrypt` rather than adding bcrypt/argon2 as a
 * dependency - scrypt is an OWASP-acceptable KDF, is already present in
 * every Node runtime (no native-module compilation step, which matters for
 * serverless/Vercel deployment), and needs zero new dependencies for
 * something this security-sensitive to keep fully inspectable in this
 * codebase rather than trusting a third-party package's internals.
 *
 * Parameters follow Node's own documented password-hashing example
 * (N=16384, r=8, p=1, 64-byte derived key) - not invented values.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** Self-describing format ("scrypt:N:r:p:saltHex:hashHex") so the cost
 * parameters can be upgraded later without breaking verification of
 * passwords hashed under the old parameters - never a bare hash string. */
function encode(saltHex: string, hashHex: string): string {
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${saltHex}:${hashHex}`;
}

function decode(stored: string): { n: number; r: number; p: number; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return null;
  return { n, r, p, salt: Buffer.from(saltHex, "hex"), hash: Buffer.from(hashHex, "hex") };
}

/** Minimum length floor only - not a full password-strength policy engine,
 * which is out of scope for this step (see final report). */
export const MINIMUM_PASSWORD_LENGTH = 8;

export function isPasswordLongEnough(password: string): boolean {
  return typeof password === "string" && password.length >= MINIMUM_PASSWORD_LENGTH;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return encode(salt.toString("hex"), derived.toString("hex"));
}

/**
 * Verifies a plaintext password against a stored hash. Uses
 * `timingSafeEqual` (not `===`/`Buffer.compare`) specifically to avoid a
 * timing side-channel on the comparison itself - the scrypt computation
 * time already dominates and is deliberately unavoidable/equal for every
 * attempt regardless of correctness.
 *
 * Never throws on a malformed stored value (e.g. from a corrupted or
 * hand-edited row) - returns false, the same as "wrong password", so a
 * caller can never distinguish "this account is broken" from "wrong
 * credentials" through an exception.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const decoded = decode(stored);
  if (!decoded) return false;
  const { n, r, p, salt, hash } = decoded;
  const derived = scryptSync(password, salt, hash.length, { N: n, r, p });
  if (derived.length !== hash.length) return false;
  return timingSafeEqual(derived, hash);
}
