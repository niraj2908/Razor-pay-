import { prisma } from "@/lib/db";

/**
 * Merchant Authorization (Phase 25 Step 2B).
 *
 * Answers ONLY "which merchant may this authenticated operator access" - a
 * SEPARATE, explicit stage after `authenticateOperator()`, never combined
 * with it:
 *
 *   authenticateOperator() -> resolveMerchantAccess() -> scoped query
 *
 * Deliberately does its OWN database read (a second query beyond the
 * session lookup already performed by `authenticateOperator`) rather than
 * having authentication's return type carry a `merchantId` field - keeping
 * "who" and "which merchant" as two independently callable, independently
 * testable functions means a future multi-merchant model change (a real
 * possibility - see Phase 25 Step 2B's report for the alternative that was
 * evaluated and not chosen) only has to change this file, never
 * `authService.ts`'s identity shape or any of its existing callers.
 *
 * Today's model is single-merchant-per-operator (Operator.merchantId, a
 * required FK) - so `resolveMerchantAccess` is a simple lookup, not a
 * permission-set computation. `authorizeMerchantAccess` exists alongside it
 * specifically for routes that receive an explicit merchantId from client
 * input (e.g. a path param) and must verify it against the operator's own
 * merchant, rather than trusting the caller-supplied value - this is what
 * actually prevents an IDOR-style cross-merchant data leak at the one
 * layer every future domain API is expected to call through.
 */

export type MerchantAccess = { merchantId: string };

/** Returns the operator's own (and only) merchant, or null if the operator
 * id does not resolve to a real row - the latter should not ordinarily
 * happen for an id that just came from `authenticateOperator()`, but this
 * function never assumes that guarantee holds elsewhere; it verifies it. */
export async function resolveMerchantAccess(operatorId: string): Promise<MerchantAccess | null> {
  const operator = await prisma.operator.findUnique({
    where: { id: operatorId },
    select: { merchantId: true },
  });
  if (!operator) return null;
  return { merchantId: operator.merchantId };
}

export type AuthorizeMerchantResult =
  | { authorized: true; merchantId: string }
  | { authorized: false };

/**
 * Verifies that `requestedMerchantId` (e.g. a path/query param a route
 * received from the client) matches the operator's own merchant. Returns
 * `authorized: false` uniformly whether the operator doesn't resolve at
 * all or resolves to a DIFFERENT merchant than requested - a caller must
 * never be able to distinguish "you don't exist" from "that's not your
 * merchant" through this result, for the same enumeration-resistance
 * reason `authService.verifyOperatorCredentials` collapses its own two
 * failure cases.
 */
export async function authorizeMerchantAccess(operatorId: string, requestedMerchantId: string): Promise<AuthorizeMerchantResult> {
  const access = await resolveMerchantAccess(operatorId);
  if (!access || access.merchantId !== requestedMerchantId) {
    return { authorized: false };
  }
  return { authorized: true, merchantId: access.merchantId };
}
