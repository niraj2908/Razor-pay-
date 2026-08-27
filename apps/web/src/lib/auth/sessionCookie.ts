import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from "./sessionToken";

/**
 * Cookie option builders (Phase 25 Step 2A). Pure - returns plain option
 * objects rather than calling any Next.js API directly, so the security
 * flags themselves are unit-testable without a request/response context.
 *
 * httpOnly: always true - a session token must never be reachable from
 * client-side JavaScript (defends against token theft via XSS).
 * secure: gated on NODE_ENV rather than always true, so local development
 * over plain http://localhost still works - this is the standard,
 * documented Next.js pattern, not a security shortcut for production
 * (Vercel/any real deployment always sets NODE_ENV=production).
 * sameSite: "lax" - blocks the cookie from being sent on cross-site
 * top-level POST/fetch (the classic CSRF vector) while still allowing
 * normal same-site navigation; sufficient here because login/logout are
 * same-origin JSON fetches, never a classic auto-submitting cross-site
 * HTML form target - see the final report's CSRF section for why a
 * separate CSRF token scheme was judged unnecessary on top of this.
 */
export type CookieOptions = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge?: number; // seconds
  expires?: Date;
};

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function sessionCookieOptions(expiresAt: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  };
}

/** Overwrites the cookie with an already-expired one - the standard,
 * reliable way to clear a cookie (relying on the browser deleting it),
 * used on logout alongside server-side session revocation. */
export function clearedSessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  };
}

export { SESSION_COOKIE_NAME, SESSION_TTL_MS };
