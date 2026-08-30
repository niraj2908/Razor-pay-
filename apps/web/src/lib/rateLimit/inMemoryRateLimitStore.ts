import type { RateLimitStore, WindowCounter } from "./rateLimiter";

/**
 * In-memory `RateLimitStore` (Phase 26, Public Onboarding Step 2) - the
 * only backing store this step builds. Chosen because the alternative,
 * Postgres-backed storage, would require a new table and therefore a
 * migration, which this step's scope explicitly forbids; and because no
 * Redis/KV infrastructure exists anywhere in this codebase today (no
 * dependency, `REDIS_URL` in `.env.example` is an unused placeholder) -
 * introducing one now would be exactly the "invent a distributed system"
 * this step was told not to do. Postgres-backed storage is the correct
 * choice for a genuine multi-instance production deployment and is the
 * documented next step (see this module's final report §S), implementing
 * the same one-method `RateLimitStore` interface so the counting algorithm
 * in `rateLimiter.ts` never has to change.
 *
 * KNOWN LIMITATION, stated plainly: this state lives in one Node process's
 * memory. It does NOT coordinate across multiple application instances
 * (a caller behind a load balancer with N instances gets up to N times
 * this limiter's configured limit, one independent counter per instance),
 * and it resets to empty on every process restart/deploy. Acceptable for
 * a single-instance deployment or as a first layer of defense; not a
 * substitute for a shared store before scaling past one instance.
 *
 * Concurrency safety: `incrementAndGet` is fully synchronous - no
 * `await`, no I/O - so two "concurrent" requests in Node can never
 * interleave mid-operation; the event loop always runs one to completion
 * before the next. This is what makes a plain `Map` read-modify-write
 * here safe without a lock, and is exactly the property `rateLimiter.ts`'s
 * `RateLimitStore` interface requires of any implementation.
 *
 * Bounded growth, two mechanisms (memory-exhaustion defense against an
 * attacker who rotates keys - e.g. many distinct IPs - to avoid ever
 * hitting one key's limit while still growing this store forever):
 *   - `sweepExpired()`: removes every key whose window has already ended.
 *     Not run automatically (this module performs no timers/background
 *     work of its own - see final report §M) - a caller (the future HTTP
 *     integration step, or a scheduled task) decides when to invoke it.
 *   - `maxKeys` hard cap: once reached, inserting a genuinely new key
 *     evicts the oldest-inserted entry first (`Map` preserves insertion
 *     order in JS, which is what this relies on) - a defensive backstop
 *     so unbounded key cardinality can never grow this store past a fixed
 *     ceiling regardless of whether `sweepExpired` has been called.
 */
const DEFAULT_MAX_KEYS = 50_000;

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, WindowCounter>();
  private readonly maxKeys: number;

  constructor(maxKeys: number = DEFAULT_MAX_KEYS) {
    this.maxKeys = maxKeys;
  }

  incrementAndGet(key: string, windowMs: number, now: number): WindowCounter {
    const existing = this.counters.get(key);

    if (!existing || now - existing.windowStart >= windowMs) {
      const fresh: WindowCounter = { count: 1, windowStart: now };
      this.setWithEviction(key, fresh);
      return fresh;
    }

    existing.count += 1;
    return existing;
  }

  /** Removes every entry whose window has already ended as of `now`. Not
   * scheduled by this class itself - see this module's doc comment. */
  sweepExpired(windowMs: number, now: number): void {
    for (const [key, counter] of this.counters) {
      if (now - counter.windowStart >= windowMs) {
        this.counters.delete(key);
      }
    }
  }

  /** Number of distinct keys currently tracked - test/introspection only,
   * never used by the counting algorithm itself. */
  size(): number {
    return this.counters.size;
  }

  private setWithEviction(key: string, value: WindowCounter): void {
    if (this.counters.size >= this.maxKeys && !this.counters.has(key)) {
      const oldestKey = this.counters.keys().next().value;
      if (oldestKey !== undefined) {
        this.counters.delete(oldestKey);
      }
    }
    this.counters.set(key, value);
  }
}
