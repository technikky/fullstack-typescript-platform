/**
 * The SQL port.
 *
 * Deliberately thin: parameterised queries and transactions, nothing else. There is no query
 * builder and no ORM, because the interesting failures in this codebase are in SQL that a
 * builder would hide -- `for update` in the membership check, the `where version = $n`
 * clause that implements optimistic concurrency, the partial unique index that stops two
 * active owners' rows from colliding.
 *
 * Two implementations satisfy it, and one contract suite runs against both:
 *
 * - `PgliteDatabase` runs PostgreSQL 17 compiled to WebAssembly, in-process. No server, no
 *   container, no port. This is what makes the SQL genuinely executed in local test runs
 *   rather than mocked.
 * - `PgDatabase` speaks the wire protocol to a real server, which is what production uses and
 *   what CI runs the same contract suite against.
 *
 * Both are PostgreSQL, so this is not a lowest-common-denominator abstraction: the SQL is the
 * same text in both cases. The port exists to make the *connection* swappable, not the
 * dialect.
 */

export type SqlValue = string | number | boolean | Date | null | Buffer | SqlValue[];

export interface QueryResult<Row> {
  readonly rows: Row[];
  /** Rows affected by an INSERT/UPDATE/DELETE. `pg` and pglite both report this. */
  readonly rowCount: number;
}

export interface Queryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<QueryResult<Row>>;
}

export interface Database extends Queryable {
  /**
   * Run `work` inside a transaction, committing on return and rolling back on throw.
   *
   * The callback receives a `Queryable` bound to the transaction's connection, not the pool.
   * That distinction is the whole point: issuing a query against the pool from inside a
   * transaction silently runs it on a different connection, outside the transaction, and the
   * rollback then does not undo it.
   */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Human-readable label for logs and for the contract suite's test names. */
  readonly kind: "pglite" | "pg";
  close(): Promise<void>;
}

/** A unique-violation, whichever driver raised it. */
export const isUniqueViolation = (thrown: unknown): boolean =>
  typeof thrown === "object" &&
  thrown !== null &&
  "code" in thrown &&
  (thrown as { code?: unknown }).code === "23505";

/** A foreign-key violation, whichever driver raised it. */
export const isForeignKeyViolation = (thrown: unknown): boolean =>
  typeof thrown === "object" &&
  thrown !== null &&
  "code" in thrown &&
  (thrown as { code?: unknown }).code === "23503";
