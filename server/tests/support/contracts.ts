/**
 * Port contract suites.
 *
 * One set of assertions, run against every implementation of a port. This is the whole
 * justification for having ports at all: without a shared suite, an in-memory adapter drifts
 * toward whatever makes the tests pass, and then it is a fake rather than a substitute -- so the
 * suite that "passes locally" says nothing about the Redis the production code will talk to.
 *
 * Which implementations run is decided by what is reachable:
 *
 * | Adapter               | Locally                 | CI                     |
 * | --------------------- | ----------------------- | ---------------------- |
 * | `PgliteDatabase`      | always (in-process)     | always                 |
 * | `PgDatabase`          | only with `TEST_DATABASE_URL` | postgres:17 service |
 * | `MemoryKeyValue`      | always                  | always                 |
 * | `RedisKeyValue`       | only with `TEST_REDIS_URL`    | redis:7 service     |
 *
 * A missing backend **skips with a printed reason** rather than passing quietly. A suite that
 * silently runs nothing is worse than a red one.
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import { TestClock } from "../../src/clock.js";
import type { Database } from "../../src/ports/database.js";
import type { Broker, KeyValue } from "../../src/ports/keyvalue.js";
import { isUniqueViolation } from "../../src/ports/database.js";

export const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
export const TEST_REDIS_URL = process.env["TEST_REDIS_URL"];

/**
 * A namespace unique to this process, prefixed onto every key and channel the key-value and
 * broker contracts touch.
 *
 * Redis is shared and persistent, and these suites write keys with 30-60 second TTLs.
 * Namespacing per *test* is not enough: two runs against the same instance inside that window
 * reuse the same key names, so the second run finds the first run's values still live --
 * `setIfAbsent` returns false where it expects true, and `incrementInWindow` continues someone
 * else's count. CI hit exactly that when a second invocation of this file ran against the same
 * service container, and the failure looked like a broken adapter rather than a colliding test.
 *
 * Flushing between runs would be worse: it would wipe whatever else is using that Redis.
 */
const RUN_NAMESPACE = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Assertions every `Database` implementation must satisfy.
 *
 * `open` returns a fresh database; the suite creates and drops its own table so it can run
 * against a server that already holds the application schema.
 */
