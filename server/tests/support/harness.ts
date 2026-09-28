/**
 * Test harness.
 *
 * Every suite builds a real container: real PostgreSQL (in-process), real Fastify routing, real
 * JWT signing, real scrypt. Nothing is mocked. The only substitutions are the ones that make the
 * tests fast and deterministic rather than the ones that make them easier to pass:
 *
 * - The key-value store and broker are the in-memory adapters, which are held to the same
 *   contract suite as the Redis ones.
 * - The clock is a `TestClock`, so token expiry and rate-limit windows are exact instead of
 *   approximated with `setTimeout`.
 * - scrypt parameters are lowered. The production cost is deliberately ~100 ms per hash, and this
 *   suite registers dozens of users; at OWASP parameters the suite would take minutes and nobody
 *   would run it. `tests/password.test.ts` verifies the real parameters separately, so the
 *   expensive path is still covered once rather than per fixture.
 */

import { readFile } from "node:fs/promises";

import { TestClock } from "../../src/clock.js";
import type { Config } from "../../src/config.js";
import { buildContainer, type Container } from "../../src/container.js";
import { MemoryBroker, MemoryKeyValue } from "../../src/adapters/memory-keyvalue.js";
import { PgliteDatabase } from "../../src/adapters/pglite-database.js";
import { schemaPath, truncateAll } from "../../src/db/migrate.js";
import { buildApp } from "../../src/http/app.js";
import { hashPassword, type ScryptParams } from "../../src/auth/password.js";
import type { FastifyInstance } from "fastify";
import type { Role } from "../../src/authz/policy.js";

/** Cheap enough for fixtures; the real parameters are tested on their own. */
export const TEST_SCRYPT: ScryptParams = { N: 1024, r: 8, p: 1, keylen: 32 };

/** A fixed start so ids and timestamps in failure output are stable across runs. */
export const EPOCH = Date.UTC(2026, 0, 15, 9, 0, 0);

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  nodeEnv: "test",
  port: 0,
  host: "127.0.0.1",
  jwt: {
    secret: new TextEncoder().encode("test-secret-that-is-long-enough-for-hs256-aaaa"),
    issuer: "platform-test",
    audience: "platform-test-api",
    accessTtlMillis: 10 * 60 * 1000,
    refreshTtlMillis: 30 * 24 * 60 * 60 * 1000,
  },
  databaseUrl: null,
  redisUrl: null,
  rateLimit: { windowSeconds: 60, maxRequests: 10_000, authMaxRequests: 10_000 },
  corsOrigins: ["http://localhost:3000"],
  logLevel: "silent",
  bodyLimitBytes: 256 * 1024,
  ...overrides,
});

export interface Harness {
  readonly container: Container;
  readonly app: FastifyInstance;
  readonly clock: TestClock;
  readonly keyValue: MemoryKeyValue;
  readonly broker: MemoryBroker;
  /** Empty every table without rebuilding the schema. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * One database and one Fastify instance per suite file, reused across tests.
 *
 * Booting PostgreSQL costs a second or two; doing it per test would make the suite unpleasant
 * enough to skip. `reset()` truncates between tests instead, which is both faster and a stronger
 * guarantee than dropping and recreating: a test that leaks state into another fails loudly.
 */
export const createHarness = async (
  configOverrides: Partial<Config> = {},
): Promise<Harness> => {
  const clock = new TestClock(EPOCH);
  const database = await PgliteDatabase.open();
  await database.exec(await readFile(schemaPath(), "utf8"));

  const keyValue = new MemoryKeyValue(clock);
  const broker = new MemoryBroker();
  const config = testConfig(configOverrides);

  const container = await buildContainer({
    config,
    clock,
    database,
    keyValue,
    broker,
    migrateOnStart: false,
  });
  const app = await buildApp({ container, logger: false });
  await app.ready();

  return {
    container,
    app,
    clock,
    keyValue,
    broker,
    reset: async () => {
      await truncateAll(database);
      await keyValue.close();
      clock.set(EPOCH);
    },
    close: async () => {
      await app.close();
      await container.close();
    },
  };
};

export interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly password: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** `Authorization` header value, ready to spread into an inject call. */
  readonly auth: { authorization: string };
}

