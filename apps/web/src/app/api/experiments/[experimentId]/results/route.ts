import { NextRequest, NextResponse } from "next/server";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { resolveMerchantAccess } from "@/lib/auth/merchantAccess";
import { isPlausibleId } from "@/lib/recovery/recoveryQueueService";
import { isValidMeasurementResultKind, listExperimentResults } from "@/lib/experiments/measurement/experimentQueryService";

export const runtime = "nodejs";

const MAX_LIMIT = 100;

/**
 * GET /api/experiments/[experimentId]/results (Phase 25 Step 6).
 *
 * Same not-found/foreign-merchant collapsing contract as
 * /api/experiments/[experimentId] (see that route's doc comment) - a
 * foreign-merchant experimentId and a nonexistent one both return an
 * identical 404, never a 403.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ experimentId: string }> }) {
  const session = await authenticateOperator();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const access = await resolveMerchantAccess(session.operator.id);
  if (!access) {
    console.error("[experiment-results] operator has no resolvable merchant", { operatorId: session.operator.id });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  const { experimentId } = await context.params;
  if (!isPlausibleId(experimentId)) {
    return NextResponse.json({ error: "validation_error", reason: "invalid_experiment_id" }, { status: 400 });
  }

  const params = request.nextUrl.searchParams;

  const kind = params.get("kind");
  if (kind !== null && !isValidMeasurementResultKind(kind)) {
    return NextResponse.json({ error: "validation_error", reason: "invalid_kind" }, { status: 400 });
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
    const result = await listExperimentResults(access.merchantId, experimentId, {
      kind: kind ?? undefined,
      cursor: cursor ?? undefined,
      limit,
    });
    if (result.status === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ items: result.items, nextCursor: result.nextCursor }, { status: 200 });
  } catch (error) {
    console.error("[experiment-results] unexpected failure", {
      operatorId: session.operator.id,
      experimentId,
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
