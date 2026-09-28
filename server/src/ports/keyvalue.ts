/**
 * The key-value port: the operations the platform actually needs from Redis.
 *
 * Not "a Redis client interface" -- five operations, each one there because something
 * concrete depends on it:
 *
 * - `get` / `setIfAbsent` / `del`        access-token denylist, idempotency records
 * - `incrementInWindow`                  the sliding-window rate limiter
 * - `ttl`                                Retry-After, and asserting expiry in tests
 *
 * `setIfAbsent` rather than `set` is the important one. Idempotency and distributed locking
 * both need "write only if nobody else did", and a `get` followed by a `set` is not that: two
 * requests interleave between the two calls and both think they won. Redis expresses it as
 * `SET key value NX PX ttl`, atomically, and the port exposes exactly that shape so the
 * in-memory implementation cannot accidentally be laxer than the real one.
 */

export interface WindowResult {
  /** Requests counted in the current window, including this one. */
  readonly count: number;
  /** Seconds until the window resets. Reported to the client as Retry-After. */
  readonly resetSeconds: number;
}

export interface KeyValue {
  get(key: string): Promise<string | null>;

  /** Unconditional write with a required expiry. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;

  /**
   * Write only if the key is absent. Returns true if this caller wrote it.
   *
   * Atomic in both implementations. This is what makes idempotent POST handling correct
   * under concurrency rather than merely usually correct.
   */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;

  del(key: string): Promise<void>;

  /** Remaining life in seconds; -1 if the key is missing or already expired. */
  ttl(key: string): Promise<number>;

  /**
   * Increment a counter that expires `windowSeconds` after its first increment.
   *
   * The expiry is set only when the counter is created, so the window is fixed from the
   * first request rather than sliding forward on every one. A limiter that re-sets the TTL
   * on each increment never resets under sustained load, which locks a client out
   * indefinitely instead of for one window.
   */
  incrementInWindow(key: string, windowSeconds: number): Promise<WindowResult>;

  readonly kind: "memory" | "redis";
  close(): Promise<void>;
}

/**
 * The publish/subscribe port.
 *
 * WebSocket fan-out needs this: with more than one server replica, a client connected to
 * replica A must see an event produced on replica B. In-process event emitters cannot do
 * that, which is why the realtime hub publishes through a broker rather than iterating its
 * own socket list. The in-memory broker makes the multi-replica property testable -- two hubs
 * sharing one broker is the same topology as two pods sharing one Redis.
 */
export interface Broker {
  publish(channel: string, message: string): Promise<void>;
  /** Returns an unsubscribe function. */
  subscribe(channel: string, handler: (message: string) => void): Promise<() => Promise<void>>;
  readonly kind: "memory" | "redis";
  close(): Promise<void>;
}
