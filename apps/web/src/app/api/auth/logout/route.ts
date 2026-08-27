import { NextRequest, NextResponse } from "next/server";
import { revokeOperatorSession } from "@/lib/auth/authService";
import { clearedSessionCookieOptions, SESSION_COOKIE_NAME } from "@/lib/auth/sessionCookie";

export const runtime = "nodejs";

/**
 * Operator logout (Phase 25 Step 2A). Revokes the session server-side
 * (authService.revokeOperatorSession marks it revoked in the database, so
 * the token is immediately invalid regardless of whether the client
 * actually discards its cookie) and clears the cookie. Idempotent: calling
 * this with no session, or an already-revoked one, still succeeds.
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  await revokeOperatorSession(token);

  const response = NextResponse.json({ status: "logged_out" }, { status: 200 });
  response.cookies.set(SESSION_COOKIE_NAME, "", clearedSessionCookieOptions());
  return response;
}
