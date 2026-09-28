/**
 * Rate limiting and idempotent writes. Both live in the key-value store, and both are here
 * because the naive version of each is subtly wrong.
 *
 * **Rate limiting.** Keyed on the authenticated user when there is one, and on the client IP
 * when there is not. Keying only on IP punishes everyone behind one NAT; keying only on the user
 * leaves the login endpoint -- the one that matters, because it is the credential-stuffing
 * target -- unprotected, since a caller attacking it has no identity yet. Login and registration
 * get their own much smaller budget for the same reason.
 *
 * The window is fixed from the first request rather than sliding per request. See
 * `incrementInWindow` in the key-value port: re-stamping the expiry on every increment produces
 * a limiter that never resets under sustained load, so a client that trips it once stays locked
 * out for as long as it keeps trying.
 *
 * **Idempotency.** A client that retries a POST after a timeout must not create two items. The
 * `Idempotency-Key` header claims a slot with `setIfAbsent` -- atomically, so two concurrent
 * retries cannot both win -- and the stored response is replayed on a repeat. The request
 * fingerprint is stored alongside, so reusing one key for a *different* body is rejected rather
 * than silently answered with the wrong resource.
 */

import { createHash } from "node:crypto";

import type { Clock } from "../clock.js";
import { badRequest, conflict, rateLimited } from "../errors.js";
import type { KeyValue } from "../ports/keyvalue.js";

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetSeconds: number;
}

export interface RateLimitOptions {
  readonly windowSeconds: number;
  readonly maxRequests: number;
}

export class RateLimiter {
  readonly #keyValue: KeyValue;

  constructor(keyValue: KeyValue) {
    this.#keyValue = keyValue;
  }

  /**
   * `bucket` separates budgets that should not share one (`auth` from `api`), and `subject` is
   * the user id or IP. Both are in the key so a limit on one endpoint class cannot exhaust
   * another.
   */
  async check(
    bucket: string,
    subject: string,
    options: RateLimitOptions,
  ): Promise<RateLimitDecision> {
    const key = `ratelimit:${bucket}:${subject}`;
    const { count, resetSeconds } = await this.#keyValue.incrementInWindow(
      key,
      options.windowSeconds,
    );
    return {
      allowed: count <= options.maxRequests,
      limit: options.maxRequests,
      remaining: Math.max(0, options.maxRequests - count),
      resetSeconds,
    };
  }

  /** Throw the standard error if the budget is exhausted. */
  async enforce(bucket: string, subject: string, options: RateLimitOptions): Promise<RateLimitDecision> {
    const decision = await this.check(bucket, subject, options);
    if (!decision.allowed) throw rateLimited(decision.resetSeconds);
    return decision;
  }
}

/** A stored idempotency record. */
interface Record_ {
  /** Hash of method + path + body, so the same key with a different request is caught. */
  readonly fingerprint: string;
  readonly status: number;
  readonly body: string;
  /** Set while the first request is still running. */
  readonly pending: boolean;
}

export type IdempotencyOutcome =
  | { readonly kind: "proceed" }
  | { readonly kind: "replay"; readonly status: number; readonly body: string }
  /** The first request with this key has not finished yet. */
  | { readonly kind: "in_flight" };

export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

const fingerprintOf = (method: string, path: string, body: string): string =>
  createHash("sha256").update(`${method} ${path}\n${body}`, "utf8").digest("base64url");

export class IdempotencyStore {
  readonly #keyValue: KeyValue;
  readonly #ttlSeconds: number;
  readonly #clock: Clock;

  constructor(keyValue: KeyValue, clock: Clock, ttlSeconds = 24 * 60 * 60) {
    this.#keyValue = keyValue;
    this.#ttlSeconds = ttlSeconds;
    this.#clock = clock;
  }

  #key(userId: string, idempotencyKey: string): string {
    // Scoped per user: two users must be able to send the same key, and one must not be able to
    // read another's stored response by guessing it.
    return `idem:${userId}:${idempotencyKey}`;
  }

  /**
   * Claim the key, or report what is already stored under it.
   *
   * `setIfAbsent` is what makes this safe: a `get` followed by a `set` leaves a window in which
   * two concurrent retries both see nothing and both proceed.
   */
  async begin(
    userId: string,
    idempotencyKey: string,
    method: string,
    path: string,
    body: string,
  ): Promise<IdempotencyOutcome> {
    if (idempotencyKey.length === 0 || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw badRequest(`Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
    }

    const key = this.#key(userId, idempotencyKey);
    const fingerprint = fingerprintOf(method, path, body);
    const claim: Record_ = { fingerprint, status: 0, body: "", pending: true };

    if (await this.#keyValue.setIfAbsent(key, JSON.stringify(claim), this.#ttlSeconds)) {
      return { kind: "proceed" };
    }

    const stored = await this.#keyValue.get(key);
    if (stored === null) {
      // Expired between the failed claim and this read. Treating it as a fresh request is the
      // only option left, and it is the safe one: the record it would have replayed is gone.
      return { kind: "proceed" };
    }

    const record = JSON.parse(stored) as Record_;
    if (record.fingerprint !== fingerprint) {
      throw conflict("this Idempotency-Key was used with a different request", {
        idempotencyKey,
      });
    }
    if (record.pending) return { kind: "in_flight" };
    return { kind: "replay", status: record.status, body: record.body };
  }

  /** Store the response so a retry replays it. */
  async complete(
    userId: string,
    idempotencyKey: string,
    method: string,
    path: string,
    requestBody: string,
    status: number,
    responseBody: string,
  ): Promise<void> {
    const record: Record_ = {
      fingerprint: fingerprintOf(method, path, requestBody),
      status,
      body: responseBody,
      pending: false,
    };
    await this.#keyValue.set(this.#key(userId, idempotencyKey), JSON.stringify(record), this.#ttlSeconds);
  }

  /**
   * Release the claim when the request failed.
   *
   * A failed request must not be replayed: the client should be able to retry and have it
   * actually run. Leaving a `pending` record would make every retry return `in_flight` until the
   * TTL expired.
   */
  async abandon(userId: string, idempotencyKey: string): Promise<void> {
    await this.#keyValue.del(this.#key(userId, idempotencyKey));
  }

  /** Exposed for tests that assert TTLs. */
  get ttlSeconds(): number {
    return this.#ttlSeconds;
  }

  /** Present so the store participates in the same injected-clock discipline as everything else. */
  get now(): number {
    return this.#clock.now();
  }
}
