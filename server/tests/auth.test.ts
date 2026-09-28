/**
 * Password hashing and the refresh-token lifecycle.
 *
 * The refresh tests are the reason this file exists. Rotation is easy to implement and easy to
 * implement in a way that provides no protection at all: if a used token keeps working, a stolen
 * one works forever alongside the victim's, and nothing in a normal test suite notices.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DAY, MINUTE } from "../src/clock.js";
import {
  DEFAULT_PARAMS,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  needsRehash,
  validatePassword,
  verifyPassword,
} from "../src/auth/password.js";
import { secureEquals } from "../src/auth/tokens.js";
import { createHarness, createUser, TEST_SCRYPT, type Harness } from "./support/harness.js";

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const stored = await hashPassword("correct-horse-battery", TEST_SCRYPT);
    expect(await verifyPassword("correct-horse-battery", stored)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("correct-horse-battery", TEST_SCRYPT);
    expect(await verifyPassword("correct-horse-batterz", stored)).toBe(false);
  });

  it("produces a different hash each time for the same password", async () => {
    // A per-password random salt. Without it, identical passwords share a hash, and one leaked
    // database instantly reveals every account that reused a common password.
    const first = await hashPassword("same-password-here", TEST_SCRYPT);
    const second = await hashPassword("same-password-here", TEST_SCRYPT);
    expect(first).not.toBe(second);
    expect(await verifyPassword("same-password-here", first)).toBe(true);
    expect(await verifyPassword("same-password-here", second)).toBe(true);
  });

  it("stores its parameters so they can be raised later", async () => {
    const stored = await hashPassword("a-password-value", TEST_SCRYPT);
    expect(stored.startsWith(`scrypt$${TEST_SCRYPT.N}$${TEST_SCRYPT.r}$${TEST_SCRYPT.p}$`)).toBe(true);
    expect(stored.split("$")).toHaveLength(7);
  });

  it("verifies a hash made with different parameters", async () => {
    // The point of storing them: raising the cost must not lock out existing accounts.
    const weak = await hashPassword("a-password-value", { N: 256, r: 8, p: 1, keylen: 32 });
    expect(await verifyPassword("a-password-value", weak)).toBe(true);
  });

  it("flags a hash weaker than the current defaults for rehashing", async () => {
    const weak = await hashPassword("a-password-value", { N: 256, r: 8, p: 1, keylen: 32 });
    expect(needsRehash(weak, TEST_SCRYPT)).toBe(true);
    expect(needsRehash(await hashPassword("a-password-value", TEST_SCRYPT), TEST_SCRYPT)).toBe(false);
  });

  it("treats a corrupt stored value as a failed login rather than an error", async () => {
    // A single bad row must fail one login, not take the endpoint down for everyone.
    for (const corrupt of [
      "",
      "not-a-hash",
      "scrypt$1024$8$1$32$only-five-parts",
      "bcrypt$1024$8$1$32$c2FsdA$aGFzaA",
      "scrypt$notanumber$8$1$32$c2FsdA$aGFzaA",
      "scrypt$1000$8$1$32$c2FsdA$aGFzaA", // N is not a power of two
      "scrypt$1024$0$1$32$c2FsdA$aGFzaA",
      "scrypt$1024$8$1$8$c2FsdA$aGFzaA", // keylen too short
    ]) {
      expect(await verifyPassword("anything", corrupt), corrupt).toBe(false);
      expect(needsRehash(corrupt, TEST_SCRYPT), corrupt).toBe(true);
    }
  });

  it("rejects a password that is too short or only whitespace", () => {
    expect(validatePassword("short")).toContain(`at least ${MIN_PASSWORD_LENGTH}`);
    expect(validatePassword(" ".repeat(20))).toContain("whitespace");
    expect(validatePassword("x".repeat(500))).toContain("at most");
    expect(validatePassword("a-perfectly-fine-password")).toBeNull();
  });

  it("imposes no composition rules", () => {
    // Deliberate: composition rules push users toward `Password1!`, and length is the only
    // requirement that measurably helps.
    expect(validatePassword("alllowercasenodigits")).toBeNull();
  });

  it("works at the real OWASP parameters", async () => {
    // Run once, not per fixture. The production cost is around 100 ms per hash, which is the
    // point -- and it is also why the rest of the suite uses cheaper parameters.
    const stored = await hashPassword("a-real-world-password", DEFAULT_PARAMS);
    expect(await verifyPassword("a-real-world-password", stored)).toBe(true);
    expect(await verifyPassword("a-real-world-passwore", stored)).toBe(false);
    expect(needsRehash(stored)).toBe(false);
  }, 30_000);
});

describe("secureEquals", () => {
  it("compares equal and unequal values", () => {
    expect(secureEquals("abc", "abc")).toBe(true);
    expect(secureEquals("abc", "abd")).toBe(false);
  });

  it("returns false for different lengths without throwing", () => {
    // `timingSafeEqual` throws on a length mismatch, so the length check has to come first.
    expect(secureEquals("abc", "abcd")).toBe(false);
    expect(secureEquals("", "a")).toBe(false);
  });
});

describe("tokens", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness.reset();
  });
  afterAll(async () => {
    await harness.close();
  });

  it("issues a usable access token", async () => {
    const user = await createUser(harness);
    const claims = await harness.container.tokens.verifyAccess(user.accessToken);
    expect(claims.userId).toBe(user.id);
    expect(claims.sessionId).toMatch(/^ses_/);
    expect(claims.tokenId).toMatch(/^rft_/);
  });

  it("carries no role claims", async () => {
    // Deliberate. A role in a token is a role that cannot be revoked until the token expires, so
    // demoting an admin would not take effect for ten minutes.
    const user = await createUser(harness);
    const [, payload] = user.accessToken.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(decoded).sort()).toEqual(["aud", "exp", "iat", "iss", "jti", "sid", "sub"]);
  });

  it("rejects a tampered token", async () => {
    const user = await createUser(harness);
    const [header, payload] = user.accessToken.split(".");
    const forged = `${header}.${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    await expect(harness.container.tokens.verifyAccess(forged)).rejects.toThrow(/invalid or expired/);
  });

  it("rejects garbage", async () => {
    for (const token of ["", "not.a.token", "a.b.c.d"]) {
      await expect(harness.container.tokens.verifyAccess(token)).rejects.toThrow();
    }
  });

  it("rejects an expired access token", async () => {
    const user = await createUser(harness);
    harness.clock.advance(11 * MINUTE);
    await expect(harness.container.tokens.verifyAccess(user.accessToken)).rejects.toThrow(
      /invalid or expired/,
    );
  });

  it("rejects a token signed with a different secret", async () => {
    // Two deployments with different secrets must not accept each other's tokens.
    const other = await createHarness({
      jwt: {
        secret: new TextEncoder().encode("a-completely-different-secret-value-here"),
        issuer: "platform-test",
        audience: "platform-test-api",
        accessTtlMillis: 10 * MINUTE,
        refreshTtlMillis: 30 * DAY,
      },
    });
    try {
      const user = await createUser(other);
      await expect(harness.container.tokens.verifyAccess(user.accessToken)).rejects.toThrow();
    } finally {
      await other.close();
    }
  });

  it("refreshes into a new pair", async () => {
    const user = await createUser(harness);
    harness.clock.advance(MINUTE);
    const refreshed = await harness.container.tokens.refresh(user.refreshToken);

    expect(refreshed.accessToken).not.toBe(user.accessToken);
    expect(refreshed.refreshToken).not.toBe(user.refreshToken);
    const claims = await harness.container.tokens.verifyAccess(refreshed.accessToken);
    expect(claims.userId).toBe(user.id);
  });

  it("rotates: the old refresh token stops working", async () => {
    const user = await createUser(harness);
    await harness.container.tokens.refresh(user.refreshToken);
    await expect(harness.container.tokens.refresh(user.refreshToken)).rejects.toThrow(/already used/);
  });

  it("revokes the whole family when a used token is replayed", async () => {
    // The property that matters: reuse turns a stolen refresh token from indefinite access into
    // one extra request. Without it, the attacker's token rotates happily alongside the victim's.
    const user = await createUser(harness);
    const second = await harness.container.tokens.refresh(user.refreshToken);
    const third = await harness.container.tokens.refresh(second.refreshToken);

    // The attacker replays the token from two rotations ago.
    await expect(harness.container.tokens.refresh(user.refreshToken)).rejects.toThrow(/already used/);

    // The victim's current token is now dead too -- both parties must log in again, which is the
    // only safe response when theft and replay are indistinguishable.
    await expect(harness.container.tokens.refresh(third.refreshToken)).rejects.toThrow(/revoked/);
  });

  it("reuse detection does not touch another family", async () => {
    // Two logins by the same user are separate families: one being compromised must not log the
    // other's device out.
    const user = await createUser(harness);
    const otherLogin = await harness.container.tokens.issue(user.id);

    await harness.container.tokens.refresh(user.refreshToken);
    await expect(harness.container.tokens.refresh(user.refreshToken)).rejects.toThrow();

    await expect(harness.container.tokens.refresh(otherLogin.refreshToken)).resolves.toBeDefined();
  });

  it("only one of two simultaneous refreshes of the same token succeeds", async () => {
    // `for update` on the token row is what makes this true. Without the lock, both transactions
    // read `used_at is null` and both mint a successor, so a stolen token would rotate silently
    // alongside the real one.
    const user = await createUser(harness);
    const outcomes = await Promise.allSettled([
      harness.container.tokens.refresh(user.refreshToken),
      harness.container.tokens.refresh(user.refreshToken),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  });

  it("rejects an unknown refresh token", async () => {
    await expect(harness.container.tokens.refresh("not-a-real-token")).rejects.toThrow(/unknown/);
  });

  it("rejects an expired refresh token", async () => {
    const user = await createUser(harness);
    harness.clock.advance(31 * DAY);
    await expect(harness.container.tokens.refresh(user.refreshToken)).rejects.toThrow(/expired/);
  });

  it("stores the token hashed, never the token", async () => {
    // A database leak must not hand over working credentials.
    const user = await createUser(harness);
    const found = await harness.container.database.query<{ token_hash: string }>(
      `select token_hash from refresh_tokens`,
    );
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]?.token_hash).not.toBe(user.refreshToken);
    expect(found.rows[0]?.token_hash).not.toContain(user.refreshToken);
  });

  it("logout revokes the family and denies the access token immediately", async () => {
    // Without the denylist, "log out" would mean "keep working for up to ten minutes", which is
    // precisely what someone logging out of a shared machine does not want.
    const user = await createUser(harness);
    const claims = await harness.container.tokens.verifyAccess(user.accessToken);
    await harness.container.tokens.logout(claims);

    await expect(harness.container.tokens.verifyAccess(user.accessToken)).rejects.toThrow(/revoked/);
    await expect(harness.container.tokens.refresh(user.refreshToken)).rejects.toThrow(/revoked/);
  });

  it("the denylist entry expires with the token it shadows", async () => {
    // Bounded by logouts per access-token lifetime, not by total sessions -- otherwise the
    // denylist grows without limit.
    const user = await createUser(harness);
    const claims = await harness.container.tokens.verifyAccess(user.accessToken);
    await harness.container.tokens.logout(claims);

    const ttl = await harness.keyValue.ttl(`denylist:access:${claims.tokenId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it("logging out one session leaves another alone", async () => {
    const user = await createUser(harness);
    const otherLogin = await harness.container.tokens.issue(user.id);

    const claims = await harness.container.tokens.verifyAccess(user.accessToken);
    await harness.container.tokens.logout(claims);

    await expect(
      harness.container.tokens.verifyAccess(otherLogin.accessToken),
    ).resolves.toBeDefined();
  });

  it("revokeAllForUser kills every session", async () => {
    const user = await createUser(harness);
    const second = await harness.container.tokens.issue(user.id);
    const third = await harness.container.tokens.issue(user.id);

    const revoked = await harness.container.tokens.revokeAllForUser(user.id);
    expect(revoked).toBe(3);

    for (const token of [user.refreshToken, second.refreshToken, third.refreshToken]) {
      await expect(harness.container.tokens.refresh(token)).rejects.toThrow(/revoked/);
    }
  });

  it("revokeAllForUser leaves another user's sessions alone", async () => {
    const first = await createUser(harness);
    const second = await createUser(harness);
    await harness.container.tokens.revokeAllForUser(first.id);
    await expect(harness.container.tokens.refresh(second.refreshToken)).resolves.toBeDefined();
  });

  it("pruneExpired keeps recently expired tokens so the error stays accurate", async () => {
    // A token deleted the moment it expires turns a legitimate late refresh into "unknown token",
    // which is indistinguishable from an attack in the logs.
    const user = await createUser(harness);
    harness.clock.advance(31 * DAY);

    expect(await harness.container.tokens.pruneExpired(7 * DAY)).toBe(0);
    await expect(harness.container.tokens.refresh(user.refreshToken)).rejects.toThrow(/expired/);

    harness.clock.advance(8 * DAY);
    expect(await harness.container.tokens.pruneExpired(7 * DAY)).toBe(1);
    await expect(harness.container.tokens.refresh(user.refreshToken)).rejects.toThrow(/unknown/);
  });

  it("a new session id is minted on every refresh", async () => {
    const user = await createUser(harness);
    const first = await harness.container.tokens.verifyAccess(user.accessToken);
    const refreshed = await harness.container.tokens.refresh(user.refreshToken);
    const second = await harness.container.tokens.verifyAccess(refreshed.accessToken);
    expect(second.sessionId).not.toBe(first.sessionId);
  });
});
