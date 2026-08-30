import { createHash } from "node:crypto";

/**
 * Optional key-hardening helper (Phase 26, Public Onboarding Step 2).
 *
 * A rate-limit key derived from a real identifier (an email address, an
 * IP address, or a combination) is sensitive by nature - it lets whoever
 * can read the store's key space see which real-world identifiers made
 * requests. This primitive's in-memory store never persists past a
 * process restart and is never logged or exposed by this module (see
 * final report §G), so hashing is not required for the store to function
 * correctly - it is offered so a future caller can avoid holding a raw
 * email/IP as a literal `Map` key at all, the same "hash before use,
 * never persist the raw value" discipline this codebase already applies
 * to session tokens (`auth/sessionToken.ts`'s `hashSessionToken`, the
 * exact pattern mirrored here).
 *
 * A single fast SHA-256 hash is the correct tool here for the same reason
 * it is for session tokens: this is "look up an opaque bucket," not "slow
 * down an attacker guessing a human-memorized secret" - the latter is what
 * a salted, slow KDF (scrypt, `auth/password.ts`) is for. A rate-limit key
 * is not a password: it needs collision resistance, not brute-force
 * resistance, so no per-key salt is used or needed - two callers hashing
 * the same normalized identifier should land in the same bucket.
 */
export function hashRateLimitKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}
