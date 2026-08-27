import { NextRequest, NextResponse } from "next/server";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { resolveMerchantAccess } from "@/lib/auth/merchantAccess";
import {
  isPlausibleId,
  isValidDecisionType,
  isValidDiagnosis,
  isValidSort,
  isValidStatusFilter,
  listRecoveryQueue,
} from "@/lib/recovery/recoveryQueueService";

export const runtime = "nodejs";

const MAX_LIMIT = 100;

/**
 * GET /api/recovery/queue (Phase 25 Step 3).
 *
 * Thin route handler: authenticate -> authorize (derive merchant from the
 * operator, NEVER from client input) -> validate query params against an
 * explicit allowlist -> delegate to the query service -> return its DTO
 * verbatim. Contains no decision/economics/statistics logic of its own.
 *
 * Merchant isolation: this route accepts NO merchantId parameter at all -
 * there is nothing here for a client to tamper with. The merchant is
 * always `resolveMerchantAccess(operator.id)`'s result.
 */
export async function GET(request: NextRequest) {
  const session = await authenticateOperator();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const access = await resolveMerchantAccess(session.operator.id);
  if (!access) {
    console.error("[recovery-queue] operator has no resolvable merchant", { operatorId: session.operator.id });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  const params = request.nextUrl.searchParams;

  const status = params.get("status");
  if (status !== null && !isValidStatusFilter(status)) {
    return NextResponse.json({ error: "validation_error", reason: "invalid_status" }, { status: 400 });
  }

  const diagnosis = params.get("diagnosis");
  if (diagnosis !== null && !isValidDiagnosis(diagnosis)) {
    return NextResponse.json({ error: "validation_error", reason: "invalid_diagnosis" }, { status: 400 });
  }

  const decisionType = params.get("decisionType");
  if (decisionType !== null && !isValidDecisionType(decisionType)) {
    return NextResponse.json({ error: "validation_error", reason: "invalid_decision_type" }, { status: 400 });
  }

  const sort = params.get("sort");
  if (sort !== null && !isValidSort(sort)) {
    return NextResponse.json({ error: "validation_error", reason: "invalid_sort" }, { status: 400 });
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
    const result = await listRecoveryQueue(access.merchantId, {
      status: status ?? undefined,
      diagnosis: diagnosis ?? undefined,
      decisionType: decisionType ?? undefined,
      sort: sort ?? undefined,
      cursor: cursor ?? undefined,
      limit,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("[recovery-queue] unexpected failure", {
      operatorId: session.operator.id,
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
