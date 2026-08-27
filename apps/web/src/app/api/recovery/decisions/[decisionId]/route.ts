import { NextResponse } from "next/server";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { resolveMerchantAccess } from "@/lib/auth/merchantAccess";
import { getDecisionDetail } from "@/lib/recovery/decisionDetailService";
import { isPlausibleId } from "@/lib/recovery/recoveryQueueService";

export const runtime = "nodejs";

/**
 * GET /api/recovery/decisions/[decisionId] (Phase 25 Step 3).
 *
 * Merchant isolation contract (deliberate, documented choice - Phase 25
 * Step 3 Section 11): a decision that does not exist AND a decision that
 * exists but belongs to a DIFFERENT merchant both return 404 with the
 * identical body. This is never a 403, specifically so a caller can never
 * use the response to enumerate which decision ids are real under another
 * tenant - the same enumeration-resistance choice already established by
 * authService.verifyOperatorCredentials and merchantAccess.authorizeMerchantAccess.
 * The actual isolation is enforced inside getDecisionDetail's own query
 * (merchant filter in the WHERE clause), not by an app-code check here.
 */
export async function GET(_request: Request, context: { params: Promise<{ decisionId: string }> }) {
  const session = await authenticateOperator();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const access = await resolveMerchantAccess(session.operator.id);
  if (!access) {
    console.error("[decision-detail] operator has no resolvable merchant", { operatorId: session.operator.id });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  const { decisionId } = await context.params;
  if (!isPlausibleId(decisionId)) {
    return NextResponse.json({ error: "validation_error", reason: "invalid_decision_id" }, { status: 400 });
  }

  try {
    const result = await getDecisionDetail(access.merchantId, decisionId);
    if (result.status === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(result.decision, { status: 200 });
  } catch (error) {
    console.error("[decision-detail] unexpected failure", {
      operatorId: session.operator.id,
      decisionId,
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
