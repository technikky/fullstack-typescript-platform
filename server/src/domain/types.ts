/**
 * Domain types, and the row-to-entity mapping.
 *
 * The mapping is explicit rather than a spread of the database row. Two reasons, both of which
 * have bitten this codebase:
 *
 * - `users` rows carry `password_hash`. A handler that spreads a row into a response leaks it,
 *   and no type error catches that because both are strings. Naming every field means the hash
 *   has to be asked for by name to escape.
 * - Postgres returns `snake_case` and `Date` objects; the API speaks `camelCase` and ISO
 *   strings. Converting at one boundary means the rest of the codebase never has to know which
 *   convention it is holding.
 */

import type { Role } from "../authz/policy.js";

export const ITEM_STATUSES = ["open", "in_progress", "blocked", "done"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: string;
}

/** Only ever constructed inside the auth flow; never serialised. */
export interface UserWithSecret extends User {
  readonly passwordHash: string;
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface Membership {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: Role;
  readonly createdAt: string;
}

export interface MemberSummary extends Membership {
  readonly email: string;
  readonly name: string;
}

export interface Board {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface Item {
  readonly id: string;
  readonly boardId: string;
  readonly title: string;
  readonly body: string;
  readonly status: ItemStatus;
  readonly assigneeId: string | null;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Comment {
  readonly id: string;
  readonly itemId: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface AuditEntry {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly actorId: string | null;
  readonly action: string;
  readonly subject: string | null;
  readonly metadata: Record<string, unknown>;
  readonly at: string;
}

// --- row shapes -------------------------------------------------------------------

export interface UserRow extends Record<string, unknown> {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: Date;
}

export interface WorkspaceRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  created_by: string;
  created_at: Date;
}

export interface MembershipRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  user_id: string;
  role: Role;
  created_at: Date;
}

export interface MemberRow extends MembershipRow {
  email: string;
  name: string;
}

export interface BoardRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  name: string;
  created_by: string;
  created_at: Date;
}

export interface ItemRow extends Record<string, unknown> {
  id: string;
  board_id: string;
  title: string;
  body: string;
  status: ItemStatus;
  assignee_id: string | null;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface CommentRow extends Record<string, unknown> {
  id: string;
  item_id: string;
  author_id: string;
  body: string;
  created_at: Date;
}

export interface AuditRow extends Record<string, unknown> {
  id: string;
  workspace_id: string | null;
  actor_id: string | null;
  action: string;
  subject: string | null;
  metadata: Record<string, unknown>;
  at: Date;
}

// --- mappers ----------------------------------------------------------------------

/**
 * Timestamps as ISO strings.
 *
 * `pg` hands back a `Date`; pglite does too. A JSON response must not contain a `Date`, because
 * `JSON.stringify` would render it in whatever the local convention is. ISO 8601 in UTC is the
 * only form that round-trips.
 */
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  createdAt: iso(row.created_at),
});

export const toUserWithSecret = (row: UserRow): UserWithSecret => ({
  ...toUser(row),
  passwordHash: row.password_hash,
});

export const toWorkspace = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  createdBy: row.created_by,
  createdAt: iso(row.created_at),
});

export const toMembership = (row: MembershipRow): Membership => ({
  id: row.id,
  workspaceId: row.workspace_id,
  userId: row.user_id,
  role: row.role,
  createdAt: iso(row.created_at),
});

export const toMemberSummary = (row: MemberRow): MemberSummary => ({
  ...toMembership(row),
  email: row.email,
  name: row.name,
});

export const toBoard = (row: BoardRow): Board => ({
  id: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  createdBy: row.created_by,
  createdAt: iso(row.created_at),
});

export const toItem = (row: ItemRow): Item => ({
  id: row.id,
  boardId: row.board_id,
  title: row.title,
  body: row.body,
  status: row.status,
  assigneeId: row.assignee_id,
  // pglite and pg agree on integers, but a `bigint` column would arrive as a string; `Number`
  // here means a later column-type change cannot silently turn version comparison into string
  // comparison, where "10" < "9".
  version: Number(row.version),
  createdBy: row.created_by,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

export const toComment = (row: CommentRow): Comment => ({
  id: row.id,
  itemId: row.item_id,
  authorId: row.author_id,
  body: row.body,
  createdAt: iso(row.created_at),
});

export const toAuditEntry = (row: AuditRow): AuditEntry => ({
  id: row.id,
  workspaceId: row.workspace_id,
  actorId: row.actor_id,
  action: row.action,
  subject: row.subject,
  // pglite returns jsonb already parsed; `pg` does too, but a driver change should not turn
  // this into a string silently.
  metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
  at: iso(row.at),
});

/**
 * Normalise an email before it is stored or compared.
 *
 * Lowercased and trimmed, and nothing else. Gmail's dot-and-plus folding is deliberately not
 * applied: it is a property of one provider, and stripping `+tag` from addresses would merge
 * two accounts a user considers distinct. The unique index is on `lower(email)`, which matches
 * this exactly.
 */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

/** A URL-safe slug, with a random suffix supplied by the caller for uniqueness. */
export const slugify = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workspace";
