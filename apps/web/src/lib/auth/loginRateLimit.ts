import { RateLimiter, type RateLimitResult } from "@/lib/rateLimit/rateLimiter";
import { InMemoryRateLimitStore } from "@/lib/rateLimit/inMemoryRateLimitStore";
import { hashRateLimitKey } from "@/lib/rateLimit/rateLimitKey";
import { normalizeEmail } from "./authService";

/**
 * Login-specific rate-limit policy (Phase 26, Public Auth Security). Wires
 * the domain-independent `RateLimiter` primitive (`lib/rateLimit/`,
 * unchanged - not rewritten) to exactly one concrete decision: "should
 * this login attempt proceed?" Everything login-specific - the concrete
 * limits, IP derivation, email normalization reuse - lives here rather
 * than in the generic primitive, which stays reusable for a future
 * signup route or any other endpoint.
 *
 * TWO independent dimensions, both must pass:
 *
 *   IP:    20 attempts / 5 minutes  - broad, generous. Its job is bounding
 *          total attempt VOLUME from one source regardless of which
 *          email(s) it targets (password spraying: one IP, many emails).
 *          Generous specifically so a legitimate shared-IP network
 *          (office/NAT/campus Wi-Fi) with several people logging in
 *          within the same few minutes is never blocked by this alone.
 *   EMAIL: 5 attempts / 15 minutes  - narrow, tight. Its job is bounding
 *          attempts against ONE account regardless of how many different
 *          IPs an attacker rotates through (credential stuffing/targeted
 *          brute force). This is the more load-bearing of the two in this
 *          deployment - see this module's final report §B for why the IP
 *          dimension can only ever be best-effort here.
 *
 * Both counters increment on EVERY attempt, success or failure alike -
 * not just failures. This was a deliberate choice, not an oversight: the
 * alternative (increment only on failure) would need a `reset()`/`peek()`
 * capability the primitive does not have and was explicitly told not to
 * grow in this step. "Successful users must not permanently consume the
 * counter" is satisfied without that: the fixed window resets on its own
 * every 15 minutes regardless of outcome, and both limits are generous
 * enough relative to real human login behavior (nobody logs into the same
 * account 5+ times, or from the same IP 20+ times, within one window
 * under ordinary use) that a normal successful login never meaningfully
 * erodes the budget before it resets anyway.
 *
 * Every key is SHA-256-hashed before it ever touches the limiter's
 * storage (`hashRateLimitKey`, the same helper `lib/rateLimit/` already
 * provides) - the in-memory store never holds a raw IP or email string.
 */

const IP_LIMIT = 20;
const IP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const EMAIL_LIMIT = 5;
const EMAIL_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export const LOGIN_RATE_LIMIT_POLICY = {
  ip: { limit: IP_LIMIT, windowMs: IP_WINDOW_MS },
  email: { limit: EMAIL_LIMIT, windowMs: EMAIL_WINDOW_MS },
} as const;

let ipLimiter = new RateLimiter({ limit: IP_LIMIT, windowMs: IP_WINDOW_MS }, new InMemoryRateLimitStore());
let emailLimiter = new RateLimiter({ limit: EMAIL_LIMIT, windowMs: EMAIL_WINDOW_MS }, new InMemoryRateLimitStore());

/** Used when no IP signal is available at all (header absent) so those
 * requests still share one bucket rather than silently skipping the IP
 * check entirely. Never used as a stand-in for "trusted" - see
 * `deriveClientIp`'s own doc comment. */
const UNKNOWN_IP_KEY = "unknown";

/**
 * Best-effort client IP derivation.
 *
 * `NextRequest.ip`/`.geo` were REMOVED in Next.js 15.0.0 (confirmed
 * against this project's own bundled `next/dist/docs` - see this module's
 * final report §B) - this Next 16 app has no framework-provided IP source
 * at all. The only remaining signal is the `X-Forwarded-For` request
 * header, which is trustworthy ONLY if a reverse proxy in front of this
 * application is confirmed to set/overwrite it before the request ever
 * reaches this code. This repository has no such confirmation today - no
 * `vercel.json`, no `middleware.ts`, no `@vercel/*` dependency, no reverse
 * proxy configuration of any kind.
 *
 * This function therefore does NOT pretend the header is trustworthy. It
 * reads it as a best-effort signal only (the left-most/"original client"
 * entry, by the header's own conventional meaning), explicitly documented
 * as spoofable by any caller until a real trusted-proxy configuration
 * exists. This is why the email dimension above, which depends on no
 * header at all, is the actually-reliable defense line in this
 * deployment - not a design flaw to hide, a fact to state plainly.
 */
export function deriveClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return UNKNOWN_IP_KEY;
}

export type LoginRateLimitDecision =
  | { allowed: true }
  | { allowed: false; result: Extract<RateLimitResult, { allowed: false }> };

/**
 * The one function the login route calls. Checks the IP dimension first,
 * then the email dimension - either denial short-circuits the other (an
 * attacker who has already exhausted their IP budget never gets to
 * "spend" an attempt against the email counter too). Both checks happen
 * unconditionally, before any credential verification - the decision to
 * rate-limit depends only on attempt volume against these two opaque
 * hashed keys, never on whether the email corresponds to a real account,
 * which is what keeps this enumeration-safe by construction (see final
 * report §D/§J).
 */
export function checkLoginRateLimit(ip: string, email: string): LoginRateLimitDecision {
  const ipKey = hashRateLimitKey(`login-ip:${ip}`);
  const emailKey = hashRateLimitKey(`login-email:${normalizeEmail(email)}`);

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

/**
 * Test-only. Replaces both limiters with fresh, empty instances so tests
 * never leak rate-limit state into one another - never called from
 * application code (only ever imported from a `*.test.ts` file).
 */
export function __resetLoginRateLimitersForTests(): void {
  ipLimiter = new RateLimiter({ limit: IP_LIMIT, windowMs: IP_WINDOW_MS }, new InMemoryRateLimitStore());
  emailLimiter = new RateLimiter({ limit: EMAIL_LIMIT, windowMs: EMAIL_WINDOW_MS }, new InMemoryRateLimitStore());
}
