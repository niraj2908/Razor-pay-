import { NextResponse } from "next/server";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { resolveMerchantAccess } from "@/lib/auth/merchantAccess";

export const runtime = "nodejs";

/**
 * "Who am I, and for which merchant?" (Phase 25 Step 2A identity + Step 2B
 * merchant resolution, composed here for the first time). Returns 401 if
 * unauthenticated. This is still infrastructure, not a product API: it
 * exposes nothing beyond the operator's own identity and their one
 * authorized merchantId - never any Recovery/Experiment/Decision/etc. data.
 *
 * Calls authenticateOperator() then resolveMerchantAccess() as two
 * explicit, separate steps (never a combined helper) - see
 * merchantAccess.ts's module doc for why.
 */
export async function GET() {
  const session = await authenticateOperator();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const access = await resolveMerchantAccess(session.operator.id);
  if (!access) {
    // The session resolved to a real operator row moments ago; an operator
    // that no longer resolves to a merchant here is a genuine data
    // inconsistency, not an ordinary "unauthenticated" case - reported as
    // an internal error rather than silently treated as logged out.
    console.error("[auth] operator has no resolvable merchant", { operatorId: session.operator.id });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  return NextResponse.json({ operator: session.operator, merchantId: access.merchantId }, { status: 200 });
}
