/**
 * Boards, items and comments.
 *
 * Two things here are worth more than the CRUD around them.
 *
 * **Authorization is resolved from the resource upward, never from the request.** An item id
 * arrives; the item's board's workspace is looked up in the same query, and the actor's role is
 * read for *that* workspace. Trusting a `workspaceId` from the request body instead would let a
 * caller pass their own workspace id alongside someone else's item id and pass the role check
 * against the wrong tenant. The join is the fix, and `resolveItem` is where it lives.
 *
 * **Updates are optimistic, and the database decides.** Every update carries the version the
 * client last saw and runs `where version = $expected`. Zero rows affected means somebody else
 * wrote first, and the caller gets 409 with the current version rather than silently clobbering.
 * A read-then-write in application code cannot do this: two requests both read version 3, both
 * decide they are fine, and the second overwrites the first.
 */

import type { Clock } from "../clock.js";
import { badRequest, notFound, versionConflict } from "../errors.js";
import { newId } from "../ids.js";
import type { Database, Queryable } from "../ports/database.js";
import { isForeignKeyViolation } from "../ports/database.js";
import type { Role } from "../authz/policy.js";
import { authorize } from "../authz/policy.js";
import { forbidden } from "../errors.js";
import type { EventBuffer } from "./events.js";
import {
  ITEM_STATUSES,
  toBoard,
  toComment,
  toItem,
  type Board,
  type BoardRow,
  type Comment,
  type CommentRow,
  type Item,
  type ItemRow,
  type ItemStatus,
} from "./types.js";
import type { WorkspaceService } from "./workspaces.js";

const BOARD_COLUMNS = "id, workspace_id, name, created_by, created_at";
const ITEM_COLUMNS =
  "id, board_id, title, body, status, assignee_id, version, created_by, created_at, updated_at";
const COMMENT_COLUMNS = "id, item_id, author_id, body, created_at";

export interface ItemInput {
  readonly title: string;
  readonly body?: string;
  readonly status?: ItemStatus;
  readonly assigneeId?: string | null;
}

export interface ItemPatch {
  readonly title?: string;
  readonly body?: string;
  readonly status?: ItemStatus;
  readonly assigneeId?: string | null;
  /** The version the client last saw. Required: an update without one is a blind write. */
  readonly expectedVersion: number;
}

export interface ItemPage {
  readonly items: Item[];
  /** The id to pass as `after` for the next page, or null at the end. */
  readonly nextCursor: string | null;
}

const validateTitle = (title: string): string => {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > 300) {
    throw badRequest("title must be between 1 and 300 characters");
  }
  return trimmed;
};

const validateStatus = (status: string): ItemStatus => {
  if (!(ITEM_STATUSES as readonly string[]).includes(status)) {
    throw badRequest(`status must be one of ${ITEM_STATUSES.join(", ")}`);
  }
  return status as ItemStatus;
};

export class WorkService {
  readonly #database: Database;
  readonly #clock: Clock;
  readonly #workspaces: WorkspaceService;

  constructor(options: { database: Database; clock: Clock; workspaces: WorkspaceService }) {
    this.#database = options.database;
    this.#clock = options.clock;
    this.#workspaces = options.workspaces;
  }

  // --- resolution -----------------------------------------------------------------

