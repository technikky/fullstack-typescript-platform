/**
 * Access tokens and refresh-token rotation.
 *
 * The design, and the reasoning for each half:
 *
 * **Access token: a short-lived signed JWT.** Ten minutes, HS256, carrying `sub` (user),
 * `sid` (session) and `jti`. It is stateless so an authenticated request needs no database
 * round trip to establish *who* is calling. It deliberately carries **no roles**: a role in a
 * token is a role that cannot be revoked until the token expires, so demoting an admin would
 * not take effect for ten minutes. Authorization reads membership per request instead. The cost
 * is one indexed lookup; the alternative is a permission system that lies for a while.
 *
 * **Refresh token: an opaque random string, stored hashed, rotated on every use.** Not a JWT,
 * because a refresh token must be revocable and a signed bearer token is not. 32 random bytes,
 * stored as SHA-256 -- a database leak then yields no usable credential. Every refresh issues a
 * successor and marks the old one used.
 *
 * **Reuse detection.** If a token that has already been used is presented again, either the
 * client replayed it or an attacker stole it, and those are indistinguishable from the server.
 * The safe reading is theft, so the entire token *family* -- every descendant of one login -- is
 * revoked, and both parties have to log in again. That turns a stolen refresh token from
 * indefinite access into at most one extra request. Without this, a stolen token rotates
 * happily alongside the victim's forever.
 *
 * SHA-256 is correct for the refresh token and would be wrong for a password: the input here is
 * 256 bits of entropy, so there is nothing to brute-force and nothing for a slow hash to buy.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

import type { Clock } from "../clock.js";
import { DAY, MINUTE } from "../clock.js";
import { newId } from "../ids.js";
import type { Database, Queryable } from "../ports/database.js";
import type { KeyValue } from "../ports/keyvalue.js";
import { unauthenticated } from "../errors.js";

export interface TokenConfig {
  readonly secret: Uint8Array;
  readonly issuer: string;
  readonly audience: string;
  readonly accessTtlMillis: number;
  readonly refreshTtlMillis: number;
}

export const DEFAULT_ACCESS_TTL = 10 * MINUTE;
export const DEFAULT_REFRESH_TTL = 30 * DAY;

export interface AccessClaims {
  readonly userId: string;
  readonly sessionId: string;
  readonly tokenId: string;
  readonly expiresAt: number;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
  readonly sessionId: string;
}

const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("base64url");

const denylistKey = (tokenId: string): string => `denylist:access:${tokenId}`;

interface RefreshRow extends Record<string, unknown> {
  id: string;
  family_id: string;
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
}

export class TokenService {
  readonly #database: Database;
  readonly #keyValue: KeyValue;
  readonly #clock: Clock;
  readonly #config: TokenConfig;

  constructor(options: {
    database: Database;
    keyValue: KeyValue;
    clock: Clock;
    config: TokenConfig;
  }) {
    this.#database = options.database;
    this.#keyValue = options.keyValue;
    this.#clock = options.clock;
    this.#config = options.config;
  }

  /** A fresh login: a new family, a new session, a new pair. */
  async issue(userId: string): Promise<TokenPair> {
    const familyId = newId("tokenFamily", this.#clock.now());
    return this.#database.transaction((tx) => this.#createPair(userId, familyId, null, tx));
  }

  /**
   * Mint a pair inside the caller's transaction.
   *
   * Taking the transaction rather than opening its own is the whole point, and it was a bug
   * before it was a design: rotation originally validated the presented token in one transaction
   * and marked it used in a second. The `for update` lock was released at the first commit, so
   * two concurrent refreshes of the same token both read `used_at is null` and both succeeded --
   * which is exactly the case reuse detection exists to catch. Validating, marking used and
   * inserting the successor in one transaction closes it.
   */
  async #createPair(
    userId: string,
    familyId: string,
    predecessorId: string | null,
    tx: Queryable,
  ): Promise<TokenPair> {
    const now = this.#clock.now();
    const sessionId = newId("session", now);
    const tokenId = newId("refreshToken", now);

    const accessExpiresAt = now + this.#config.accessTtlMillis;
    const accessToken = await new SignJWT({ sid: sessionId } satisfies JWTPayload)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(userId)
      .setJti(tokenId)
      .setIssuer(this.#config.issuer)
      .setAudience(this.#config.audience)
      // jose takes seconds. Both are derived from the injected clock, never from Date.now(),
      // so a test can expire a token without waiting for one.
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor(accessExpiresAt / 1000))
      .sign(this.#config.secret);

    const refreshToken = randomBytes(32).toString("base64url");
    const refreshExpiresAt = now + this.#config.refreshTtlMillis;

    await tx.query(
      `insert into refresh_tokens (id, family_id, user_id, token_hash, issued_at, expires_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [tokenId, familyId, userId, hashToken(refreshToken), new Date(now), new Date(refreshExpiresAt)],
    );
    if (predecessorId !== null) {
      await tx.query(`update refresh_tokens set used_at = $1, replaced_by = $2 where id = $3`, [
        new Date(now),
        tokenId,
        predecessorId,
      ]);
    }

    return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt, sessionId };
  }

  /**
   * Verify an access token.
   *
   * Signature and claims first, then the denylist. Order matters: checking the denylist before
   * the signature would let an unauthenticated caller probe for valid `jti` values.
   */
  async verifyAccess(token: string): Promise<AccessClaims> {
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, this.#config.secret, {
        issuer: this.#config.issuer,
        audience: this.#config.audience,
        algorithms: ["HS256"],
        // jose defaults to the real clock; this platform's notion of now is injected, so tests
        // can expire a token deterministically.
        currentDate: new Date(this.#clock.now()),
      });
      payload = verified.payload;
    } catch {
      throw unauthenticated("invalid or expired access token");
    }

    const userId = payload.sub;
    const tokenId = payload.jti;
    const sessionId = typeof payload["sid"] === "string" ? payload["sid"] : undefined;
    if (userId === undefined || tokenId === undefined || sessionId === undefined) {
      throw unauthenticated("access token is missing required claims");
    }

    if ((await this.#keyValue.get(denylistKey(tokenId))) !== null) {
      throw unauthenticated("this token was revoked");
    }

    return {
      userId,
      sessionId,
      tokenId,
      expiresAt: (payload.exp ?? 0) * 1000,
    };
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * Validation, marking the presented token used, and inserting its successor all happen in one
   * transaction, under `for update` on the token row. That is what makes two simultaneous
   * refreshes of the same token impossible to both succeed: the second blocks on the lock, then
   * sees `used_at` set and trips reuse detection.
   *
   * The outcome is returned rather than thrown from inside the transaction, because the reuse
   * case has to *commit* the family revocation before the caller sees an error. Throwing there
   * would roll the revocation back and leave the stolen token working.
   *
   * Strict revocation, with no grace interval: a legitimate double-submit -- two browser tabs
   * refreshing at once -- is treated as theft and logs both out. A short reuse window is the usual
   * mitigation, and it is deliberately not implemented here, because a token replayed inside the
   * window would be honoured. `docs/auth.md` records the trade-off.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const presentedHash = hashToken(refreshToken);
    const now = this.#clock.now();

    const outcome = await this.#database.transaction(
      async (
        tx: Queryable,
      ): Promise<
        | { kind: "ok"; pair: TokenPair }
        | { kind: "unknown" }
        | { kind: "expired" }
        | { kind: "revoked" }
        | { kind: "reused"; familyId: string }
      > => {
        const found = await tx.query<RefreshRow>(
          `select id, family_id, user_id, expires_at, used_at, revoked_at
             from refresh_tokens
            where token_hash = $1
            for update`,
          [presentedHash],
        );
        const row = found.rows[0];
        if (row === undefined) return { kind: "unknown" };

        if (row.used_at !== null) {
          // Reuse. Revoke every token in the family, used or not: the attacker holds one of
          // them and there is no way to tell which.
          await tx.query(
            `update refresh_tokens
                set revoked_at = $1
              where family_id = $2 and revoked_at is null`,
            [new Date(now), row.family_id],
          );
          return { kind: "reused", familyId: row.family_id };
        }
        if (row.revoked_at !== null) return { kind: "revoked" };
        if (row.expires_at.getTime() <= now) return { kind: "expired" };

        return {
          kind: "ok",
          pair: await this.#createPair(row.user_id, row.family_id, row.id, tx),
        };
      },
    );

    switch (outcome.kind) {
      case "unknown":
        throw unauthenticated("unknown refresh token");
      case "expired":
        throw unauthenticated("refresh token has expired");
      case "revoked":
        throw unauthenticated("refresh token has been revoked");
      case "reused":
        // Said plainly, because the legitimate user needs to understand why they were logged
        // out -- and an attacker learns nothing they did not already know.
        throw unauthenticated(
          "this refresh token was already used; the whole session family has been revoked",
        );
      case "ok":
        return outcome.pair;
    }
  }

  /**
   * Log out: revoke the refresh family and deny the access token immediately.
   *
   * Without the denylist, "log out" would mean "keep working for up to ten minutes", which is
   * precisely what a user clicking log out on a shared machine does not want. The denylist entry
   * lives only until the access token would have expired anyway, so it stays small -- bounded by
   * logouts per access-token lifetime, not by total sessions.
   */
  async logout(claims: AccessClaims): Promise<void> {
    const now = this.#clock.now();
    const remainingSeconds = Math.max(1, Math.ceil((claims.expiresAt - now) / 1000));
    await this.#keyValue.set(denylistKey(claims.tokenId), "revoked", remainingSeconds);

    await this.#database.query(
      `update refresh_tokens
          set revoked_at = $1
        where revoked_at is null
          and family_id = (select family_id from refresh_tokens where id = $2)`,
      [new Date(now), claims.tokenId],
    );
  }

  /** Revoke every session for a user. Used when a password changes. */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.#database.query(
      `update refresh_tokens
          set revoked_at = $1
        where user_id = $2 and revoked_at is null`,
      [new Date(this.#clock.now()), userId],
    );
    return result.rowCount;
  }

  /**
   * Delete refresh tokens that expired more than `graceMillis` ago.
   *
   * The grace period is deliberate: a token deleted the moment it expires turns a legitimate
   * late refresh into "unknown refresh token", which is indistinguishable from an attack in the
   * logs. Keeping expired rows for a while means the server can say "expired" accurately.
   */
  async pruneExpired(graceMillis = 7 * DAY): Promise<number> {
    const cutoff = new Date(this.#clock.now() - graceMillis);
    const result = await this.#database.query(
      `delete from refresh_tokens where expires_at < $1`,
      [cutoff],
    );
    return result.rowCount;
  }
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Exported because the idempotency layer needs the same property when comparing stored request
 * fingerprints.
 */
export const secureEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};
