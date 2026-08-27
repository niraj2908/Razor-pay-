import { NextResponse } from "next/server";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { resolveMerchantAccess } from "@/lib/auth/merchantAccess";
import { isPlausibleId } from "@/lib/recovery/recoveryQueueService";
import { getExperimentDetail } from "@/lib/experiments/measurement/experimentQueryService";

export const runtime = "nodejs";

/**
 * GET /api/experiments/[experimentId] (Phase 25 Step 6).
 *
 * Merchant isolation contract (identical to Decision Detail, Phase 25 Step
 * 3): an experiment that does not exist AND an experiment that exists but
 * belongs to a DIFFERENT merchant both return 404 with the identical body -
 * never a 403, so a caller can never use the response to enumerate which
 * experiment ids are real under another tenant. The actual isolation is
 * enforced inside getExperimentDetail's own query (merchant filter in the
 * WHERE clause), not by an app-code check here.
 */
export async function GET(_request: Request, context: { params: Promise<{ experimentId: string }> }) {
  const session = await authenticateOperator();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const access = await resolveMerchantAccess(session.operator.id);
  if (!access) {
    console.error("[experiment-detail] operator has no resolvable merchant", { operatorId: session.operator.id });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  const { experimentId } = await context.params;
  if (!isPlausibleId(experimentId)) {
    return NextResponse.json({ error: "validation_error", reason: "invalid_experiment_id" }, { status: 400 });
  }

  try {
    const result = await getExperimentDetail(access.merchantId, experimentId);
    if (result.status === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(result.experiment, { status: 200 });
  } catch (error) {
    console.error("[experiment-detail] unexpected failure", {
      operatorId: session.operator.id,
      experimentId,
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