export const describeDatabaseContract = (
  label: string,
  open: () => Promise<Database>,
): void => {
  describe(`Database contract: ${label}`, () => {
    let database: Database;

    beforeAll(async () => {
      database = await open();
      await database.query(
        `create table if not exists contract_rows (
           id text primary key,
           n integer not null default 0,
           label text,
           at timestamptz not null default now()
         )`,
      );
    });

    afterAll(async () => {
      await database.query("drop table if exists contract_rows");
      await database.close();
    });

    beforeEach(async () => {
      await database.query("delete from contract_rows");
    });

    it("reports its kind", () => {
      expect(["pglite", "pg"]).toContain(database.kind);
    });

    it("round-trips parameters without interpolation", async () => {
      // The value contains a quote and a semicolon: if parameters were being interpolated rather
      // than bound, this is where it would show.
      const nasty = "o'brien; drop table contract_rows; --";
      await database.query(`insert into contract_rows (id, label) values ($1, $2)`, ["a", nasty]);
      const found = await database.query<{ label: string }>(
        `select label from contract_rows where id = $1`,
        ["a"],
      );
      expect(found.rows[0]?.label).toBe(nasty);
    });

    it("reports rowCount for writes", async () => {
      const inserted = await database.query(`insert into contract_rows (id) values ($1)`, ["a"]);
      expect(inserted.rowCount).toBe(1);

      const updated = await database.query(`update contract_rows set n = 1 where id = $1`, ["a"]);
      expect(updated.rowCount).toBe(1);

      const missed = await database.query(`update contract_rows set n = 2 where id = $1`, ["zz"]);
      expect(missed.rowCount).toBe(0);
    });

    it("returns typed values: integers as numbers, timestamps as Dates", async () => {
      await database.query(`insert into contract_rows (id, n) values ($1, $2)`, ["a", 42]);
      const found = await database.query<{ n: number; at: Date }>(
        `select n, at from contract_rows where id = $1`,
        ["a"],
      );
      expect(found.rows[0]?.n).toBe(42);
      expect(found.rows[0]?.at).toBeInstanceOf(Date);
    });

    it("commits a transaction", async () => {
      await database.transaction(async (tx) => {
        await tx.query(`insert into contract_rows (id) values ($1)`, ["a"]);
        await tx.query(`insert into contract_rows (id) values ($1)`, ["b"]);
      });
      const found = await database.query(`select id from contract_rows`);
      expect(found.rows).toHaveLength(2);
    });

    it("rolls back the whole transaction on a throw", async () => {
      await expect(
        database.transaction(async (tx) => {
          await tx.query(`insert into contract_rows (id) values ($1)`, ["a"]);
          throw new Error("deliberate");
        }),
      ).rejects.toThrow("deliberate");

      const found = await database.query(`select id from contract_rows`);
      expect(found.rows).toHaveLength(0);
    });

    it("rolls back on a constraint violation and stays usable", async () => {
      await database.query(`insert into contract_rows (id) values ($1)`, ["a"]);
      await expect(
        database.transaction(async (tx) => {
          await tx.query(`insert into contract_rows (id) values ($1)`, ["b"]);
          await tx.query(`insert into contract_rows (id) values ($1)`, ["a"]); // duplicate
        }),
      ).rejects.toSatisfy(isUniqueViolation);

      // "b" must be gone, and the connection must still work: a driver that leaves the session
      // in a failed transaction state would make every later query fail too.
      const found = await database.query(`select id from contract_rows order by id`);
      expect(found.rows.map((row) => row["id"])).toEqual(["a"]);
    });

    it("surfaces a unique violation as SQLSTATE 23505", async () => {
      await database.query(`insert into contract_rows (id) values ($1)`, ["a"]);
      await expect(
        database.query(`insert into contract_rows (id) values ($1)`, ["a"]),
      ).rejects.toSatisfy(isUniqueViolation);
    });

    it("returns the callback's value", async () => {
      const result = await database.transaction(async () => "value");
      expect(result).toBe("value");
    });

    it("supports returning clauses", async () => {
      const inserted = await database.query<{ id: string; n: number }>(
        `insert into contract_rows (id, n) values ($1, $2) returning id, n`,
        ["a", 7],
      );
      expect(inserted.rows[0]).toMatchObject({ id: "a", n: 7 });
    });

    it("implements optimistic concurrency through a version predicate", async () => {
      // The pattern the item update depends on: a conditional update reports zero rows rather
      // than overwriting.
      await database.query(`insert into contract_rows (id, n) values ($1, 1)`, ["a"]);

      const first = await database.query(
        `update contract_rows set n = n + 1 where id = $1 and n = $2`,
        ["a", 1],
      );
      expect(first.rowCount).toBe(1);

      const stale = await database.query(
        `update contract_rows set n = n + 1 where id = $1 and n = $2`,
        ["a", 1],
      );
      expect(stale.rowCount).toBe(0);
    });

    it("serialises transactions that lock the same row", async () => {
      // Two transactions increment the same row under `for update`. If locking did not hold, both
      // would read 0 and the result would be 1 instead of 2.
      await database.query(`insert into contract_rows (id, n) values ($1, 0)`, ["a"]);

      const increment = () =>
        database.transaction(async (tx) => {
          const found = await tx.query<{ n: number }>(
            `select n from contract_rows where id = $1 for update`,
            ["a"],
          );
          const next = (found.rows[0]?.n ?? 0) + 1;
          await tx.query(`update contract_rows set n = $1 where id = $2`, [next, "a"]);
        });

      await Promise.all([increment(), increment()]);
      const found = await database.query<{ n: number }>(
        `select n from contract_rows where id = $1`,
        ["a"],
      );
      expect(found.rows[0]?.n).toBe(2);
    });
  });
};

