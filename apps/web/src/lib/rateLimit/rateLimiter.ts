/**
 * Domain-independent rate-limiting primitive (Phase 26, Public Onboarding
 * Step 2). Answers exactly one question - "has this key made too many
 * calls in the current window?" - and nothing else. It has no idea what a
 * Operator, Merchant, Razorpay, password, or signup form is; a caller
 * supplies an opaque string key and gets back a decision. This is
 * deliberate: the same primitive protects login attempts, a future signup
 * endpoint, or any other future abuse-prone action, without ever being
 * rewritten for a new use case.
 *
 * Algorithm: fixed window counter. Evaluated against the alternatives -
 * sliding window (log or counter-weighted), token bucket, leaky bucket -
 * and rejected all three for V1:
 *   - Sliding-window-log is the most accurate but needs unbounded
 *     per-request timestamp storage per key; wrong trade for an in-memory
 *     structure with no external store backing it (see
 *     inMemoryRateLimitStore.ts's own doc comment on bounded growth).
 *   - Token bucket and leaky bucket both need an extra "refill rate"
 *     concept on top of "limit" and "window" for no clear V1 benefit here:
 *     the thing being defended against (repeated auth attempts) doesn't
 *     need traffic-smoothing, it needs a hard ceiling per key per window.
 *   - Fixed window is O(1) storage per key (one counter + one timestamp),
 *     trivial to reason about and test, and matches this codebase's
 *     existing preference for the simplest correct mechanism (see
 *     password.ts's choice of scrypt over a heavier KDF library for the
 *     same reasoning). Its one known weakness - up to ~2x `limit` calls
 *     can land in a short span that straddles a window boundary (e.g. the
 *     last moment of one window plus the first moment of the next) - is
 *     an accepted, explicitly-documented V1 trade-off for coarse auth-
 *     abuse protection, not billing-grade metering.
 */

/** A window's counter state: how many calls so far, and when the window
 * that count belongs to started. */
export type WindowCounter = { count: number; windowStart: number };

/**
 * Storage boundary the algorithm depends on, kept intentionally narrow
 * (one method) so a future backing store (Postgres, Redis) can implement
 * it without the counting logic above ever changing. `inMemoryRateLimiter
 * Store.ts` is the only implementation that exists today - see this
 * module's final report for why Postgres-backed storage was evaluated and
 * deferred, not built, in this step.
 *
 * MUST be synchronous and MUST NOT perform any asynchronous work
 * internally. `RateLimiter.check()` calls this without an `await` in
 * between the read and the write specifically so a single JS call stays
 * atomic under Node's single-threaded event loop - an async
 * implementation (e.g. a real network round-trip to an external store)
 * reintroduces the exact race window a naive "get, then increment, then
 * set" pattern has. A future async-capable store is a deliberate,
 * separate design decision, not a drop-in swap for this interface.
 */
export interface RateLimitStore {
  /** Atomically increments and returns the counter for `key`'s current
   * window, starting a fresh window (count reset to 1) if `now` has moved
   * past the previous window's end. */
  incrementAndGet(key: string, windowMs: number, now: number): WindowCounter;
}

export type RateLimiterConfig = {
  /** Maximum allowed calls per key per window. */
  limit: number;
  /** Fixed window size in milliseconds. */
  windowMs: number;
};

export type RateLimitResult =
  | { allowed: true; limit: number; remaining: number; resetAt: Date }
  | { allowed: false; limit: number; remaining: 0; resetAt: Date; retryAfterSeconds: number };

/**
 * The limiter itself. Holds no domain knowledge and does no I/O of its
 * own beyond calling the injected `RateLimitStore` - everything about
 * "who is asking" (an IP, an email, a hash of the two) is the caller's
 * concern, decided at the HTTP integration boundary in a later step, not
 * here.
 */
export class RateLimiter {
  constructor(
    private readonly config: RateLimiterConfig,
    private readonly store: RateLimitStore
  ) {}

  /**
   * Fail-closed by design in both places it can fail, because this
   * primitive exists specifically to protect authentication surfaces - a
   * rate limiter that quietly lets requests through when it can't make a
   * real decision would defeat its own purpose at precisely the moment it
   * matters most:
   *
   *   - an empty/non-string `key` never gets its own unlimited "no
   *     identity" bucket - it is denied outright, every time, rather than
   *     silently sharing one global bucket that every malformed caller
   *     could exhaust for every other malformed caller (or vice versa,
   *     never being enforced at all).
   *   - if `store.incrementAndGet` throws for any reason (today: only a
   *     genuine bug, since the in-memory store never does I/O; this
   *     matters once a real network-backed store is ever plugged in via
   *     this same interface), the call is denied rather than allowed -
   *     see this module's final report §F for the explicit trade-off this
   *     accepts (a storage outage degrades into "no logins succeed" runs,
   *     never into "no rate limiting exists").
   */
  check(key: string, now: number = Date.now()): RateLimitResult {
    if (typeof key !== "string" || key.length === 0) {
      return this.deniedFor(this.config.windowMs, now);
    }

    let counter: WindowCounter;
    try {
      counter = this.store.incrementAndGet(key, this.config.windowMs, now);
    } catch {
      return this.deniedFor(this.config.windowMs, now);
    }

    const resetAt = new Date(counter.windowStart + this.config.windowMs);

    if (counter.count > this.config.limit) {
      const retryAfterSeconds = Math.max(0, Math.ceil((resetAt.getTime() - now) / 1000));
      return { allowed: false, limit: this.config.limit, remaining: 0, resetAt, retryAfterSeconds };
    }

    return {
      allowed: true,
      limit: this.config.limit,
      remaining: this.config.limit - counter.count,
      resetAt,
    };
  }

  private deniedFor(windowMs: number, now: number): RateLimitResult {
    const resetAt = new Date(now + windowMs);
    return { allowed: false, limit: this.config.limit, remaining: 0, resetAt, retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }
}
