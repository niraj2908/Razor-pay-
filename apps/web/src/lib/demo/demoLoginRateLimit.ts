import { RateLimiter } from "@/lib/rateLimit/rateLimiter";
import { InMemoryRateLimitStore } from "@/lib/rateLimit/inMemoryRateLimitStore";
import { hashRateLimitKey } from "@/lib/rateLimit/rateLimitKey";

/**
 * Rate limit for the "Explore Demo" auto-login endpoint (Phase 28C).
 * Mirrors loginRateLimit.ts/signupRateLimit.ts exactly - the same
 * domain-independent `RateLimiter` primitive, unchanged, wired to one new
 * concrete policy.
 *
 * Unlike login/signup, this endpoint takes no credential to guess - it
 * always resolves to the one fixed demo operator (see
 * lib/demo/config.ts and app/api/auth/demo-login/route.ts). The risk here
 * is not credential stuffing but resource exhaustion (spamming session
 * creation) - a single IP-only dimension is sufficient, no email
 * dimension applies. Generous limit: a real evaluator clicking "Explore
 * Demo" a few times (e.g. across tabs) must never be blocked.
 */

const IP_LIMIT = 20;
const IP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export const DEMO_LOGIN_RATE_LIMIT_POLICY = {
  ip: { limit: IP_LIMIT, windowMs: IP_WINDOW_MS },
} as const;

let ipLimiter = new RateLimiter({ limit: IP_LIMIT, windowMs: IP_WINDOW_MS }, new InMemoryRateLimitStore());

const UNKNOWN_IP_KEY = "unknown";

/** Same best-effort reasoning as loginRateLimit.ts's own `deriveClientIp` -
 * NextRequest.ip/.geo were removed in Next 15, and this repo has no
 * trusted-proxy configuration, so X-Forwarded-For is read as a best-effort
 * signal only, never treated as verified client identity. */
export function deriveClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return UNKNOWN_IP_KEY;
}

export type DemoLoginRateLimitDecision =
  | { allowed: true }
  | { allowed: false; result: Extract<ReturnType<RateLimiter["check"]>, { allowed: false }> };

export function checkDemoLoginRateLimit(ip: string): DemoLoginRateLimitDecision {
  const ipKey = hashRateLimitKey(`demo-login-ip:${ip}`);
  const result = ipLimiter.check(ipKey);
  if (!result.allowed) {
    return { allowed: false, result };
  }
  return { allowed: true };
}

/** Test-only - never called from application code. */
export function __resetDemoLoginRateLimiterForTests(): void {
  ipLimiter = new RateLimiter({ limit: IP_LIMIT, windowMs: IP_WINDOW_MS }, new InMemoryRateLimitStore());
}