/** Assertions every `KeyValue` implementation must satisfy. */
export const describeKeyValueContract = (
  label: string,
  open: (clock: TestClock) => Promise<KeyValue>,
  options: { readonly controllableClock: boolean },
): void => {
  describe(`KeyValue contract: ${label}`, () => {
    let store: KeyValue;
    let clock: TestClock;
    let scope = 0;

    const key = (name: string): string =>
      `contract:${RUN_NAMESPACE}:${scope}:${name}`;

    beforeAll(async () => {
      clock = new TestClock(1_000_000);
      store = await open(clock);
    });

    afterAll(async () => {
      await store.close();
    });

    beforeEach(() => {
      // Keys are namespaced rather than deleted -- a flush would wipe whatever else is using
      // that instance. `scope` separates tests; RUN_NAMESPACE separates runs.
      scope += 1;
    });

    it("returns null for a missing key", async () => {
      expect(await store.get(key("missing"))).toBeNull();
    });

    it("stores and reads a value", async () => {
      await store.set(key("a"), "value", 60);
      expect(await store.get(key("a"))).toBe("value");
    });

    it("overwrites with set", async () => {
      await store.set(key("a"), "first", 60);
      await store.set(key("a"), "second", 60);
      expect(await store.get(key("a"))).toBe("second");
    });

    it("deletes", async () => {
      await store.set(key("a"), "value", 60);
      await store.del(key("a"));
      expect(await store.get(key("a"))).toBeNull();
    });

    it("deleting something absent is not an error", async () => {
      await expect(store.del(key("nope"))).resolves.toBeUndefined();
    });

    it("reports a ttl within a second of what was asked for", async () => {
      await store.set(key("a"), "value", 60);
      const ttl = await store.ttl(key("a"));
      expect(ttl).toBeGreaterThan(55);
      expect(ttl).toBeLessThanOrEqual(60);
    });

    it("reports -1 for a missing key's ttl", async () => {
      expect(await store.ttl(key("missing"))).toBe(-1);
    });

    it("setIfAbsent writes when the key is absent", async () => {
      expect(await store.setIfAbsent(key("a"), "first", 60)).toBe(true);
      expect(await store.get(key("a"))).toBe("first");
    });

    it("setIfAbsent refuses when the key is present, and does not overwrite", async () => {
      await store.set(key("a"), "first", 60);
      expect(await store.setIfAbsent(key("a"), "second", 60)).toBe(false);
      expect(await store.get(key("a"))).toBe("first");
    });

    it("exactly one of many concurrent setIfAbsent calls wins", async () => {
      // The property idempotent POST handling rests on. A `get` followed by a `set` passes every
      // sequential test and fails this one.
      const results = await Promise.all(
        Array.from({ length: 12 }, (_value, index) =>
          store.setIfAbsent(key("race"), `writer-${index}`, 60),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("counts within a window and reports the reset", async () => {
      const first = await store.incrementInWindow(key("rl"), 60);
      expect(first.count).toBe(1);
      expect(first.resetSeconds).toBeGreaterThan(0);
      expect(first.resetSeconds).toBeLessThanOrEqual(60);

      const second = await store.incrementInWindow(key("rl"), 60);
      expect(second.count).toBe(2);
    });

    it("does not extend the window on later increments", async () => {
      // A limiter that re-stamps the TTL on every increment never resets under sustained load,
      // so a client that trips it once stays locked out for as long as it keeps trying.
      const first = await store.incrementInWindow(key("rl"), 60);
      const second = await store.incrementInWindow(key("rl"), 60);
      expect(second.resetSeconds).toBeLessThanOrEqual(first.resetSeconds);
    });

    it("counts every increment under concurrency", async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => store.incrementInWindow(key("rl"), 60)),
      );
      expect(new Set(results.map((result) => result.count)).size).toBe(20);
      expect(Math.max(...results.map((result) => result.count))).toBe(20);
    });

    if (options.controllableClock) {
      // These need time to move without waiting for it. Against real Redis the clock is the
      // server's, so they are skipped there rather than replaced with sleeps -- a 61-second test
      // would not be run by anyone.
      it("expires a value", async () => {
        await store.set(key("a"), "value", 30);
        clock.advanceSeconds(31);
        expect(await store.get(key("a"))).toBeNull();
        expect(await store.ttl(key("a"))).toBe(-1);
      });

      it("treats an expired key as absent for setIfAbsent", async () => {
        // Redis expires lazily, so a Map-based implementation that only checks `has()` would
        // refuse a write that real Redis allows.
        await store.set(key("a"), "first", 30);
        clock.advanceSeconds(31);
        expect(await store.setIfAbsent(key("a"), "second", 30)).toBe(true);
        expect(await store.get(key("a"))).toBe("second");
      });

      it("resets the counter once the window elapses", async () => {
        await store.incrementInWindow(key("rl"), 30);
        await store.incrementInWindow(key("rl"), 30);
        clock.advanceSeconds(31);
        expect((await store.incrementInWindow(key("rl"), 30)).count).toBe(1);
      });
    }
  });
};

/** Assertions every `Broker` implementation must satisfy. */
export const describeBrokerContract = (label: string, open: () => Promise<Broker>): void => {
  describe(`Broker contract: ${label}`, () => {
    let broker: Broker;
    let scope = 0;
    const channel = (name: string): string =>
      `contract:${RUN_NAMESPACE}:${scope}:${name}`;

    /** Redis delivery is asynchronous, so every assertion waits for it rather than assuming. */
    const settle = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, broker.kind === "redis" ? 60 : 0));
    };

    beforeAll(async () => {
      broker = await open();
    });

    afterAll(async () => {
      await broker.close();
    });

    beforeEach(() => {
      scope += 1;
    });

    it("delivers to a subscriber", async () => {
      const received: string[] = [];
      await broker.subscribe(channel("a"), (message) => received.push(message));
      await broker.publish(channel("a"), "hello");
      await settle();
      expect(received).toEqual(["hello"]);
    });

    it("delivers to every subscriber on the channel", async () => {
      const first: string[] = [];
      const second: string[] = [];
      await broker.subscribe(channel("a"), (message) => first.push(message));
      await broker.subscribe(channel("a"), (message) => second.push(message));
      await broker.publish(channel("a"), "hello");
      await settle();
      expect(first).toEqual(["hello"]);
      expect(second).toEqual(["hello"]);
    });

    it("does not deliver across channels", async () => {
      // The authorization boundary: a socket not subscribed to a workspace must not be able to
      // receive its events at all.
      const received: string[] = [];
      await broker.subscribe(channel("a"), (message) => received.push(message));
      await broker.publish(channel("b"), "hello");
      await settle();
      expect(received).toEqual([]);
    });

    it("stops delivering after unsubscribe", async () => {
      const received: string[] = [];
      const unsubscribe = await broker.subscribe(channel("a"), (message) => received.push(message));
      await unsubscribe();
      await broker.publish(channel("a"), "hello");
      await settle();
      expect(received).toEqual([]);
    });

    it("one unsubscribe does not silence a sibling on the same channel", async () => {
      // The bug this catches: leaving the underlying Redis channel as soon as any handler
      // unsubscribes, which stops delivery to the handlers still registered.
      const staying: string[] = [];
      const leaving: string[] = [];
      await broker.subscribe(channel("a"), (message) => staying.push(message));
      const unsubscribe = await broker.subscribe(channel("a"), (message) => leaving.push(message));
      await unsubscribe();
      await broker.publish(channel("a"), "hello");
      await settle();
      expect(staying).toEqual(["hello"]);
      expect(leaving).toEqual([]);
    });

    it("unsubscribing twice is not an error", async () => {
      const unsubscribe = await broker.subscribe(channel("a"), () => undefined);
      await unsubscribe();
      await expect(unsubscribe()).resolves.toBeUndefined();
    });

    it("publishing to nobody is not an error", async () => {
      await expect(broker.publish(channel("empty"), "hello")).resolves.toBeUndefined();
    });

    it("preserves publication order", async () => {
      const received: string[] = [];
      await broker.subscribe(channel("a"), (message) => received.push(message));
      for (const message of ["1", "2", "3"]) await broker.publish(channel("a"), message);
      await settle();
      expect(received).toEqual(["1", "2", "3"]);
    });

    it("a handler that unsubscribes itself does not skip a sibling", async () => {
      // Mutating the handler set while iterating it would drop whichever handler came next.
      const order: string[] = [];
      const unsubscribe = await broker.subscribe(channel("a"), () => {
        order.push("self-removing");
        void unsubscribe();
      });
      await broker.subscribe(channel("a"), () => order.push("sibling"));
      await broker.publish(channel("a"), "hello");
      await settle();
      expect(order).toContain("self-removing");
      expect(order).toContain("sibling");
    });
  });
};
