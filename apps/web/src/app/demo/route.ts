import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { createOperatorSession } from "@/lib/auth/authService";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth/sessionCookie";
import { checkDemoLoginRateLimit, deriveClientIp } from "@/lib/demo/demoLoginRateLimit";
import { DEMO_MERCHANT_ID, DEMO_OPERATOR_ID } from "@/lib/demo/config";

// Session writes need real Postgres via Prisma - same reasoning as every
// other auth route in this codebase.
export const runtime = "nodejs";

/**
 * "Explore Demo" entry point (Phase 28C reliability fix). A plain,
 * directly-linkable GET route rather than a client-side fetch button -
 * this is what makes it reachable and functional independent of any
 * Server Component's own existing-session redirect (see /login's doc
 * comment) and independent of client JS ever executing at all. Bookmarkable
 * and curl-able: opening this URL is the entire flow.
 *
 * Takes no input, same contract as its removed POST predecessor: it always
 * resolves to the one fixed DEMO_OPERATOR_ID (lib/demo/config.ts), never a
 * caller-supplied identity - structurally impossible to use this as a way
 * to log in as any other account.
 *
 * Deliberately does NOT check for or preserve any pre-existing session -
 * choosing to open the demo is treated as an explicit action that always
 * wins, unconditionally overwriting whatever operator_session cookie the
 * browser already carried, including a stray one from a completely
 * unrelated account. This closes the confirmed root cause of a reported
 * bug: a visitor whose browser already carried any valid session was
 * redirected straight to /overview under that OLD account by /login's own
 * "if (session) redirect" check, before the Explore Demo link was ever
 * rendered - landing them in a real but unrelated, often-empty workspace
 * that looked identical to "the demo has no data."
 *
 * Since this unconditionally overwrites whatever session the request
 * carries, an attacker who gets a signed-in visitor's browser to load this
 * URL could silently replace their real session with the demo one (a
 * "forced session swap," the same low-severity class as a forced-logout
 * CSRF - no data exposure or privilege escalation either way, since the
 * demo account grants access to nothing beyond its own synthetic data).
 * The Sec-Fetch-Dest check below is defense in depth against the *silent,
 * no-click* version of that (an <img>/<iframe>/prefetch embed) while
 * deliberately still allowing the one thing this route exists for: a
 * visitor actually clicking or pasting a shared /demo link, including one
 * from an external referring page - Sec-Fetch-Dest is "document" for a
 * real top-level navigation regardless of same-site vs. cross-site, so
 * this narrows, rather than replaces, that residual risk. Absent on older
 * browsers and on curl, in which case this falls back to today's behavior.
 */
export async function GET(request: NextRequest) {
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, request.url));

  const secFetchDest = request.headers.get("sec-fetch-dest");
  if (secFetchDest && secFetchDest !== "document") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const rateLimitDecision = checkDemoLoginRateLimit(deriveClientIp(request));
    if (!rateLimitDecision.allowed) {
      console.warn("[auth] demo login rate limited");
      return redirectTo("/login?demoError=rate_limited");
    }

    const operator = await prisma.operator.findUnique({ where: { id: DEMO_OPERATOR_ID } });
    if (!operator || operator.merchantId !== DEMO_MERCHANT_ID) {
      console.warn("[auth] demo login unavailable - demo workspace not seeded");
      return redirectTo("/login?demoError=unavailable");
    }

    const session = await createOperatorSession(operator.id);
    console.log("[auth] demo login succeeded");

    const response = redirectTo("/overview");
    response.cookies.set(SESSION_COOKIE_NAME, session.token, sessionCookieOptions(session.expiresAt));
    return response;
  } catch (error) {
    console.error("[auth] demo login failed unexpectedly", {
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return redirectTo("/login?demoError=internal_error");
  }
}
