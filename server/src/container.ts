/**
 * Dependency wiring.
 *
 * One place where adapters are chosen, so the choice is visible instead of scattered through
 * `if (process.env.REDIS_URL)` checks at the point of use. Two consequences that matter:
 *
 * - A test builds a container with the in-process database and the in-memory key-value store and
 *   a `TestClock`, and everything downstream is unchanged. No mocking framework, no module
 *   interception, no `vi.mock`.
 * - Startup announces which adapters it picked. A production process that quietly fell back to
 *   an in-memory store would pass its health check and lose every rate limit and revocation on
 *   restart, so the fallback is logged and `loadConfig` refuses it in production outright.
 */

import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { Config } from "./config.js";
import { MemoryBroker, MemoryKeyValue } from "./adapters/memory-keyvalue.js";
import { PgDatabase } from "./adapters/pg-database.js";
import { PgliteDatabase } from "./adapters/pglite-database.js";
import { RedisBroker, RedisKeyValue } from "./adapters/redis-keyvalue.js";
import { migrate } from "./db/migrate.js";
import { AccountService } from "./domain/accounts.js";
import { WorkService } from "./domain/work.js";
import { WorkspaceService } from "./domain/workspaces.js";
import type { Database } from "./ports/database.js";
import type { Broker, KeyValue } from "./ports/keyvalue.js";
import { TokenService } from "./auth/tokens.js";
import { IdempotencyStore, RateLimiter } from "./http/ratelimit.js";
import { RealtimeHub } from "./realtime/hub.js";

export interface Container {
  readonly config: Config;
  readonly clock: Clock;
  readonly database: Database;
  readonly keyValue: KeyValue;
  readonly broker: Broker;
  readonly tokens: TokenService;
  readonly accounts: AccountService;
  readonly workspaces: WorkspaceService;
  readonly work: WorkService;
  readonly rateLimiter: RateLimiter;
  readonly idempotency: IdempotencyStore;
  readonly hub: RealtimeHub;
  /** What was actually selected, for the startup log and the health endpoint. */
  readonly adapters: { database: string; keyValue: string; broker: string };
  close(): Promise<void>;
}

export interface BuildOptions {
  readonly config: Config;
  readonly clock?: Clock;
  /** Supplied by tests; otherwise chosen from the config. */
  readonly database?: Database;
  readonly keyValue?: KeyValue;
  readonly broker?: Broker;
  /** Apply the schema on startup. Off for a database a test has already migrated. */
  readonly migrateOnStart?: boolean;
}

export const buildContainer = async (options: BuildOptions): Promise<Container> => {
  const { config } = options;
  const clock = options.clock ?? systemClock;

  const database =
    options.database ??
    (config.databaseUrl === null
      ? await PgliteDatabase.open()
      : new PgDatabase({ connectionString: config.databaseUrl }));

  const keyValue =
    options.keyValue ??
    (config.redisUrl === null ? new MemoryKeyValue(clock) : new RedisKeyValue(config.redisUrl));

  const broker =
    options.broker ?? (config.redisUrl === null ? new MemoryBroker() : new RedisBroker(config.redisUrl));

  if (options.migrateOnStart !== false) await migrate(database);

  const tokens = new TokenService({
    database,
    keyValue,
    clock,
    config: {
      secret: config.jwt.secret,
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
      accessTtlMillis: config.jwt.accessTtlMillis,
      refreshTtlMillis: config.jwt.refreshTtlMillis,
    },
  });

  const accounts = new AccountService({ database, tokens, clock });
  const workspaces = new WorkspaceService({ database, clock });
  const work = new WorkService({ database, clock, workspaces });
  const hub = new RealtimeHub({ broker, tokens, workspaces, clock });

  return {
    config,
    clock,
    database,
    keyValue,
    broker,
    tokens,
    accounts,
    workspaces,
    work,
    rateLimiter: new RateLimiter(keyValue),
    idempotency: new IdempotencyStore(keyValue, clock),
    hub,
    adapters: { database: database.kind, keyValue: keyValue.kind, broker: broker.kind },
    // Closed in reverse dependency order, and every close is attempted even if an earlier one
    // throws -- a failed Redis quit must not leave a Postgres pool open and the process hanging.
    close: async () => {
      const results = await Promise.allSettled([
        hub.closeAll(),
        broker.close(),
        keyValue.close(),
        database.close(),
      ]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure !== undefined && failure.status === "rejected") throw failure.reason;
    },
  };
};
