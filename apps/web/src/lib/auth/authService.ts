import { prisma } from "@/lib/db";
import { hashPassword, isPasswordLongEnough, verifyPassword } from "./password";
import { generateSessionToken, hashSessionToken, isPlausibleSessionToken, SESSION_TTL_MS } from "./sessionToken";

/**
 * The Operator Authentication Service (Phase 25 Step 2A) plus the
 * `createOperator` provisioning of a Phase 25 Step 2B, single-merchant
 * operator.
 *
 * Authentication here still answers ONLY "who is the authenticated
 * application operator" - `resolveOperatorSession`/`authenticateOperator`
 * deliberately return nothing beyond an operator's own identity (id,
 * email), never a merchantId. Merchant authorization is a SEPARATE,
 * explicit call to `resolveMerchantAccess`/`authorizeMerchantAccess` in
 * `merchantAccess.ts` - kept apart on purpose (Phase 25 Step 2B Section 7:
 * "do not combine both into an untestable helper") so a future
 * multi-merchant model change never has to touch this file's return types.
 *
 * No public self-registration exists anywhere in this codebase by design:
 * an open "create my own operator account" endpoint on a fintech recovery
 * dashboard would let any anonymous caller grant themselves access to
 * recovery/decision data. `createOperator` exists only as an internal
 * function for out-of-band provisioning (see the final report's
 * documented limitation) - it now requires the merchantId the new
 * operator belongs to, per Step 2B's single-merchant-operator decision.
 */

export type OperatorIdentity = { id: string; email: string };

export type CreateOperatorResult =
  | { status: "created"; operator: OperatorIdentity }
  | { status: "invalid_password" }
  | { status: "email_already_exists" }
  | { status: "merchant_not_found" };

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";
const PRISMA_FOREIGN_KEY_CONSTRAINT_VIOLATION = "P2003";

function prismaErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/** Exported (Phase 26, login rate-limiting step) so a caller deriving a
 * rate-limit key from an email uses the exact same normalization as
 * credential lookup itself - a mismatch would let "Foo@Example.com" and
 * "foo@example.com" land in two different rate-limit buckets for what is
 * the same account. Behavior of this function is unchanged. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Out-of-band provisioning only - never called from an HTTP route in this
 * step. Rejects a too-short password before ever hashing it; relies on the
 * database's own constraints - unique email (P2002) and the
 * Operator.merchantId foreign key (P2003) - rather than a check-then-insert
 * race for either the duplicate-email or the nonexistent-merchant case. */
export async function createOperator(email: string, password: string, merchantId: string): Promise<CreateOperatorResult> {
  if (!isPasswordLongEnough(password)) {
    return { status: "invalid_password" };
  }
  const passwordHash = await hashPassword(password);
  try {
    const operator = await prisma.operator.create({
      data: { email: normalizeEmail(email), passwordHash, merchantId },
    });
    return { status: "created", operator: { id: operator.id, email: operator.email } };
  } catch (error) {
    const code = prismaErrorCode(error);
    if (code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION) {
      return { status: "email_already_exists" };
    }
    if (code === PRISMA_FOREIGN_KEY_CONSTRAINT_VIOLATION) {
      return { status: "merchant_not_found" };
    }
    throw error;
  }
}

export type VerifyCredentialsResult =
  | { status: "valid"; operator: OperatorIdentity }
  | { status: "invalid_credentials" };

/**
 * Verifies email+password against the stored hash. Returns the SAME
 * `invalid_credentials` result whether the email doesn't exist or the
 * password is wrong - never lets a caller distinguish "no such operator"
 * from "wrong password" (that distinction is exactly what an account/email
 * enumeration attack would exploit).
 *
 * When no operator row exists for the email, a hash is still computed
 * against a fixed dummy value before returning - this keeps the response
 * time close to the real-operator path, so an attacker cannot use timing
 * alone to learn which emails have accounts.
 */
const DUMMY_HASH_FOR_TIMING_PARITY =
  "scrypt:16384:8:1:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

export async function verifyOperatorCredentials(email: string, password: string): Promise<VerifyCredentialsResult> {
  const operator = await prisma.operator.findUnique({ where: { email: normalizeEmail(email) } });
  const passwordHash = operator?.passwordHash ?? DUMMY_HASH_FOR_TIMING_PARITY;
  const valid = await verifyPassword(password, passwordHash);
  if (!operator || !valid) {
    return { status: "invalid_credentials" };
  }
  return { status: "valid", operator: { id: operator.id, email: operator.email } };
}

export type CreatedSession = { token: string; expiresAt: Date };

/** Creates a new DB-backed session row and returns the RAW token (to be set
 * as an HttpOnly cookie by the caller) - the raw token is never itself
 * persisted, only its SHA-256 hash (see sessionToken.ts). */
export async function createOperatorSession(operatorId: string): Promise<CreatedSession> {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.operatorSession.create({
    data: { operatorId, tokenHash, expiresAt },
  });
  return { token, expiresAt };
}

export type ResolvedSession = { operator: OperatorIdentity; sessionId: string };

/**
 * Resolves a raw session token (as read from the cookie) into an
 * authenticated operator identity, or null if the token is missing,
 * malformed, unknown, expired, or revoked. Never throws for any of these
 * ordinary "not authenticated" cases - only a genuine database failure
 * propagates.
 */
export async function resolveOperatorSession(token: unknown): Promise<ResolvedSession | null> {
  if (!isPlausibleSessionToken(token)) {
    return null;
  }
  const tokenHash = hashSessionToken(token);
  const session = await prisma.operatorSession.findUnique({
    where: { tokenHash },
    include: { operator: true },
  });
  if (!session) return null;
  if (session.revokedAt !== null) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  return { operator: { id: session.operator.id, email: session.operator.email }, sessionId: session.id };
}

/** Logout: marks the session revoked (never deleted, so its history stays
 * inspectable - see schema.prisma). Idempotent - revoking an already-
 * unknown or already-revoked token is not an error. */
export async function revokeOperatorSession(token: unknown): Promise<void> {
  if (!isPlausibleSessionToken(token)) {
    return;
  }
  const tokenHash = hashSessionToken(token);
  await prisma.operatorSession.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
