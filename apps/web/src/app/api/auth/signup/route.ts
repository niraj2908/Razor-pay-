import { NextRequest, NextResponse } from "next/server";
import { signUpNewWorkspace } from "@/lib/auth/signupService";
import { createOperatorSession } from "@/lib/auth/authService";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth/sessionCookie";
import { checkSignupRateLimit, deriveClientIp } from "@/lib/auth/signupRateLimit";
import { rateLimitHeaders } from "@/lib/rateLimit/rateLimitHttp";

// Same reasoning as the login route: Merchant/Operator creation needs
// real Postgres via Prisma.
export const runtime = "nodejs";

type SignupBody = { email?: unknown; password?: unknown; workspaceName?: unknown };

/**
 * Public self-signup (Phase 26, Public Onboarding). Creates a brand-new
 * Merchant/workspace and its first Operator, atomically
 * (`signUpNewWorkspace`), then issues a session via the exact same,
 * already-audited `createOperatorSession` login itself uses - no new
 * session mechanism.
 *
 * The request body has no merchantId field at all - there is nothing for
 * a caller to supply that could select an existing workspace, by
 * omission, not by a runtime check that could be bypassed.
 */
export async function POST(request: NextRequest) {
  let body: SignupBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "malformed_body" }, { status: 400 });
  }

  const { email, password, workspaceName } = body;
  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    typeof workspaceName !== "string" ||
    email.length === 0 ||
    password.length === 0 ||
    workspaceName.length === 0
  ) {
    return NextResponse.json(
      { error: "validation_error", reason: "email_password_and_workspace_name_required" },
      { status: 400 }
    );
  }

  try {
    // Same ordering and enumeration-safety reasoning as the login route:
    // the rate-limit decision depends only on attempt volume against two
    // opaque hashed keys, never on whether the email already has an
    // account, and happens before signUpNewWorkspace is ever called.
    const rateLimitDecision = checkSignupRateLimit(deriveClientIp(request), email);
    if (!rateLimitDecision.allowed) {
      console.warn("[auth] signup rate limited");
      return NextResponse.json(
        { error: "rate_limited" },
        { status: 429, headers: rateLimitHeaders(rateLimitDecision.result) }
      );
    }

    const result = await signUpNewWorkspace(email, password, workspaceName);

    if (result.status === "email_already_exists") {
      // Deliberately more specific than login's uniform response - see
      // signupService.ts's own doc comment for why this is an accepted,
      // documented trade-off rather than an oversight. Reveals nothing
      // beyond "this email is taken."
      return NextResponse.json({ error: "email_already_exists" }, { status: 409 });
    }
    if (result.status === "invalid_password") {
      return NextResponse.json({ error: "validation_error", reason: "invalid_password" }, { status: 400 });
    }
    if (result.status === "invalid_workspace_name") {
      return NextResponse.json({ error: "validation_error", reason: "invalid_workspace_name" }, { status: 400 });
    }

    const session = await createOperatorSession(result.operator.id);
    console.log("[auth] signup succeeded", { operatorId: result.operator.id });

    const response = NextResponse.json({ operator: result.operator }, { status: 201 });
    response.cookies.set(SESSION_COOKIE_NAME, session.token, sessionCookieOptions(session.expiresAt));
    return response;
  } catch (error) {
    // Never surface a raw database error/stack trace to the client - same
    // contract as the login route.
    console.error("[auth] signup failed unexpectedly", {
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
