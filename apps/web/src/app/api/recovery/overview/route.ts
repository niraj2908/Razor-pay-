import { NextRequest, NextResponse } from "next/server";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { resolveMerchantAccess } from "@/lib/auth/merchantAccess";
import { getRecoveryOverview, validateDateRange } from "@/lib/recovery/overviewService";

export const runtime = "nodejs";

/**
 * GET /api/recovery/overview (Phase 25 Step 4B).
 *
 * Thin route handler, identical shape to /api/recovery/queue: authenticate
 * -> authorize (merchant derived ONLY from the operator, never from client
 * input - this route accepts no merchantId parameter at all) -> validate
 * `since`/`until` -> delegate to the query service -> return its DTO
 * verbatim. Contains no aggregation/decision/economics/statistics logic of
 * its own.
 */
export async function GET(request: NextRequest) {
  const session = await authenticateOperator();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const access = await resolveMerchantAccess(session.operator.id);
  if (!access) {
    console.error("[recovery-overview] operator has no resolvable merchant", { operatorId: session.operator.id });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  const params = request.nextUrl.searchParams;
  const range = validateDateRange(params.get("since"), params.get("until"));
  if (!range.valid) {
    return NextResponse.json({ error: "validation_error", reason: range.reason }, { status: 400 });
  }

  try {
    const result = await getRecoveryOverview(access.merchantId, { since: range.since, until: range.until });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("[recovery-overview] unexpected failure", {
      operatorId: session.operator.id,
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
