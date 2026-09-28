/**
 * PostgreSQL 17, compiled to WebAssembly, running inside the Node process.
 *
 * This is not a fake or a SQLite substitution -- it is the PostgreSQL engine, so `jsonb`,
 * `timestamptz`, partial unique indexes, `for update`, `on conflict` and the exact SQLSTATE
 * codes all behave as they do on a server. What it does not exercise is the wire protocol,
 * connection pooling and concurrency across connections; `PgDatabase` covers those, and the
 * same contract suite runs against both.
 *
 * The practical consequence is that the whole test suite runs offline, with no container and
 * no port, while still executing real SQL.
 */

import { PGlite } from "@electric-sql/pglite";

import type { Database, QueryResult, Queryable, SqlValue } from "../ports/database.js";

interface PgliteResult {
  rows: unknown[];
  affectedRows?: number;
}

const toResult = <Row>(raw: PgliteResult): QueryResult<Row> => ({
  rows: raw.rows as Row[],
  rowCount: raw.affectedRows ?? raw.rows.length,
});

export class PgliteDatabase implements Database {
  readonly kind = "pglite" as const;
  readonly #pg: PGlite;
  /**
   * pglite is a single connection, so two overlapping transactions on it would interleave
   * their statements into one. Transactions are therefore serialised through this promise
   * chain. That is a property of the in-process engine, not of the design: `PgDatabase` uses
   * a pool and runs them concurrently.
   */
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(pg: PGlite) {
    this.#pg = pg;
  }

  static async open(dataDir?: string): Promise<PgliteDatabase> {
    const pg = dataDir === undefined ? new PGlite() : new PGlite(dataDir);
    await pg.waitReady;
    return new PgliteDatabase(pg);
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<QueryResult<Row>> {
    const raw = (await this.#pg.query(sql, params as unknown[])) as PgliteResult;
    return toResult<Row>(raw);
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.#pg.exec("begin");
      try {
        const result = await work({
          query: (sql, params) => this.query(sql, params),
        });
        await this.#pg.exec("commit");
        return result;
      } catch (thrown) {
        await this.#pg.exec("rollback");
        throw thrown;
      }
    };

    const queued = this.#tail.then(run, run);
    // Swallow on the chain only: the caller still sees the rejection through `queued`.
    this.#tail = queued.catch(() => undefined);
    return queued;
  }

  /** Run a multi-statement script, such as the schema. */
  async exec(sql: string): Promise<void> {
    await this.#pg.exec(sql);
  }

  async close(): Promise<void> {
    await this.#pg.close();
  }
}
