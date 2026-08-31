import { NextRequest, NextResponse } from "next/server";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { resolveMerchantAccess } from "@/lib/auth/merchantAccess";
import { answerAssistantQuestion } from "@/lib/assistant/assistantService";
import { checkAssistantRateLimit } from "@/lib/assistant/assistantRateLimit";
import { rateLimitHeaders } from "@/lib/rateLimit/rateLimitHttp";

export const runtime = "nodejs";

const MAX_QUESTION_LENGTH = 500;

/**
 * POST /api/assistant/query (Phase 28C). Same thin-route shape as every
 * other authenticated route: authenticate -> resolve the operator's OWN
 * merchant -> validate input -> delegate. `assistantService.ts` holds all
 * answering logic; this route only wires auth, rate limiting, and the
 * request/response contract - it never touches the database directly and
 * never accepts a client-supplied merchantId.
 */
export async function POST(request: NextRequest) {
  const session = await authenticateOperator();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const access = await resolveMerchantAccess(session.operator.id);
  if (!access) {
    console.error("[assistant] operator has no resolvable merchant", { operatorId: session.operator.id });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  const rateLimitDecision = checkAssistantRateLimit(session.operator.id);
  if (!rateLimitDecision.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: rateLimitHeaders(rateLimitDecision.result) });
  }

  let body: { question?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "malformed_body" }, { status: 400 });
  }

  const { question } = body;
  if (typeof question !== "string" || question.trim().length === 0) {
    return NextResponse.json({ error: "validation_error", reason: "question_required" }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return NextResponse.json({ error: "validation_error", reason: "question_too_long" }, { status: 400 });
  }

  try {
    const result = await answerAssistantQuestion(access.merchantId, question);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("[assistant] unexpected failure", {
      operatorId: session.operator.id,
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
