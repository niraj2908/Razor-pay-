import { cookies } from "next/headers";
import { resolveOperatorSession, type ResolvedSession } from "./authService";
import { SESSION_COOKIE_NAME } from "./sessionToken";

/**
 * THE single shared authentication boundary (Phase 25 Step 2A, Section 5).
 *
 * Every future protected Route Handler or Server Component must call this
 * - and ONLY this - to answer "who is the authenticated operator?" It
 * deliberately answers nothing else: no merchant, no role, no permission.
 * That is Phase 25 Step 2B's `resolveMerchantAccess()`, which this
 * function's return value is designed to feed into next:
 *
 *   authenticateOperator() -> resolveMerchantAccess() -> scoped query
 *
 * Reads the session cookie via Next.js's own `cookies()` API (App Router
 * Route Handlers and Server Components only - this cannot be called from a
 * Client Component). Returns null for every "not authenticated" case
 * (missing cookie, malformed token, unknown/expired/revoked session) -
 * callers must treat null uniformly as "unauthenticated," never
 * distinguish the reason (see authService.ts's verifyOperatorCredentials
 * for why that distinction is itself a security leak).
 */
export async function authenticateOperator(): Promise<ResolvedSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  return resolveOperatorSession(token);
}
