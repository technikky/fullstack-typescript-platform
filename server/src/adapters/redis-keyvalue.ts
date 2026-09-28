/**
 * Redis implementations of the key-value and broker ports.
 *
 * Two details that are the reason this file is not three lines long:
 *
 * **`setIfAbsent` is one command.** `SET key value NX PX ttl` is atomic. A `GET` followed by a
 * `SET` is not, and the gap between them is exactly where two concurrent requests with the
 * same idempotency key both decide they are the first.
 *
 * **`incrementInWindow` is a Lua script.** `INCR` then `EXPIRE` is two round trips with a
 * window in between: if the process dies after the `INCR`, the counter has no expiry and the
 * client is limited forever. Worse, calling `EXPIRE` unconditionally re-stamps the TTL on
 * every request, so under sustained load the window never elapses. The script sets the expiry
 * only when the counter was just created, and returns the count and the remaining TTL
 * together so Retry-After needs no second call. Redis runs a script atomically, so there is
 * no interleaving.
 *
 * Not reachable on the machine this was developed on. CI runs the identical contract suite
 * against a `redis:7` service container.
 */

import { Redis } from "ioredis";

import type { Broker, KeyValue, WindowResult } from "../ports/keyvalue.js";

/**
 * KEYS[1] counter, ARGV[1] window in seconds.
 * Returns {count, ttl}. The expiry is set only on creation, so the window is fixed from the
 * first request rather than sliding forward on every one.
 */
const INCREMENT_IN_WINDOW = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  return {count, tonumber(ARGV[1])}
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  -- A counter with no expiry can only come from a crash between INCR and EXPIRE. Give it
  -- one rather than leaving the client limited forever.
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export class RedisKeyValue implements KeyValue {
  readonly kind = "redis" as const;
  readonly #redis: Redis;

  constructor(urlOrClient: string | Redis) {
    this.#redis = typeof urlOrClient === "string" ? new Redis(urlOrClient) : urlOrClient;
  }

  async get(key: string): Promise<string | null> {
    return this.#redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.#redis.set(key, value, "EX", ttlSeconds);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const reply = await this.#redis.set(key, value, "EX", ttlSeconds, "NX");
    return reply === "OK";
  }

  async del(key: string): Promise<void> {
    await this.#redis.del(key);
  }

  async ttl(key: string): Promise<number> {
    const ttl = await this.#redis.ttl(key);
    // Redis distinguishes "missing" (-2) from "no expiry" (-1); the port promises -1 for
    // "gone", and every key this platform writes has an expiry, so both collapse to -1.
    return ttl < 0 ? -1 : ttl;
  }

  async incrementInWindow(key: string, windowSeconds: number): Promise<WindowResult> {
    const reply = (await this.#redis.eval(
      INCREMENT_IN_WINDOW,
      1,
      key,
      String(windowSeconds),
    )) as [number, number];
    return { count: reply[0], resetSeconds: Math.max(1, reply[1]) };
  }

  async close(): Promise<void> {
    await this.#redis.quit();
  }
}

/**
 * A Redis pub/sub broker.
 *
 * Two connections, because a Redis connection in subscribe mode cannot issue other commands.
 * Sharing one would make `publish` fail as soon as anything subscribed -- a bug that only
 * appears once a second feature starts using the broker.
 */
export class RedisBroker implements Broker {
  readonly kind = "redis" as const;
  readonly #publisher: Redis;
  readonly #subscriber: Redis;
  readonly #handlers = new Map<string, Set<(message: string) => void>>();

  constructor(url: string) {
    this.#publisher = new Redis(url);
    this.#subscriber = new Redis(url);
    this.#subscriber.on("message", (channel: string, message: string) => {
      for (const handler of [...(this.#handlers.get(channel) ?? [])]) handler(message);
    });
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.#publisher.publish(channel, message);
  }

  async subscribe(
    channel: string,
    handler: (message: string) => void,
  ): Promise<() => Promise<void>> {
    let handlers = this.#handlers.get(channel);
    if (handlers === undefined) {
      handlers = new Set();
      this.#handlers.set(channel, handlers);
      await this.#subscriber.subscribe(channel);
    }
    handlers.add(handler);

    return async () => {
      const current = this.#handlers.get(channel);
      if (current === undefined) return;
      current.delete(handler);
      // Only leave the Redis channel once nothing local wants it; unsubscribing while a
      // sibling handler is still registered would silently stop delivering to it.
      if (current.size === 0) {
        this.#handlers.delete(channel);
        await this.#subscriber.unsubscribe(channel);
      }
    };
  }

  async close(): Promise<void> {
    this.#handlers.clear();
    await Promise.all([this.#publisher.quit(), this.#subscriber.quit()]);
  }
}
