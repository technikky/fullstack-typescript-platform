/**
 * In-memory implementations of the key-value and broker ports.
 *
 * These exist so the platform runs and is fully testable with no Redis, and so the
 * multi-replica fan-out property can be asserted in a unit test: two hubs sharing one broker
 * is the same topology as two pods sharing one Redis.
 *
 * They are held to the same contract as the Redis versions -- same suite, same assertions --
 * which is what stops them from being quietly more permissive. Two cases where it would be
 * easy to be wrong, and where the contract suite checks:
 *
 * - `setIfAbsent` must treat an expired key as absent. Redis expires lazily, so a naive Map
 *   implementation that only checks `has()` would refuse a write that real Redis allows.
 * - `incrementInWindow` must fix the expiry at the *first* increment. Re-stamping it on every
 *   call produces a limiter that never resets under sustained traffic.
 *
 * Expiry here is lazy, on read, exactly as Redis does it: no timers, so nothing keeps the
 * event loop alive and a test cannot hang waiting for a sweep.
 */

import type { Broker, KeyValue, WindowResult } from "../ports/keyvalue.js";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";

interface Entry {
  value: string;
  expiresAt: number;
}

export class MemoryKeyValue implements KeyValue {
  readonly kind = "memory" as const;
  readonly #entries = new Map<string, Entry>();
  readonly #clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  #live(key: string): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.#clock.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.#live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.#entries.set(key, { value, expiresAt: this.#clock.now() + ttlSeconds * 1000 });
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.#live(key) !== undefined) return false;
    this.#entries.set(key, { value, expiresAt: this.#clock.now() + ttlSeconds * 1000 });
    return true;
  }

  async del(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async ttl(key: string): Promise<number> {
    const entry = this.#live(key);
    if (entry === undefined) return -1;
    return Math.ceil((entry.expiresAt - this.#clock.now()) / 1000);
  }

  async incrementInWindow(key: string, windowSeconds: number): Promise<WindowResult> {
    const existing = this.#live(key);
    if (existing === undefined) {
      const expiresAt = this.#clock.now() + windowSeconds * 1000;
      this.#entries.set(key, { value: "1", expiresAt });
      return { count: 1, resetSeconds: windowSeconds };
    }
    const count = Number(existing.value) + 1;
    // The expiry is NOT extended: the window runs from the first request in it.
    existing.value = String(count);
    return {
      count,
      resetSeconds: Math.max(1, Math.ceil((existing.expiresAt - this.#clock.now()) / 1000)),
    };
  }

  /** Test-only: how many keys are stored, including expired-but-unswept ones. */
  get size(): number {
    return this.#entries.size;
  }

  async close(): Promise<void> {
    this.#entries.clear();
  }
}

export class MemoryBroker implements Broker {
  readonly kind = "memory" as const;
  readonly #channels = new Map<string, Set<(message: string) => void>>();

  async publish(channel: string, message: string): Promise<void> {
    // A copy, because a handler may unsubscribe itself while being called -- mutating the
    // live set mid-iteration would skip a sibling handler.
    for (const handler of [...(this.#channels.get(channel) ?? [])]) {
      handler(message);
    }
  }

  async subscribe(
    channel: string,
    handler: (message: string) => void,
  ): Promise<() => Promise<void>> {
    let handlers = this.#channels.get(channel);
    if (handlers === undefined) {
      handlers = new Set();
      this.#channels.set(channel, handlers);
    }
    handlers.add(handler);

    return async () => {
      const current = this.#channels.get(channel);
      if (current === undefined) return;
      current.delete(handler);
      if (current.size === 0) this.#channels.delete(channel);
    };
  }

  /** Test-only: channels with at least one subscriber. */
  get channelCount(): number {
    return this.#channels.size;
  }

  async close(): Promise<void> {
    this.#channels.clear();
  }
}