  /**
   * Find a board, its workspace, and the actor's role there, in one query.
   *
   * One round trip, and no opportunity to check the role against a workspace the caller named.
   */
  async #resolveBoard(
    boardId: string,
    userId: string,
    tx?: Queryable,
  ): Promise<{ board: Board; role: Role }> {
    const runner = tx ?? this.#database;
    const found = await runner.query<BoardRow & { role: Role | null }>(
      `select b.id, b.workspace_id, b.name, b.created_by, b.created_at, m.role
         from boards b
         left join memberships m on m.workspace_id = b.workspace_id and m.user_id = $2
        where b.id = $1`,
      [boardId, userId],
    );
    const row = found.rows[0];
    if (row === undefined || row.role === null) throw notFound("board", boardId);
    return { board: toBoard(row), role: row.role };
  }

  async #resolveItem(
    itemId: string,
    userId: string,
    tx?: Queryable,
    lock = false,
  ): Promise<{ item: Item; workspaceId: string; role: Role }> {
    const runner = tx ?? this.#database;
    const found = await runner.query<ItemRow & { workspace_id: string; role: Role | null }>(
      `select i.id, i.board_id, i.title, i.body, i.status, i.assignee_id, i.version,
              i.created_by, i.created_at, i.updated_at,
              b.workspace_id, m.role
         from items i
         join boards b on b.id = i.board_id
         left join memberships m on m.workspace_id = b.workspace_id and m.user_id = $2
        where i.id = $1
        ${lock ? "for no key update of i" : ""}`,
      [itemId, userId],
    );
    const row = found.rows[0];
    if (row === undefined || row.role === null) throw notFound("item", itemId);
    return { item: toItem(row), workspaceId: row.workspace_id, role: row.role };
  }

  // --- boards ---------------------------------------------------------------------

  async createBoard(
    workspaceId: string,
    userId: string,
    name: string,
    events: EventBuffer,
  ): Promise<Board> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      throw badRequest("board name must be between 1 and 200 characters");
    }
    await this.#workspaces.require(workspaceId, userId, "board:create");

    const now = this.#clock.now();
    const board = await this.#database.transaction(async (tx) => {
      const inserted = await tx.query<BoardRow>(
        `insert into boards (id, workspace_id, name, created_by, created_at)
         values ($1, $2, $3, $4, $5)
         returning ${BOARD_COLUMNS}`,
        [newId("board", now), workspaceId, trimmed, userId, new Date(now)],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("insert returned no row");
      await this.#workspaces.audit(tx, {
        workspaceId,
        actorId: userId,
        action: "board.created",
        subject: row.id,
        metadata: { name: trimmed },
      });
      return toBoard(row);
    });

    events.add({
      type: "board.created",
      workspaceId,
      subjectId: board.id,
      actorId: userId,
      at: now,
      payload: { ...board },
    });
    return board;
  }

  async listBoards(workspaceId: string, userId: string): Promise<Board[]> {
    await this.#workspaces.require(workspaceId, userId, "board:read");
    const found = await this.#database.query<BoardRow>(
      `select ${BOARD_COLUMNS} from boards where workspace_id = $1 order by created_at`,
      [workspaceId],
    );
    return found.rows.map(toBoard);
  }

  async getBoard(boardId: string, userId: string): Promise<Board> {
    const { board, role } = await this.#resolveBoard(boardId, userId);
    const decision = authorize({ userId, role }, "board:read");
    if (!decision.allowed) throw forbidden(decision.reason, { action: "board:read" });
    return board;
  }

  async renameBoard(
    boardId: string,
    userId: string,
    name: string,
    events: EventBuffer,
  ): Promise<Board> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      throw badRequest("board name must be between 1 and 200 characters");
    }
    const { board, role } = await this.#resolveBoard(boardId, userId);
    const decision = authorize({ userId, role }, "board:update");
    if (!decision.allowed) throw forbidden(decision.reason, { action: "board:update" });

    const now = this.#clock.now();
    const updated = await this.#database.query<BoardRow>(
      `update boards set name = $1 where id = $2 returning ${BOARD_COLUMNS}`,
      [trimmed, boardId],
    );
    const row = updated.rows[0];
    if (row === undefined) throw notFound("board", boardId);

    events.add({
      type: "board.updated",
      workspaceId: board.workspaceId,
      subjectId: boardId,
      actorId: userId,
      at: now,
      payload: { ...toBoard(row) },
    });
    return toBoard(row);
  }

  async deleteBoard(boardId: string, userId: string, events: EventBuffer): Promise<void> {
    const { board, role } = await this.#resolveBoard(boardId, userId);
    const decision = authorize({ userId, role }, "board:delete");
    if (!decision.allowed) throw forbidden(decision.reason, { action: "board:delete" });

    await this.#database.transaction(async (tx) => {
      await tx.query(`delete from boards where id = $1`, [boardId]);
      await this.#workspaces.audit(tx, {
        workspaceId: board.workspaceId,
        actorId: userId,
        action: "board.deleted",
        subject: boardId,
        metadata: { name: board.name },
      });
    });

    events.add({
      type: "board.deleted",
      workspaceId: board.workspaceId,
      subjectId: boardId,
      actorId: userId,
      at: this.#clock.now(),
    });
  }

  // --- items ----------------------------------------------------------------------

  async createItem(
    boardId: string,
    userId: string,
    input: ItemInput,
    events: EventBuffer,
  ): Promise<Item> {
    const title = validateTitle(input.title);
    const status = input.status === undefined ? "open" : validateStatus(input.status);
    const { board, role } = await this.#resolveBoard(boardId, userId);

    const decision = authorize({ userId, role }, "item:create");
    if (!decision.allowed) throw forbidden(decision.reason, { action: "item:create" });

    // Assigning on create is still assignment. A member who cannot reassign should not be able
    // to hand work to someone else simply by doing it at creation time.
    if (input.assigneeId !== undefined && input.assigneeId !== null && input.assigneeId !== userId) {
      const assignDecision = authorize({ userId, role }, "item:assign");
      if (!assignDecision.allowed) {
        throw forbidden(assignDecision.reason, { action: "item:assign" });
      }
      await this.#requireMember(board.workspaceId, input.assigneeId);
    }

    const now = this.#clock.now();
    const item = await this.#database.transaction(async (tx) => {
      let inserted;
      try {
        inserted = await tx.query<ItemRow>(
          `insert into items (id, board_id, title, body, status, assignee_id, version,
                              created_by, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, 1, $7, $8, $8)
           returning ${ITEM_COLUMNS}`,
          [
            newId("item", now),
            boardId,
            title,
            input.body?.trim() ?? "",
            status,
            input.assigneeId ?? null,
            userId,
            new Date(now),
          ],
        );
      } catch (thrown) {
        // An assignee that passed the membership check but was deleted in between.
        if (isForeignKeyViolation(thrown)) throw badRequest("assignee no longer exists");
        throw thrown;
      }
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("insert returned no row");
      return toItem(row);
    });

    events.add({
      type: "item.created",
      workspaceId: board.workspaceId,
      subjectId: item.id,
      actorId: userId,
      at: now,
      payload: { ...item },
    });
    return item;
  }

  /**
   * Items on a board, newest first, keyset-paginated.
   *
   * Keyset rather than `offset`: an offset page shifts under insertion, so a client paging
   * through an active board sees some items twice and misses others. `(created_at, id)` is
   * unique and totally ordered, which makes the cursor stable.
   */
  async listItems(
    boardId: string,
    userId: string,
    options: { limit?: number; after?: string; status?: ItemStatus } = {},
  ): Promise<ItemPage> {
    const { role } = await this.#resolveBoard(boardId, userId);
    const decision = authorize({ userId, role }, "item:read");
    if (!decision.allowed) throw forbidden(decision.reason, { action: "item:read" });

    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    const status = options.status === undefined ? null : validateStatus(options.status);

    // One extra row tells us whether another page exists, without a second count query.
    const found = await this.#database.query<ItemRow>(
      `select ${ITEM_COLUMNS}
         from items
        where board_id = $1
          and ($2::text is null or status = $2)
          and ($3::text is null or (created_at, id) <
               (select created_at, id from items where id = $3))
        order by created_at desc, id desc
        limit $4`,
      [boardId, status, options.after ?? null, limit + 1],
    );

    const rows = found.rows.slice(0, limit);
    const hasMore = found.rows.length > limit;
    return {
      items: rows.map(toItem),
      nextCursor: hasMore ? (rows[rows.length - 1]?.id ?? null) : null,
    };
  }

  async getItem(itemId: string, userId: string): Promise<Item> {
    const { item, role } = await this.#resolveItem(itemId, userId);
    const decision = authorize({ userId, role }, "item:read");
    if (!decision.allowed) throw forbidden(decision.reason, { action: "item:read" });
    return item;
  }

  /**
   * Update an item, with the version check in the `where` clause.
   *
   * The permission check uses `item:update:own`, which `authorize` resolves against the actor's
   * role and the item's creator: a role holding `item:update:any` passes regardless, a member
   * passes only on their own item. The caller does not choose between the two forms, so it
   * cannot choose wrong.
   */
  async updateItem(
    itemId: string,
    userId: string,
    patch: ItemPatch,
    events: EventBuffer,
  ): Promise<Item> {
    if (!Number.isInteger(patch.expectedVersion) || patch.expectedVersion < 1) {
      throw badRequest("expectedVersion must be a positive integer");
    }

    const now = this.#clock.now();
    const result = await this.#database.transaction(async (tx) => {
      const { item, workspaceId, role } = await this.#resolveItem(itemId, userId, tx, true);

      const decision = authorize({ userId, role }, "item:update:own", {
        ownerId: item.createdBy,
      });
      if (!decision.allowed) throw forbidden(decision.reason, { action: "item:update" });

      // Reassignment is a separate permission from editing, checked only when the assignee
      // actually changes -- otherwise saving an unrelated field would trip it.
      if (patch.assigneeId !== undefined && patch.assigneeId !== item.assigneeId) {
        const assignDecision = authorize({ userId, role }, "item:assign", {
          ownerId: item.createdBy,
        });
        if (!assignDecision.allowed) {
          throw forbidden(assignDecision.reason, { action: "item:assign" });
        }
        if (patch.assigneeId !== null) {
          await this.#requireMember(workspaceId, patch.assigneeId, tx);
        }
      }

      const title = patch.title === undefined ? item.title : validateTitle(patch.title);
      const status = patch.status === undefined ? item.status : validateStatus(patch.status);
      const body = patch.body === undefined ? item.body : patch.body.trim();
      const assigneeId = patch.assigneeId === undefined ? item.assigneeId : patch.assigneeId;

      const updated = await tx.query<ItemRow>(
        `update items
            set title = $1, body = $2, status = $3, assignee_id = $4,
                version = version + 1, updated_at = $5
          where id = $6 and version = $7
          returning ${ITEM_COLUMNS}`,
        [title, body, status, assigneeId, new Date(now), itemId, patch.expectedVersion],
      );

      const row = updated.rows[0];
      if (row === undefined) {
        // The row exists -- it was just read under lock -- so zero rows can only mean the
        // version did not match. The current version goes back to the client so it can rebase
        // rather than guess.
        return { conflict: item.version } as const;
      }
      return { item: toItem(row), workspaceId } as const;
    });

    if ("conflict" in result) throw versionConflict(result.conflict);

    events.add({
      type: "item.updated",
      workspaceId: result.workspaceId,
      subjectId: itemId,
      actorId: userId,
      at: now,
      payload: { ...result.item },
    });
    return result.item;
  }

  async deleteItem(itemId: string, userId: string, events: EventBuffer): Promise<void> {
    const { item, workspaceId, role } = await this.#resolveItem(itemId, userId);
    const decision = authorize({ userId, role }, "item:delete:own", { ownerId: item.createdBy });
    if (!decision.allowed) throw forbidden(decision.reason, { action: "item:delete" });

    await this.#database.transaction(async (tx) => {
      await tx.query(`delete from items where id = $1`, [itemId]);
      await this.#workspaces.audit(tx, {
        workspaceId,
        actorId: userId,
        action: "item.deleted",
        subject: itemId,
        metadata: { title: item.title },
      });
    });

    events.add({
      type: "item.deleted",
      workspaceId,
      subjectId: itemId,
      actorId: userId,
      at: this.#clock.now(),
    });
  }

  // --- comments -------------------------------------------------------------------

  async addComment(
    itemId: string,
    userId: string,
    body: string,
    events: EventBuffer,
  ): Promise<Comment> {
    const trimmed = body.trim();
    if (trimmed.length === 0 || trimmed.length > 5000) {
      throw badRequest("comment must be between 1 and 5000 characters");
    }
    const { workspaceId, role } = await this.#resolveItem(itemId, userId);
    const decision = authorize({ userId, role }, "comment:create");
    if (!decision.allowed) throw forbidden(decision.reason, { action: "comment:create" });

    const now = this.#clock.now();
    const inserted = await this.#database.query<CommentRow>(
      `insert into comments (id, item_id, author_id, body, created_at)
       values ($1, $2, $3, $4, $5)
       returning ${COMMENT_COLUMNS}`,
      [newId("comment", now), itemId, userId, trimmed, new Date(now)],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error("insert returned no row");
    const comment = toComment(row);

    events.add({
      type: "comment.created",
      workspaceId,
      subjectId: comment.id,
      actorId: userId,
      at: now,
      payload: { ...comment },
    });
    return comment;
  }

  async listComments(itemId: string, userId: string): Promise<Comment[]> {
    const { role } = await this.#resolveItem(itemId, userId);
    const decision = authorize({ userId, role }, "item:read");
    if (!decision.allowed) throw forbidden(decision.reason, { action: "item:read" });

    const found = await this.#database.query<CommentRow>(
      `select ${COMMENT_COLUMNS} from comments where item_id = $1 order by created_at`,
      [itemId],
    );
    return found.rows.map(toComment);
  }

  async deleteComment(commentId: string, userId: string, events: EventBuffer): Promise<void> {
    const found = await this.#database.query<
      CommentRow & { workspace_id: string; role: Role | null }
    >(
      `select c.id, c.item_id, c.author_id, c.body, c.created_at, b.workspace_id, m.role
         from comments c
         join items i on i.id = c.item_id
         join boards b on b.id = i.board_id
         left join memberships m on m.workspace_id = b.workspace_id and m.user_id = $2
        where c.id = $1`,
      [commentId, userId],
    );
    const row = found.rows[0];
    if (row === undefined || row.role === null) throw notFound("comment", commentId);

    const decision = authorize({ userId, role: row.role }, "comment:delete:own", {
      ownerId: row.author_id,
    });
    if (!decision.allowed) throw forbidden(decision.reason, { action: "comment:delete" });

    await this.#database.query(`delete from comments where id = $1`, [commentId]);
    events.add({
      type: "comment.deleted",
      workspaceId: row.workspace_id,
      subjectId: commentId,
      actorId: userId,
      at: this.#clock.now(),
    });
  }

  // --- helpers --------------------------------------------------------------------

  /**
   * An assignee must be a member of the workspace.
   *
   * Without this, any user id in the system could be assigned work in a workspace they cannot
   * see -- which both leaks that the id exists and puts a name on a board they have no access
   * to.
   */
  async #requireMember(workspaceId: string, userId: string, tx?: Queryable): Promise<void> {
    const role = await this.#workspaces.roleIn(workspaceId, userId, tx);
    if (role === null) throw badRequest("assignee is not a member of this workspace");
  }
}
