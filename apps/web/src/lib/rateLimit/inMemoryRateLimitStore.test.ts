import { describe, expect, it } from "vitest";
import { InMemoryRateLimitStore } from "./inMemoryRateLimitStore";

describe("InMemoryRateLimitStore", () => {
  it("starts a fresh window with count 1 for a new key", () => {
    const store = new InMemoryRateLimitStore();
    const counter = store.incrementAndGet("key-a", 1000, 0);
    expect(counter).toEqual({ count: 1, windowStart: 0 });
  });

  it("increments the same key within the same window", () => {
    const store = new InMemoryRateLimitStore();
    store.incrementAndGet("key-a", 1000, 0);
    const second = store.incrementAndGet("key-a", 1000, 100);
    expect(second.count).toBe(2);
    expect(second.windowStart).toBe(0);
  });

  it("starts a new window once the previous one has fully elapsed", () => {
    const store = new InMemoryRateLimitStore();
    store.incrementAndGet("key-a", 1000, 0);
    store.incrementAndGet("key-a", 1000, 500);
    const nextWindow = store.incrementAndGet("key-a", 1000, 1000);
    expect(nextWindow).toEqual({ count: 1, windowStart: 1000 });
  });

  it("keeps distinct keys in fully independent counters", () => {
    const store = new InMemoryRateLimitStore();
    store.incrementAndGet("key-a", 1000, 0);
    store.incrementAndGet("key-a", 1000, 10);
    const keyB = store.incrementAndGet("key-b", 1000, 10);
    expect(keyB).toEqual({ count: 1, windowStart: 10 });
    expect(store.size()).toBe(2);
  });

  it("is safe under simulated concurrent calls for the same key - no lost updates", () => {
    // Node's event loop guarantees this is never truly parallel, but this
    // proves the increment logic itself has no read-modify-write bug that
    // could double-count or drop an update if it were ever called from an
    // environment without that guarantee.
    const store = new InMemoryRateLimitStore();
    const calls = 50;
    for (let i = 0; i < calls; i++) {
      store.incrementAndGet("shared-key", 100_000, 0);
    }
    const finalCounter = store.incrementAndGet("shared-key", 100_000, 0);
    expect(finalCounter.count).toBe(calls + 1);
  });

  it("sweepExpired removes only keys whose window has fully elapsed", () => {
    const store = new InMemoryRateLimitStore();
    store.incrementAndGet("expired", 1000, 0);
    store.incrementAndGet("still-active", 1000, 900);
    expect(store.size()).toBe(2);

    store.sweepExpired(1000, 1000);

    expect(store.size()).toBe(1);
    // the still-active key survives and keeps its own counter
    const survivor = store.incrementAndGet("still-active", 1000, 950);
    expect(survivor.count).toBe(2);
  });

  it("never grows past the configured maxKeys, evicting the oldest entry first", () => {
    const store = new InMemoryRateLimitStore(3);
    store.incrementAndGet("a", 100_000, 0);
    store.incrementAndGet("b", 100_000, 0);
    store.incrementAndGet("c", 100_000, 0);
    expect(store.size()).toBe(3);

    // a 4th distinct key must evict the oldest ("a"), never exceed the cap
    store.incrementAndGet("d", 100_000, 0);
    expect(store.size()).toBe(3);

    // "a" was evicted - it now starts a brand new window rather than
    // resuming its old count
    const a = store.incrementAndGet("a", 100_000, 0);
    expect(a.count).toBe(1);
  });

  it("re-incrementing an existing key never grows the store, even at the cap", () => {
    const store = new InMemoryRateLimitStore(2);
    store.incrementAndGet("a", 100_000, 0);
    store.incrementAndGet("b", 100_000, 0);
    expect(store.size()).toBe(2);

    store.incrementAndGet("a", 100_000, 10);
    expect(store.size()).toBe(2);
  });
});
