/**
 * Every adapter, against its port's contract suite.
 *
 * The suites themselves live in `tests/support/contracts.ts`. This file only decides which
 * implementations to run them against, based on what is reachable. Adapters that need a server
 * are **skipped with a printed reason** rather than passing silently, so a run that covered less
 * than it looks like says so.
 *
 * Locally, this means: in-process PostgreSQL 17 and the in-memory key-value store and broker. In
 * CI, `TEST_DATABASE_URL` and `TEST_REDIS_URL` point at service containers and the same
 * assertions run against `pg` and `ioredis` too.
 */

import { describe, expect, it } from "vitest";

import { MemoryBroker, MemoryKeyValue } from "../src/adapters/memory-keyvalue.js";
import { PgDatabase } from "../src/adapters/pg-database.js";
import { PgliteDatabase } from "../src/adapters/pglite-database.js";
import { RedisBroker, RedisKeyValue } from "../src/adapters/redis-keyvalue.js";
import { readSchema } from "../src/db/migrate.js";
import {
  TEST_DATABASE_URL,
  TEST_REDIS_URL,
  describeBrokerContract,
  describeDatabaseContract,
  describeKeyValueContract,
} from "./support/contracts.js";

// --- always available -------------------------------------------------------------

describeDatabaseContract("pglite (in-process PostgreSQL 17)", async () => PgliteDatabase.open());

describeKeyValueContract("memory", async (clock) => new MemoryKeyValue(clock), {
  controllableClock: true,
});

describeBrokerContract("memory", async () => new MemoryBroker());

// --- only with a server -----------------------------------------------------------

if (TEST_DATABASE_URL === undefined) {
  describe.skip("Database contract: pg (needs TEST_DATABASE_URL)", () => {
    it("skipped", () => undefined);
  });
} else {
  // Copied to a local const: narrowing an imported binding does not reach inside a closure.
  const url = TEST_DATABASE_URL;
  describeDatabaseContract(
    "pg (server over the wire)",
    async () => new PgDatabase({ connectionString: url }),
  );
}

if (TEST_REDIS_URL === undefined) {
  describe.skip("KeyValue contract: redis (needs TEST_REDIS_URL)", () => {
    it("skipped", () => undefined);
  });
  describe.skip("Broker contract: redis (needs TEST_REDIS_URL)", () => {
    it("skipped", () => undefined);
  });
} else {
  const url = TEST_REDIS_URL;
  describeKeyValueContract("redis", async () => new RedisKeyValue(url), {
    // Real Redis uses the server's clock, so the expiry assertions are skipped there rather than
    // rewritten as sleeps: a 61-second test is a test nobody runs.
    controllableClock: false,
  });
  describeBrokerContract("redis", async () => new RedisBroker(url));
}

// --- the schema itself ------------------------------------------------------------

