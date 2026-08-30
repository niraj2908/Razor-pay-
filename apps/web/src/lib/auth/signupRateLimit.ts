import { RateLimiter, type RateLimitResult } from "@/lib/rateLimit/rateLimiter";
import { InMemoryRateLimitStore } from "@/lib/rateLimit/inMemoryRateLimitStore";
import { hashRateLimitKey } from "@/lib/rateLimit/rateLimitKey";
import { normalizeEmail } from "./authService";

/**
 * Signup-specific rate-limit policy (Phase 26, Public Onboarding).
 * Deliberately its own module with its own constants, not a reuse of
 * `loginRateLimit.ts`'s limits - signup and login are different abuse
 * shapes and were explicitly told not to share a policy:
 *
 *   IP:    10 signups / 60 minutes - tighter than login's IP limit
 *          (20 / 5 minutes). A real visitor essentially never signs up
 *          more than once; more than a handful of NEW WORKSPACE creations
 *          from one IP within an hour is a strong bot/abuse signal in a
 *          way repeated LOGIN attempts from a shared office IP is not.
 *          Ten still comfortably allows a handful of genuinely distinct
 *          people on one shared network each creating their own workspace
 *          within the same hour.
 *   EMAIL: 5 attempts / 60 minutes - generous enough for a real person's
 *          few retries (a mistyped password, a workspace name rejected
 *          for being empty) without meaningfully weakening abuse
 *          resistance, since each email can only ever succeed in creating
 *          a workspace ONCE (`Operator.email` is globally unique) -
 *          nearly every attempt beyond the first for the same email after
 *          success will just be `email_already_exists` regardless.
 *
 * Both counters increment on every attempt, success or failure alike -
 * the same accounting choice `loginRateLimit.ts` made and for the same
 * reason (see that module's own doc comment): the fixed window resets on
 * its own, and a real signup happens once per email in practice, so there
 * is no realistic scenario where a legitimate user's own successful
 * signup erodes a budget they still need.
 */

const IP_LIMIT = 10;
const IP_WINDOW_MS = 60 * 60 * 1000; // 60 minutes
const EMAIL_LIMIT = 5;
const EMAIL_WINDOW_MS = 60 * 60 * 1000; // 60 minutes

export const SIGNUP_RATE_LIMIT_POLICY = {
  ip: { limit: IP_LIMIT, windowMs: IP_WINDOW_MS },
  email: { limit: EMAIL_LIMIT, windowMs: EMAIL_WINDOW_MS },
} as const;

let ipLimiter = new RateLimiter({ limit: IP_LIMIT, windowMs: IP_WINDOW_MS }, new InMemoryRateLimitStore());
let emailLimiter = new RateLimiter({ limit: EMAIL_LIMIT, windowMs: EMAIL_WINDOW_MS }, new InMemoryRateLimitStore());

/** See `loginRateLimit.ts`'s identical constant for the full reasoning -
 * unchanged here: `NextRequest.ip`/`.geo` were removed in Next.js 15, no
 * trusted-proxy configuration is confirmed anywhere in this repository, so
 * `X-Forwarded-For` is read as a best-effort signal only, never treated as
 * trustworthy. */
const UNKNOWN_IP_KEY = "unknown";

export function deriveClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return UNKNOWN_IP_KEY;
}

export type SignupRateLimitDecision =
  | { allowed: true }
  | { allowed: false; result: Extract<RateLimitResult, { allowed: false }> };

export function checkSignupRateLimit(ip: string, email: string): SignupRateLimitDecision {
  const ipKey = hashRateLimitKey(`signup-ip:${ip}`);
  const emailKey = hashRateLimitKey(`signup-email:${normalizeEmail(email)}`);

  const ipResult = ipLimiter.check(ipKey);
  if (!ipResult.allowed) {
    return { allowed: false, result: ipResult };
  }

  const emailResult = emailLimiter.check(emailKey);
  if (!emailResult.allowed) {
    return { allowed: false, result: emailResult };
  }

  return { allowed: true };
}

/** Test-only - see `loginRateLimit.ts`'s identical helper. Never called
 * from application code. */
export function __resetSignupRateLimitersForTests(): void {
  ipLimiter = new RateLimiter({ limit: IP_LIMIT, windowMs: IP_WINDOW_MS }, new InMemoryRateLimitStore());
  emailLimiter = new RateLimiter({ limit: EMAIL_LIMIT, windowMs: EMAIL_WINDOW_MS }, new InMemoryRateLimitStore());
}
