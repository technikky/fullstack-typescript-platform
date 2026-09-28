/**
 * Identifiers, the error taxonomy and the clock.
 *
 * Small pure modules, but each carries a property something else depends on: ids must sort by
 * creation time for the keyset pagination to be stable, the error codes must map to the statuses
 * both transports publish, and the clock must be the only source of "now" or none of the expiry
 * tests mean anything.
 */

import { describe, expect, it } from "vitest";

import { DAY, HOUR, MINUTE, SECOND, TestClock, systemClock } from "../src/clock.js";
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  isAppError,
  notFound,
  rateLimited,
  toAppError,
  unauthenticated,
  versionConflict,
} from "../src/errors.js";
import { ID_PREFIXES, idTime, isId, newId } from "../src/ids.js";

describe("identifiers", () => {
  it("carries its kind as a prefix", () => {
    expect(newId("user")).toMatch(/^usr_/);
    expect(newId("workspace")).toMatch(/^wsp_/);
    expect(newId("item")).toMatch(/^itm_/);
  });

  it("has a distinct prefix per kind", () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("is unique across many mints at the same millisecond", () => {
    const minted = new Set(Array.from({ length: 2000 }, () => newId("item", 1_700_000_000_000)));
    expect(minted.size).toBe(2000);
  });

  it("sorts lexicographically by creation time", () => {
    // What makes a b-tree index on the primary key stay dense rather than scattering inserts, and
    // what makes `order by created_at desc, id desc` a total order.
    const early = newId("item", 1_700_000_000_000);
    const later = newId("item", 1_700_000_001_000);
    const muchLater = newId("item", 1_800_000_000_000);
    expect([muchLater, early, later].sort()).toEqual([early, later, muchLater]);
  });

  it("round-trips its timestamp", () => {
    const now = 1_712_345_678_901;
    expect(idTime(newId("board", now))).toBe(now);
  });

  it("returns null when asked for the time of something that is not an id", () => {
    expect(idTime("")).toBeNull();
    expect(idTime("short")).toBeNull();
    expect(idTime("itm_lowercase0000000000000")).toBeNull();
  });

  it("recognises its own ids and rejects the wrong kind", () => {
    // A board id passed where an item id belongs fails a cheap format check rather than returning
    // "not found" and looking like a permissions problem.
    const item = newId("item");
    expect(isId("item", item)).toBe(true);
    expect(isId("board", item)).toBe(false);
  });

  it("rejects non-strings and malformed bodies", () => {
    for (const value of [undefined, null, 42, {}, [], "itm_", "itm_tooshort", "itm_" + "I".repeat(26)]) {
      expect(isId("item", value), String(value)).toBe(false);
    }
  });

  it("uses an alphabet with no ambiguous characters", () => {
    // Crockford base32: no I, L, O or U, so an id read aloud or copied by hand survives.
    const body = newId("user").split("_")[1] ?? "";
    expect(body).not.toMatch(/[ILOU]/);
    expect(body).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });
});

describe("errors", () => {
  it("maps each code to a status", () => {
    expect(badRequest("x").status).toBe(400);
    expect(unauthenticated().status).toBe(401);
    expect(forbidden().status).toBe(403);
    expect(notFound("item").status).toBe(404);
    expect(conflict("x").status).toBe(409);
    expect(versionConflict(3).status).toBe(409);
    expect(rateLimited(30).status).toBe(429);
    expect(new AppError("internal", "x").status).toBe(500);
  });

  it("is vague by default about what was forbidden", () => {
    // A precise message is an existence oracle when the caller may not know the resource exists.
    expect(forbidden().message).toBe("not permitted");
    expect(forbidden().details).toEqual({});
  });

  it("carries details where the caller can act on them", () => {
    expect(versionConflict(7).details).toEqual({ currentVersion: 7 });
    expect(rateLimited(30).details).toEqual({ retryAfterSeconds: 30 });
    expect(notFound("item", "itm_A").details).toEqual({ id: "itm_A" });
  });

  it("omits the id from not_found when none was given", () => {
    expect(notFound("workspace").details).toEqual({});
  });

  it("freezes its details, so a handler cannot mutate a shared error", () => {
    const error = versionConflict(3);
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it("recognises its own instances", () => {
    expect(isAppError(badRequest("x"))).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
    expect(isAppError("x")).toBe(false);
    expect(isAppError(null)).toBe(false);
  });

  it("passes an AppError through unchanged", () => {
    const original = conflict("already exists");
    expect(toAppError(original)).toBe(original);
  });

  it("turns anything else into internal, discarding the message", () => {
    // The original text may contain a connection string, a query or a stack path, and none of that
    // belongs in a response body.
    for (const thrown of [
      new Error("connection to postgres://user:secret@host failed"),
      "a bare string",
      { code: "42P01" },
      null,
      undefined,
    ]) {
      const mapped = toAppError(thrown);
      expect(mapped.code).toBe("internal");
      expect(mapped.message).toBe("internal error");
      expect(mapped.status).toBe(500);
    }
  });

  it("keeps a stack, so the real cause is still loggable", () => {
    expect(badRequest("x").stack).toBeDefined();
    expect(badRequest("x").name).toBe("AppError");
  });
});

describe("the clock", () => {
  it("advances only when told to", () => {
    const clock = new TestClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
    clock.advanceSeconds(2);
    expect(clock.now()).toBe(3500);
    clock.set(0);
    expect(clock.now()).toBe(0);
  });

  it("accepts a Date as its start", () => {
    const start = new Date("2026-01-15T09:00:00.000Z");
    expect(new TestClock(start).now()).toBe(start.getTime());
  });

  it("refuses to run backwards", () => {
    // A clock that can go backwards makes an expiry test able to pass for the wrong reason.
    expect(() => new TestClock(1000).advance(-1)).toThrow(/backwards/);
  });

  it("returns the real time from the system clock", () => {
    const before = Date.now();
    const observed = systemClock.now();
    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(Date.now());
  });

  it("exports consistent duration constants", () => {
    expect(SECOND).toBe(1000);
    expect(MINUTE).toBe(60 * SECOND);
    expect(HOUR).toBe(60 * MINUTE);
    expect(DAY).toBe(24 * HOUR);
  });
});
