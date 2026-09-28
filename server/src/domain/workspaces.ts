/**
 * Workspaces, membership and the audit trail.
 *
 * This is where authorization is actually enforced, and the shape of it matters: **every method
 * that touches a workspace resolves the actor's role in *that* workspace first**. Not "is the
 * caller an admin" but "is the caller an admin here". The cross-tenant bug -- an admin of
 * workspace A acting on workspace B because the role was read from the wrong place, or from the
 * token -- is impossible to write here, because the role is a function of (user, workspace) and
 * comes from a query with both in the `where` clause.
 *
 * `notFound` rather than `forbidden` for a non-member is deliberate. Telling a stranger
 * "forbidden" confirms the workspace exists, which is a slow enumeration oracle over a
 * guessable id space. Members who lack a specific permission do get `forbidden`, because they
 * can already see the resource.
 */

import type { Clock } from "../clock.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { newId } from "../ids.js";
import type { Database, Queryable } from "../ports/database.js";
import { isUniqueViolation } from "../ports/database.js";
import type { Action, Role } from "../authz/policy.js";
import { ROLES, authorize, canLeave, permissionsFor } from "../authz/policy.js";
import { EventBuffer } from "./events.js";
import {
  slugify,
  toAuditEntry,
  toMemberSummary,
  toMembership,
  toWorkspace,
  type AuditEntry,
  type AuditRow,
  type MemberRow,
  type MemberSummary,
  type Membership,
  type MembershipRow,
  type Workspace,
  type WorkspaceRow,
} from "./types.js";

/** What a caller is allowed to know about a workspace they belong to. */
export interface WorkspaceView {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly permissions: Action[];
}

export interface Accessed {
  readonly workspace: Workspace;
  readonly role: Role;
}

const WORKSPACE_COLUMNS = "id, name, slug, created_by, created_at";
const MEMBER_COLUMNS =
  "m.id, m.workspace_id, m.user_id, m.role, m.created_at, u.email, u.name";

export class WorkspaceService {
  readonly #database: Database;
  readonly #clock: Clock;

  constructor(options: { database: Database; clock: Clock }) {
    this.#database = options.database;
    this.#clock = options.clock;
  }

  // --- access resolution ----------------------------------------------------------

  /**
   * The actor's role in one workspace, or null.
   *
   * One query with both ids. Every authorization decision in this service starts here, and
   * `roleIn` never takes a role from anywhere else -- not from a token, not from a cache, not
   * from a previous request. That is what makes a demotion take effect on the next call.
   */
  async roleIn(workspaceId: string, userId: string, tx?: Queryable): Promise<Role | null> {
    const runner = tx ?? this.#database;
    const found = await runner.query<{ role: Role }>(
      `select role from memberships where workspace_id = $1 and user_id = $2`,
      [workspaceId, userId],
    );
    return found.rows[0]?.role ?? null;
  }

  /**
   * Load a workspace and the actor's role in it, or fail.
   *
   * `notFound` covers both "no such workspace" and "you are not a member", so the two are
   * indistinguishable from outside.
   */
  async access(workspaceId: string, userId: string, tx?: Queryable): Promise<Accessed> {
    const runner = tx ?? this.#database;
    const found = await runner.query<WorkspaceRow & { role: Role | null }>(
      `select w.id, w.name, w.slug, w.created_by, w.created_at, m.role
         from workspaces w
         left join memberships m on m.workspace_id = w.id and m.user_id = $2
        where w.id = $1`,
      [workspaceId, userId],
    );
    const row = found.rows[0];
    if (row === undefined || row.role === null) throw notFound("workspace", workspaceId);
    return { workspace: toWorkspace(row), role: row.role };
  }

  /** Load, resolve the role, and check one permission. */
  async require(
    workspaceId: string,
    userId: string,
    action: Action,
    resource: Parameters<typeof authorize>[2] = {},
  ): Promise<Accessed> {
    const accessed = await this.access(workspaceId, userId);
    const decision = authorize({ userId, role: accessed.role }, action, resource);
    if (!decision.allowed) throw forbidden(decision.reason, { action });
    return accessed;
  }

