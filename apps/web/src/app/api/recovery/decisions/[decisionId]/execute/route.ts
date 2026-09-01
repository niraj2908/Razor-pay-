import { NextResponse } from "next/server";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { resolveMerchantAccess } from "@/lib/auth/merchantAccess";
import { executeDecision } from "@/lib/recovery/decisionExecutionService";
import { isPlausibleId } from "@/lib/recovery/recoveryQueueService";

export const runtime = "nodejs";

/**
 * POST /api/recovery/decisions/[decisionId]/execute.
 *
 * The operator-triggered execution boundary: the first production caller
 * of the Execution Service. Same shape as every other route here -
 * authenticate -> authorize -> validate the path param -> delegate. The
 * merchant is derived ONLY from the operator's session; this route accepts
 * no merchantId and no body at all, so there is nothing a caller can send
 * that changes which decision is executed or how.
 *
 * A decision that does not exist and one belonging to a DIFFERENT merchant
 * both return 404 with an identical body, matching the enumeration
 * resistance of GET /api/recovery/decisions/[decisionId].
 *
 * No separate CSRF token: the session cookie is `SameSite=Lax`, which is
 * not sent on a cross-site POST, and this endpoint is called by same-origin
 * `fetch` only (docs/authentication.md, "CSRF stance").
 *
 * Status codes are chosen so a client can distinguish "nothing happened and
 * retrying is pointless" from "something went wrong out there":
 *   200 executed, or already executed (idempotent replay)
 *   202 ambiguous - the Razorpay call may or may not have landed
 *   404 no such decision for this merchant
 *   409 the decision exists but cannot be executed (not ACT, no action,
 *       stale, CONTROL arm, unsupported strategy)
 *   502 Razorpay definitively failed the action
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ decisionId: string }> }
) {
  const session = await authenticateOperator();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const access = await resolveMerchantAccess(session.operator.id);
  if (!access) {
    console.error("[decision-execute] operator has no resolvable merchant", {
      operatorId: session.operator.id,
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  const { decisionId } = await context.params;
  if (!isPlausibleId(decisionId)) {
    return NextResponse.json({ error: "validation_error", reason: "invalid_decision_id" }, { status: 400 });
  }

  try {
    const outcome = await executeDecision(access.merchantId, decisionId);

    if (outcome.status === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (outcome.status === "refused") {
      return NextResponse.json({ error: "not_executable", reason: outcome.reason }, { status: 409 });
    }

    const result = outcome.result;
    console.log("[decision-execute] execution attempted", {
      operatorId: session.operator.id,
      decisionId,
      resultStatus: result.status,
    });

    switch (result.status) {
      case "succeeded":
        return NextResponse.json(
          { status: "succeeded", executionId: result.executionId, razorpayReferenceId: result.razorpayReferenceId },
          { status: 200 }
        );
      case "existing":
        return NextResponse.json(
          { status: "existing", executionId: result.executionId, executionStatus: result.executionStatus },
          { status: 200 }
        );
      case "ambiguous":
        return NextResponse.json(
          { status: "ambiguous", executionId: result.executionId, errorCategory: result.errorCategory },
          { status: 202 }
        );
      case "failed":
        return NextResponse.json(
          { status: "failed", executionId: result.executionId, errorCategory: result.errorCategory },
          { status: 502 }
        );
      case "skipped":
        return NextResponse.json(
          { status: "skipped", executionId: result.executionId, reason: result.reason },
          { status: 409 }
        );
      case "rejected":
        return NextResponse.json({ error: "not_executable", reason: result.reason }, { status: 409 });
    }
  } catch (error) {
    console.error("[decision-execute] unexpected failure", {
      operatorId: session.operator.id,
      decisionId,
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
