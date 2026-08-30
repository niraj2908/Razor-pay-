import type { RateLimitResult } from "./rateLimiter";

/**
 * Translates a `RateLimitResult` into standard rate-limit HTTP headers
 * (Phase 26, Public Onboarding Step 2). Pure and one-directional -
 * `RateLimitResult -> headers` only. Deliberately does NOT read a
 * `Request`, extract an IP, or decide which header a proxy/platform can
 * be trusted for - that is a deployment-topology-specific decision this
 * step does not make (see this module's final report §C), and doing it
 * here would smuggle a route-wiring decision into what is meant to stay a
 * generic, reusable translation helper.
 *
 * `conceptually: request -> derive trusted key -> RateLimiter.check() ->
 * this function -> HTTP response` is the intended shape a future route
 * assembles from these pieces - this function is only the last step of
 * that chain.
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.floor(result.resetAt.getTime() / 1000)),
  };

  if (!result.allowed) {
    headers["Retry-After"] = String(result.retryAfterSeconds);
  }

  return headers;
}
