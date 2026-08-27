import { createHash, randomBytes } from "node:crypto";

/**
 * Session token generation/hashing (Phase 25 Step 2A). Pure, DB-independent.
 *
 * The raw token is high-entropy (256 bits) random data - unlike a password,
 * it is never memorized or reused by a human, so it needs no per-token salt
 * or slow KDF; a single fast SHA-256 hash is the correct, standard tool for
 * "let me look this exact opaque credential up in a database" (the same
 * class of problem as PaymentEvent.razorpayEventId's uniqueness, just
 * hashed before storage so a raw stolen database row can never itself be
 * replayed as a valid session credential).
 */
const TOKEN_BYTES = 32; // 256 bits

export const SESSION_COOKIE_NAME = "operator_session";

/** 12 hours - a deliberately conservative default for an operator tool
 * handling financial recovery data; see the final report's session-model
 * section for the reasoning and for what is NOT implemented (sliding
 * renewal, rotation-on-privilege-change). */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A generated token is always 43 base64url characters (32 bytes). Used to
 * reject obviously-malformed cookie values before ever touching the
 * database - never itself a security boundary (the hash lookup is), just a
 * cheap early rejection of garbage input. */
export function isPlausibleSessionToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,50}$/.test(value);
}