  async ownerCount(workspaceId: string, tx?: Queryable): Promise<number> {
    const runner = tx ?? this.#database;
    const found = await runner.query<{ count: string }>(
      `select count(*)::text as count from memberships where workspace_id = $1 and role = 'owner'`,
      [workspaceId],
    );
    return Number(found.rows[0]?.count ?? "0");
  }

  // --- workspaces -----------------------------------------------------------------

  /**
   * Create a workspace and make the creator its owner, in one transaction.
   *
   * Both statements or neither. A workspace with no members is unreachable -- nobody can read
   * it, nobody can add themselves to it, and no code path can delete it -- so a partial commit
   * here would leave a permanent orphan.
   */
  async create(userId: string, name: string): Promise<WorkspaceView> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      throw badRequest("workspace name must be between 1 and 200 characters");
    }

    const now = this.#clock.now();
    const workspaceId = newId("workspace", now);
    // The random half of the id supplies uniqueness, so two workspaces may share a display
    // name without the creator having to invent a distinct one.
    const slug = `${slugify(trimmed)}-${workspaceId.slice(-6).toLowerCase()}`;

    const workspace = await this.#database.transaction(async (tx) => {
      const inserted = await tx.query<WorkspaceRow>(
        `insert into workspaces (id, name, slug, created_by, created_at)
         values ($1, $2, $3, $4, $5)
         returning ${WORKSPACE_COLUMNS}`,
        [workspaceId, trimmed, slug, userId, new Date(now)],
      );
      await tx.query(
        `insert into memberships (id, workspace_id, user_id, role, created_at, updated_at)
         values ($1, $2, $3, 'owner', $4, $4)`,
        [newId("membership", now), workspaceId, userId, new Date(now)],
      );
      await this.#audit(tx, {
        workspaceId,
        actorId: userId,
        action: "workspace.created",
        subject: workspaceId,
        metadata: { name: trimmed },
      });
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("insert returned no row");
      return toWorkspace(row);
    });

    return { workspace, role: "owner", permissions: permissionsFor("owner") };
  }

  /** Workspaces the user belongs to, with their role in each. */
  async listFor(userId: string): Promise<WorkspaceView[]> {
    const found = await this.#database.query<WorkspaceRow & { role: Role }>(
      `select w.id, w.name, w.slug, w.created_by, w.created_at, m.role
         from workspaces w
         join memberships m on m.workspace_id = w.id
        where m.user_id = $1
        order by w.created_at desc`,
      [userId],
    );
    return found.rows.map((row) => ({
      workspace: toWorkspace(row),
      role: row.role,
      permissions: permissionsFor(row.role),
    }));
  }

  async view(workspaceId: string, userId: string): Promise<WorkspaceView> {
    const { workspace, role } = await this.access(workspaceId, userId);
    return { workspace, role, permissions: permissionsFor(role) };
  }

  async rename(
    workspaceId: string,
    userId: string,
    name: string,
    events: EventBuffer,
  ): Promise<Workspace> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      throw badRequest("workspace name must be between 1 and 200 characters");
    }
    await this.require(workspaceId, userId, "workspace:update");

    const now = this.#clock.now();
    const workspace = await this.#database.transaction(async (tx) => {
      const updated = await tx.query<WorkspaceRow>(
        `update workspaces set name = $1 where id = $2 returning ${WORKSPACE_COLUMNS}`,
        [trimmed, workspaceId],
      );
      const row = updated.rows[0];
      if (row === undefined) throw notFound("workspace", workspaceId);
      await this.#audit(tx, {
        workspaceId,
        actorId: userId,
        action: "workspace.updated",
        subject: workspaceId,
        metadata: { name: trimmed },
      });
      return toWorkspace(row);
    });

    events.add({
      type: "workspace.updated",
      workspaceId,
      subjectId: workspaceId,
      actorId: userId,
      at: now,
      payload: { ...workspace },
    });
    return workspace;
  }

  /** Delete a workspace. Cascades to boards, items, comments and memberships. */
  async remove(workspaceId: string, userId: string): Promise<void> {
    await this.require(workspaceId, userId, "workspace:delete");
    await this.#database.query(`delete from workspaces where id = $1`, [workspaceId]);
    // No audit row survives: `audit_log.workspace_id` cascades too. Recording the deletion
    // would need a separate retention store, which `docs/operations.md` names as future work
    // rather than pretending this trail is tamper-evident.
  }

  // --- membership -----------------------------------------------------------------

  async members(workspaceId: string, userId: string): Promise<MemberSummary[]> {
    await this.require(workspaceId, userId, "member:list");
    const found = await this.#database.query<MemberRow>(
      `select ${MEMBER_COLUMNS}
         from memberships m
         join users u on u.id = m.user_id
        where m.workspace_id = $1
        order by m.created_at`,
      [workspaceId],
    );
    return found.rows.map(toMemberSummary);
  }

  async addMember(
    workspaceId: string,
    actorId: string,
    targetUserId: string,
    role: Role,
    events: EventBuffer,
  ): Promise<Membership> {
    if (!ROLES.includes(role)) throw badRequest(`unknown role ${role}`);
    // Adding an owner is an owner-level act: an admin who could invite owners could invite
    // themselves a colleague with the power to remove them.
    await this.require(workspaceId, actorId, "member:invite", { targetRole: role });
    if (role === "owner") {
      const accessed = await this.access(workspaceId, actorId);
      if (accessed.role !== "owner") throw forbidden("only an owner may add another owner");
    }

    const now = this.#clock.now();
    const membership = await this.#database.transaction(async (tx) => {
      const userExists = await tx.query<{ id: string }>(`select id from users where id = $1`, [
        targetUserId,
      ]);
      if (userExists.rows[0] === undefined) throw notFound("user", targetUserId);

      let inserted;
      try {
        inserted = await tx.query<MembershipRow>(
          `insert into memberships (id, workspace_id, user_id, role, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $5)
           returning id, workspace_id, user_id, role, created_at`,
          [newId("membership", now), workspaceId, targetUserId, role, new Date(now)],
        );
      } catch (thrown) {
        if (isUniqueViolation(thrown)) throw conflict("that user is already a member");
        throw thrown;
      }
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("insert returned no row");

      await this.#audit(tx, {
        workspaceId,
        actorId,
        action: "member.added",
        subject: targetUserId,
        metadata: { role },
      });
      return toMembership(row);
    });

    events.add({
      type: "member.added",
      workspaceId,
      subjectId: targetUserId,
      actorId,
      at: now,
      payload: { ...membership },
    });
    return membership;
  }

  /**
   * Change a member's role.
   *
   * The interesting part is that the target's current role and the workspace's owner count are
   * read inside the transaction with `for update`, then handed to `authorize`. Reading them
   * outside would make the last-owner rule a race: two concurrent demotions of the two
   * remaining owners would each see a count of two and both succeed, leaving a workspace nobody
   * can administer.
   */
  async changeRole(
    workspaceId: string,
    actorId: string,
    targetUserId: string,
    role: Role,
    events: EventBuffer,
  ): Promise<Membership> {
    if (!ROLES.includes(role)) throw badRequest(`unknown role ${role}`);
    const now = this.#clock.now();

    const membership = await this.#database.transaction(async (tx) => {
      const actorRole = await this.roleIn(workspaceId, actorId, tx);
      if (actorRole === null) throw notFound("workspace", workspaceId);

      const target = await tx.query<MembershipRow>(
        `select id, workspace_id, user_id, role, created_at
           from memberships
          where workspace_id = $1 and user_id = $2
          for update`,
        [workspaceId, targetUserId],
      );
      const current = target.rows[0];
      if (current === undefined) throw notFound("member", targetUserId);
      if (current.role === role) return toMembership(current);

      const decision = authorize({ userId: actorId, role: actorRole }, "member:role:change", {
        targetRole: current.role,
        targetUserId,
        ownerCount: await this.#lockedOwnerCount(tx, workspaceId),
      });
      if (!decision.allowed) throw forbidden(decision.reason, { action: "member:role:change" });

      // Promotion to owner is owner-only, checked here rather than in the matrix because it is
      // about the role being granted, not the role being replaced.
      if (role === "owner" && actorRole !== "owner") {
        throw forbidden("only an owner may promote someone to owner");
      }

      const updated = await tx.query<MembershipRow>(
        `update memberships set role = $1, updated_at = $2
          where workspace_id = $3 and user_id = $4
          returning id, workspace_id, user_id, role, created_at`,
        [role, new Date(now), workspaceId, targetUserId],
      );
      const row = updated.rows[0];
      if (row === undefined) throw notFound("member", targetUserId);

      await this.#audit(tx, {
        workspaceId,
        actorId,
        action: "member.role.changed",
        subject: targetUserId,
        metadata: { from: current.role, to: role },
      });
      return toMembership(row);
    });

    events.add({
      type: "member.role.changed",
      workspaceId,
      subjectId: targetUserId,
      actorId,
      at: now,
      payload: { ...membership },
    });
    return membership;
  }

  /**
   * Remove a member, or leave.
   *
   * Leaving is not removal: no role below admin holds `member:remove`, so routing it through
   * that permission would trap every member in every workspace they ever joined. Self-removal
   * takes the `canLeave` path, which enforces only the last-owner rule.
   */
  async removeMember(
    workspaceId: string,
    actorId: string,
    targetUserId: string,
    events: EventBuffer,
  ): Promise<void> {
    const now = this.#clock.now();
    const leaving = actorId === targetUserId;

    await this.#database.transaction(async (tx) => {
      const actorRole = await this.roleIn(workspaceId, actorId, tx);
      if (actorRole === null) throw notFound("workspace", workspaceId);

      const target = await tx.query<MembershipRow>(
        `select id, workspace_id, user_id, role, created_at
           from memberships
          where workspace_id = $1 and user_id = $2
          for update`,
        [workspaceId, targetUserId],
      );
      const current = target.rows[0];
      if (current === undefined) throw notFound("member", targetUserId);

      const ownerCount = await this.#lockedOwnerCount(tx, workspaceId);
      const decision = leaving
        ? canLeave({ userId: actorId, role: actorRole }, ownerCount)
        : authorize({ userId: actorId, role: actorRole }, "member:remove", {
            targetRole: current.role,
            targetUserId,
            ownerCount,
          });
      if (!decision.allowed) throw forbidden(decision.reason, { action: "member:remove" });

      await tx.query(`delete from memberships where workspace_id = $1 and user_id = $2`, [
        workspaceId,
        targetUserId,
      ]);
      await this.#audit(tx, {
        workspaceId,
        actorId,
        action: leaving ? "member.left" : "member.removed",
        subject: targetUserId,
        metadata: { role: current.role },
      });
    });

    events.add({
      type: "member.removed",
      workspaceId,
      subjectId: targetUserId,
      actorId,
      at: now,
    });
  }

  /**
   * Owner count, counted while holding locks on the owner rows.
   *
   * `for update` on the selected rows is what serialises two concurrent demotions: the second
   * transaction blocks until the first commits and then sees the reduced count.
   */
  async #lockedOwnerCount(tx: Queryable, workspaceId: string): Promise<number> {
    const found = await tx.query<{ user_id: string }>(
      `select user_id from memberships where workspace_id = $1 and role = 'owner' for update`,
      [workspaceId],
    );
    return found.rows.length;
  }

  // --- audit ----------------------------------------------------------------------

  async auditTrail(
    workspaceId: string,
    userId: string,
    limit = 50,
  ): Promise<AuditEntry[]> {
    await this.require(workspaceId, userId, "audit:read");
    const capped = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const found = await this.#database.query<AuditRow>(
      `select id, workspace_id, actor_id, action, subject, metadata, at
         from audit_log
        where workspace_id = $1
        order by at desc, id desc
        limit $2`,
      [workspaceId, capped],
    );
    return found.rows.map(toAuditEntry);
  }

  /**
   * Append to the audit log, inside the caller's transaction.
   *
   * Taking the transaction is the point: an audit row that commits separately can commit when
   * the action it describes rolled back, which is worse than no audit trail because it is
   * confidently wrong.
   */
  async #audit(
    tx: Queryable,
    entry: {
      workspaceId: string | null;
      actorId: string | null;
      action: string;
      subject: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.query(
      `insert into audit_log (id, workspace_id, actor_id, action, subject, metadata, at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        newId("audit", this.#clock.now()),
        entry.workspaceId,
        entry.actorId,
        entry.action,
        entry.subject,
        JSON.stringify(entry.metadata ?? {}),
        new Date(this.#clock.now()),
      ],
    );
  }

  /** Exposed so the work service can write to the same trail in its own transactions. */
  audit = (
    tx: Queryable,
    entry: {
      workspaceId: string | null;
      actorId: string | null;
      action: string;
      subject: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> => this.#audit(tx, entry);
}
