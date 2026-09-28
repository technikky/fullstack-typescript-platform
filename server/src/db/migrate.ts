/**
 * Schema application.
 *
 * `schema.sql` is written with `if not exists` throughout, so applying it repeatedly is safe
 * and the same file serves a fresh database and an existing one. That is enough for a platform
 * at this stage and it is honest about its limits: it creates, it does not alter. A real
 * migration history -- ordered, recorded, irreversible-by-default -- is the next thing this
 * would need, and `docs/operations.md` says so rather than pretending a single idempotent
 * script is a migration tool.
 *
 * The file is read at runtime rather than inlined as a string so that the SQL stays editable
 * as SQL, with syntax highlighting and a linter, and so a schema change is a diff in a `.sql`
 * file rather than a diff in an escaped template literal.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Database } from "../ports/database.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export const schemaPath = (): string => join(HERE, "schema.sql");

export const readSchema = async (): Promise<string> => readFile(schemaPath(), "utf8");

/** Tables the schema owns, in dependency order. Used by `truncateAll`. */
export const TABLES = [
  "audit_log",
  "refresh_tokens",
  "comments",
  "items",
  "boards",
  "memberships",
  "workspaces",
  "users",
] as const;

export const migrate = async (database: Database): Promise<void> => {
  const sql = await readSchema();
  // Executed as one statement batch rather than split on semicolons: a naive split breaks on
  // a semicolon inside a string literal or a function body, and this file contains check
  // constraints with quoted values.
  if ("exec" in database && typeof (database as { exec?: unknown }).exec === "function") {
    await (database as unknown as { exec(sql: string): Promise<void> }).exec(sql);
    return;
  }
  await database.query(sql);
};

/**
 * Empty every table, for tests that want a clean database without paying to rebuild the
 * schema.
 *
 * One `truncate` naming all tables, because truncating them one at a time fails on the
 * foreign keys between them. `restart identity` is harmless here (no sequences) and is kept so
 * the statement stays correct if one is ever added.
 */
export const truncateAll = async (database: Database): Promise<void> => {
  await database.query(`truncate table ${TABLES.join(", ")} restart identity cascade`);
};