let counter = 0;

/**
 * Register a user directly against the database, bypassing the HTTP route.
 *
 * Deliberately not `POST /api/auth/register`: that path would pay full scrypt cost per fixture
 * and would consume the auth rate-limit budget, so a test about something else would start
 * failing once it created its eleventh user.
 */
export const createUser = async (
  harness: Harness,
  overrides: { email?: string; name?: string; password?: string } = {},
): Promise<TestUser> => {
  counter += 1;
  const email = overrides.email ?? `user${counter}@example.test`;
  const name = overrides.name ?? `User ${counter}`;
  const password = overrides.password ?? "correct-horse-battery-staple";

  const id = `usr_TEST${String(counter).padStart(6, "0")}${"A".repeat(16)}`.slice(0, 30);
  await harness.container.database.query(
    `insert into users (id, email, name, password_hash, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $5)`,
    [id, email.toLowerCase(), name, await hashPassword(password, TEST_SCRYPT), new Date(harness.clock.now())],
  );

  const tokens = await harness.container.tokens.issue(id);
  return {
    id,
    email,
    name,
    password,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    auth: { authorization: `Bearer ${tokens.accessToken}` },
  };
};

/** A workspace owned by `owner`, with the given members already added at their roles. */
export const createWorkspace = async (
  harness: Harness,
  owner: TestUser,
  members: ReadonlyArray<{ user: TestUser; role: Role }> = [],
): Promise<{ id: string; name: string }> => {
  const view = await harness.container.workspaces.create(owner.id, `Workspace ${++counter}`);
  for (const { user, role } of members) {
    // Inserted directly rather than through `addMember`: several tests need a viewer or a member
    // in place before exercising the permission that would have been required to add them.
    await harness.container.database.query(
      `insert into memberships (id, workspace_id, user_id, role, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $5)`,
      [
        `mbr_TEST${String(++counter).padStart(6, "0")}${"A".repeat(16)}`.slice(0, 30),
        view.workspace.id,
        user.id,
        role,
        new Date(harness.clock.now()),
      ],
    );
  }
  return { id: view.workspace.id, name: view.workspace.name };
};

export const createBoard = async (
  harness: Harness,
  workspaceId: string,
  actor: TestUser,
  name = "Board",
): Promise<{ id: string }> => {
  const { EventBuffer } = await import("../../src/domain/events.js");
  const board = await harness.container.work.createBoard(
    workspaceId,
    actor.id,
    name,
    new EventBuffer(),
  );
  return { id: board.id };
};

export const createItem = async (
  harness: Harness,
  boardId: string,
  actor: TestUser,
  title = "Item",
): Promise<{ id: string; version: number }> => {
  const { EventBuffer } = await import("../../src/domain/events.js");
  const item = await harness.container.work.createItem(
    boardId,
    actor.id,
    { title },
    new EventBuffer(),
  );
  return { id: item.id, version: item.version };
};

/** Parse a JSON response body, failing the test with the raw payload if it is not JSON. */
export const json = <T = Record<string, unknown>>(payload: string): T => {
  try {
    return JSON.parse(payload) as T;
  } catch {
    throw new Error(`expected JSON, got: ${payload.slice(0, 400)}`);
  }
};

/** Run a GraphQL document through the HTTP endpoint, as a client would. */
export const graphql = async (
  harness: Harness,
  user: TestUser | null,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<{ status: number; data: unknown; errors: Array<{ message: string; extensions?: { code?: string } }> }> => {
  const response = await harness.app.inject({
    method: "POST",
    url: "/graphql",
    ...(user === null ? {} : { headers: user.auth }),
    payload: { query, variables },
  });
  const body = json<{ data?: unknown; errors?: Array<{ message: string; extensions?: { code?: string } }> }>(
    response.payload,
  );
  return { status: response.statusCode, data: body.data ?? null, errors: body.errors ?? [] };
};
