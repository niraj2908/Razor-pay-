import { NextRequest, NextResponse } from "next/server";
import { createOperatorSession, verifyOperatorCredentials } from "@/lib/auth/authService";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth/sessionCookie";

// Session lookups/writes need real Postgres via Prisma - this route must
// run on the Node runtime, matching the webhook route's own reasoning.
export const runtime = "nodejs";

type LoginBody = { email?: unknown; password?: unknown };

/**
 * Operator login (Phase 25 Step 2A). Authenticates against the `Operator`
 * table - never against RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET, which an
 * operator never enters anywhere in this product.
 *
 * There is no corresponding public registration endpoint anywhere in this
 * codebase - see authService.ts's module doc for why.
 */
export async function POST(request: NextRequest) {
  let body: LoginBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "malformed_body" }, { status: 400 });
  }

  const { email, password } = body;
  if (typeof email !== "string" || typeof password !== "string" || email.length === 0 || password.length === 0) {
    return NextResponse.json({ error: "validation_error", reason: "email_and_password_required" }, { status: 400 });
  }

  try {
    const result = await verifyOperatorCredentials(email, password);
    if (result.status !== "valid") {
      console.warn("[auth] login rejected: invalid credentials");
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    const session = await createOperatorSession(result.operator.id);
    console.log("[auth] login succeeded", { operatorId: result.operator.id });

    const response = NextResponse.json({ operator: result.operator }, { status: 200 });
    response.cookies.set(SESSION_COOKIE_NAME, session.token, sessionCookieOptions(session.expiresAt));
    return response;
  } catch (error) {
    // Never surface a raw database error/stack trace to the client (Phase
    // 25 Step 1's error-contract requirement) - log for correlation only.
    console.error("[auth] login failed unexpectedly", {
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
