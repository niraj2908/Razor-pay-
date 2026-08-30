import { redirect } from "next/navigation";
import { authenticateOperator } from "./authenticateOperator";
import { resolveMerchantAccess } from "./merchantAccess";

/**
 * Shared page-level auth guard (Phase 26 Phase C). Every authenticated
 * Server Component page calls this exactly once, following the same
 * authenticateOperator() -> resolveMerchantAccess() chain every API route
 * already uses - no new authorization concept introduced for the UI.
 *
 * Redirects to /login when unauthenticated (Next's `redirect()` throws
 * internally, halting the render - callers never see a null return).
 * Throws (surfacing to the route's error boundary) if an authenticated
 * operator has no resolvable merchant - the same "genuine inconsistency,
 * not a logout" distinction /api/auth/session already makes.
 */
export type AuthContext = { operatorId: string; email: string; merchantId: string };

export async function requireAuthContext(): Promise<AuthContext> {
  const session = await authenticateOperator();
  if (!session) {
    redirect("/login");
  }

  const access = await resolveMerchantAccess(session.operator.id);
  if (!access) {
    throw new Error("Operator has no resolvable merchant");
  }

  return { operatorId: session.operator.id, email: session.operator.email, merchantId: access.merchantId };
}
