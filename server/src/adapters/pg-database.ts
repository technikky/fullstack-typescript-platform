/**
 * PostgreSQL over the wire, via a connection pool.
 *
 * What this covers that the in-process engine cannot: the wire protocol, pooling, and real
 * concurrency across connections. The SQL text is identical -- there is no dialect layer --
 * so the contract suite is the same file, run twice.
 *
 * Unavailable locally on the machine this was developed on (no server, no Docker), so it is
 * exercised by CI against a `postgres:17` service container. The README says which numbers
 * came from which adapter rather than implying both were measured here.
 */

import { Pool, type PoolClient } from "pg";

import type { Database, QueryResult, Queryable, SqlValue } from "../ports/database.js";

export interface PgOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
  /**
   * Postgres kills a connection that sits inside a transaction doing nothing, which is what
   * a deadlocked request looks like. Default 30s so a stuck handler fails rather than
   * holding a row lock forever.
   */
  readonly idleInTransactionSessionTimeout?: number;
}

export class PgDatabase implements Database {
  readonly kind = "pg" as const;
  readonly #pool: Pool;

  constructor(options: PgOptions) {
    this.#pool = new Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
      idle_in_transaction_session_timeout: options.idleInTransactionSessionTimeout ?? 30_000,
    });
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<QueryResult<Row>> {
    const result = await this.#pool.query(sql, params as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? result.rows.length };
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    // Checked out explicitly. Issuing the transaction's statements against the pool would
    // scatter them across connections, and the rollback would not undo the ones that landed
    // elsewhere.
    const client: PoolClient = await this.#pool.connect();
    try {
      await client.query("begin");
      const result = await work({
        query: async (sql, params) => {
          const raw = await client.query(sql, (params ?? []) as unknown[]);
          return { rows: raw.rows, rowCount: raw.rowCount ?? raw.rows.length };
        },
      });
      await client.query("commit");
      return result;
    } catch (thrown) {
      // A failed rollback must not mask the original error: the connection is about to be
      // destroyed anyway, and the caller needs to see what actually went wrong.
      await client.query("rollback").catch(() => undefined);
      throw thrown;
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.#pool.query(sql);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
