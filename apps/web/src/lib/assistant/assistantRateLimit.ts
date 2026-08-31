import { RateLimiter } from "@/lib/rateLimit/rateLimiter";
import { InMemoryRateLimitStore } from "@/lib/rateLimit/inMemoryRateLimitStore";
import { hashRateLimitKey } from "@/lib/rateLimit/rateLimitKey";

/**
 * Rate limit for the AI Assistant query endpoint (Phase 28C). Same
 * domain-independent `RateLimiter` primitive as every other endpoint's own
 * dedicated policy module (login/signup/demo-login) - unchanged, wired to
 * one new concrete policy.
 *
 * Keyed per-operator (this endpoint is authenticated, unlike demo-login) -
 * the risk here is one signed-in operator hammering the query services
 * with rapid-fire questions, not credential stuffing, so an operator-id
 * key is the right dimension rather than IP.
 */
const OPERATOR_LIMIT = 30;
const OPERATOR_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export const ASSISTANT_RATE_LIMIT_POLICY = { operator: { limit: OPERATOR_LIMIT, windowMs: OPERATOR_WINDOW_MS } } as const;

let operatorLimiter = new RateLimiter({ limit: OPERATOR_LIMIT, windowMs: OPERATOR_WINDOW_MS }, new InMemoryRateLimitStore());

export type AssistantRateLimitDecision =
  | { allowed: true }
  | { allowed: false; result: Extract<ReturnType<RateLimiter["check"]>, { allowed: false }> };

export function checkAssistantRateLimit(operatorId: string): AssistantRateLimitDecision {
  const key = hashRateLimitKey(`assistant-query-operator:${operatorId}`);
  const result = operatorLimiter.check(key);
  if (!result.allowed) {
    return { allowed: false, result };
  }
  return { allowed: true };
}

/** Test-only - never called from application code. */
export function __resetAssistantRateLimiterForTests(): void {
  operatorLimiter = new RateLimiter({ limit: OPERATOR_LIMIT, windowMs: OPERATOR_WINDOW_MS }, new InMemoryRateLimitStore());
}