describe("the application schema", () => {
  it("applies to a fresh database, and applying it twice is a no-op", async () => {
    // Every statement is `if not exists`, which is what lets the same file serve a new database
    // and an existing one. If that stopped being true, a redeploy would fail on startup.
    const database = await PgliteDatabase.open();
    try {
      const schema = await readSchema();
      await database.exec(schema);
      await expect(database.exec(schema)).resolves.toBeUndefined();
    } finally {
      await database.close();
    }
  });

  it("enforces one role per user per workspace", async () => {
    const database = await PgliteDatabase.open();
    try {
      await database.exec(await readSchema());
      await database.query(
        `insert into users (id, email, name, password_hash) values ('u1', 'a@b.test', 'A', 'x')`,
      );
      await database.query(
        `insert into workspaces (id, name, slug, created_by) values ('w1', 'W', 'w', 'u1')`,
      );
      await database.query(
        `insert into memberships (id, workspace_id, user_id, role) values ('m1', 'w1', 'u1', 'owner')`,
      );

      // Without the unique constraint, "what is my role here" would have two answers.
      await expect(
        database.query(
          `insert into memberships (id, workspace_id, user_id, role) values ('m2', 'w1', 'u1', 'viewer')`,
        ),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });

  it("rejects an unknown role", async () => {
    const database = await PgliteDatabase.open();
    try {
      await database.exec(await readSchema());
      await database.query(
        `insert into users (id, email, name, password_hash) values ('u1', 'a@b.test', 'A', 'x')`,
      );
      await database.query(
        `insert into workspaces (id, name, slug, created_by) values ('w1', 'W', 'w', 'u1')`,
      );
      await expect(
        database.query(
          `insert into memberships (id, workspace_id, user_id, role) values ('m1', 'w1', 'u1', 'superuser')`,
        ),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });

  it("treats email uniqueness as case-insensitive", async () => {
    const database = await PgliteDatabase.open();
    try {
      await database.exec(await readSchema());
      await database.query(
        `insert into users (id, email, name, password_hash) values ('u1', 'user@b.test', 'A', 'x')`,
      );
      // The application normalises before inserting; the index is the backstop for a path that
      // forgets to.
      await expect(
        database.query(
          `insert into users (id, email, name, password_hash) values ('u2', 'USER@B.test', 'B', 'x')`,
        ),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });

  it("cascades a workspace delete to its boards, items and comments", async () => {
    const database = await PgliteDatabase.open();
    try {
      await database.exec(await readSchema());
      await database.query(
        `insert into users (id, email, name, password_hash) values ('u1', 'a@b.test', 'A', 'x')`,
      );
      await database.query(
        `insert into workspaces (id, name, slug, created_by) values ('w1', 'W', 'w', 'u1')`,
      );
      await database.query(
        `insert into boards (id, workspace_id, name, created_by) values ('b1', 'w1', 'B', 'u1')`,
      );
      await database.query(
        `insert into items (id, board_id, title, created_by) values ('i1', 'b1', 'T', 'u1')`,
      );
      await database.query(
        `insert into comments (id, item_id, author_id, body) values ('c1', 'i1', 'u1', 'hi')`,
      );

      await database.query(`delete from workspaces where id = 'w1'`);

      // An orphaned board would still be returned by a query that joins from the board down,
      // which is how deleted data reappears.
      for (const table of ["boards", "items", "comments"]) {
        const found = await database.query(`select 1 from ${table}`);
        expect(found.rows, `${table} kept rows after the workspace was deleted`).toHaveLength(0);
      }
    } finally {
      await database.close();
    }
  });

  it("nulls an item's assignee when that user is deleted rather than deleting the item", async () => {
    const database = await PgliteDatabase.open();
    try {
      await database.exec(await readSchema());
      for (const [id, email] of [
        ["u1", "a@b.test"],
        ["u2", "c@d.test"],
      ] as const) {
        await database.query(
          `insert into users (id, email, name, password_hash) values ($1, $2, 'N', 'x')`,
          [id, email],
        );
      }
      await database.query(
        `insert into workspaces (id, name, slug, created_by) values ('w1', 'W', 'w', 'u1')`,
      );
      await database.query(
        `insert into boards (id, workspace_id, name, created_by) values ('b1', 'w1', 'B', 'u1')`,
      );
      await database.query(
        `insert into items (id, board_id, title, created_by, assignee_id)
         values ('i1', 'b1', 'T', 'u1', 'u2')`,
      );

      await database.query(`delete from users where id = 'u2'`);

      // `on delete set null`, not cascade: an offboarded employee must not take the team's work
      // items with them.
      const found = await database.query<{ assignee_id: string | null }>(
        `select assignee_id from items where id = 'i1'`,
      );
      expect(found.rows).toHaveLength(1);
      expect(found.rows[0]?.assignee_id).toBeNull();
    } finally {
      await database.close();
    }
  });

  it("rejects a version below 1", async () => {
    const database = await PgliteDatabase.open();
    try {
      await database.exec(await readSchema());
      await database.query(
        `insert into users (id, email, name, password_hash) values ('u1', 'a@b.test', 'A', 'x')`,
      );
      await database.query(
        `insert into workspaces (id, name, slug, created_by) values ('w1', 'W', 'w', 'u1')`,
      );
      await database.query(
        `insert into boards (id, workspace_id, name, created_by) values ('b1', 'w1', 'B', 'u1')`,
      );
      await expect(
        database.query(
          `insert into items (id, board_id, title, created_by, version)
           values ('i1', 'b1', 'T', 'u1', 0)`,
        ),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });

  it("refuses a refresh token hash that is already stored", async () => {
    const database = await PgliteDatabase.open();
    try {
      await database.exec(await readSchema());
      await database.query(
        `insert into users (id, email, name, password_hash) values ('u1', 'a@b.test', 'A', 'x')`,
      );
      const insert = `insert into refresh_tokens (id, family_id, user_id, token_hash, expires_at)
                      values ($1, 'f1', 'u1', 'same-hash', now() + interval '1 day')`;
      await database.query(insert, ["t1"]);
      // Two live tokens with one hash would make reuse detection ambiguous.
      await expect(database.query(insert, ["t2"])).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});
