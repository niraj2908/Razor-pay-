import { NextRequest, NextResponse } from "next/server";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { resolveMerchantAccess } from "@/lib/auth/merchantAccess";
import { isPlausibleId } from "@/lib/recovery/recoveryQueueService";
import { validateDateRange } from "@/lib/recovery/overviewService";
import { getDecisionAuditTrail, isValidAuditEntityType } from "@/lib/recovery/decisionAuditService";

export const runtime = "nodejs";

const MAX_LIMIT = 100;

/**
 * GET /api/recovery/decisions/[decisionId]/audit (Phase 25 Audit API V1).
 *
 * Merchant isolation contract, identical to Decision Detail (Phase 25 Step
 * 3): a decision that does not exist AND a decision that exists but belongs
 * to a DIFFERENT merchant both return 404 with the identical body - never a
 * 403. The actual isolation is enforced inside getDecisionAuditTrail's own
 * query (merchant filter in the WHERE clause on Decision), not by an
 * app-code check here, and AuditEvent is never queried by its own
 * (unreliable) merchantId column.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ decisionId: string }> }) {
  const session = await authenticateOperator();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const access = await resolveMerchantAccess(session.operator.id);
  if (!access) {
    console.error("[decision-audit] operator has no resolvable merchant", { operatorId: session.operator.id });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  const { decisionId } = await context.params;
  if (!isPlausibleId(decisionId)) {
    return NextResponse.json({ error: "validation_error", reason: "invalid_decision_id" }, { status: 400 });
  }

  const params = request.nextUrl.searchParams;

  const entityType = params.get("entityType");
  if (entityType !== null && !isValidAuditEntityType(entityType)) {
    return NextResponse.json({ error: "validation_error", reason: "invalid_entity_type" }, { status: 400 });
  }

  const range = validateDateRange(params.get("since"), params.get("until"));
  if (!range.valid) {
    return NextResponse.json({ error: "validation_error", reason: range.reason }, { status: 400 });
  }

  const cursor = params.get("cursor");
  if (cursor !== null && !isPlausibleId(cursor)) {
    return NextResponse.json({ error: "validation_error", reason: "invalid_cursor" }, { status: 400 });
  }

  const limitParam = params.get("limit");
  let limit: number | undefined;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return NextResponse.json({ error: "validation_error", reason: "invalid_limit" }, { status: 400 });
    }
    limit = parsed;
  }

  try {
    const result = await getDecisionAuditTrail(access.merchantId, decisionId, {
      entityType: entityType ?? undefined,
      since: range.since,
      until: range.until,
      cursor: cursor ?? undefined,
      limit,
    });
    if (result.status === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ items: result.items, nextCursor: result.nextCursor }, { status: 200 });
  } catch (error) {
    console.error("[decision-audit] unexpected failure", {
      operatorId: session.operator.id,
      decisionId,
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
