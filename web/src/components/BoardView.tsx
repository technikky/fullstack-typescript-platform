"use client";

/**
 * A board: its items, live.
 *
 * The two behaviours worth reading:
 *
 * **Version conflicts are recovered from, not reported.** A status change sends the version the row
 * was rendered at. If somebody else wrote first the server answers 409 with its current version, and
 * this component refetches the item and tells the user the row moved -- rather than showing a raw
 * error and leaving stale data on screen. That is the whole point of returning the current version
 * in the error body.
 *
 * **Live updates are merged by id, and the actor's own echo is ignored.** A client that applied every
 * event it received would replace the row it just optimistically updated with the server's copy,
 * which usually looks like a flicker and occasionally like a lost keystroke. Events from this user
 * are skipped because the response already carried the authoritative row.
 *
 * Permission checks here are presentational. The server enforces the same matrix per request, and
 * the platform's tests call forbidden endpoints directly to prove that hiding a button is not a
 * permission.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, type ApiClient, type Board, type Item, type ItemStatus, type WorkspaceView } from "@/lib/api";
import type { DomainEvent } from "@/lib/realtime";
import { STATUS_LABELS, STATUS_ORDER, canDeleteItem, canEditItem, can } from "@/lib/permissions";

export interface BoardViewProps {
  readonly client: ApiClient;
  readonly board: Board;
  readonly view: WorkspaceView;
  readonly userId: string;
  /** Subscribe to live events for this board's workspace. Returns an unsubscribe function. */
  readonly onEvents?: (handler: (event: DomainEvent) => void) => () => void;
}

/** A note shown to the user, distinct from a thrown error. */
interface Notice {
  readonly kind: "info" | "warning" | "error";
  readonly text: string;
}

export const BoardView = ({
  client,
  board,
  view,
  userId,
  onEvents,
}: BoardViewProps): React.JSX.Element => {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const mayCreate = can(view, "item:create");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await client.items(board.id, { limit: 50 });
      setItems(page.items);
      setNotice(null);
    } catch (thrown) {
      setNotice({
        kind: "error",
        text: thrown instanceof ApiError ? thrown.message : "could not load this board",
      });
    } finally {
      setLoading(false);
    }
  }, [client, board.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Merge one item into the list by id, preserving order. */
  const merge = useCallback((item: Item) => {
    setItems((current) => {
      const index = current.findIndex((existing) => existing.id === item.id);
      if (index < 0) return [item, ...current];
      const next = [...current];
      next[index] = item;
      return next;
    });
  }, []);

  const drop = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  useEffect(() => {
    if (onEvents === undefined) return undefined;
    return onEvents((event) => {
      // This client's own action already updated the list from the response, which is the
      // authoritative copy. Applying the echo too would replace it and flicker.
      if (event.actorId === userId) return;

      if (event.type === "item.deleted") {
        drop(event.subjectId);
        return;
      }
      if (event.type === "item.created" || event.type === "item.updated") {
        const payload = event.payload as Item | undefined;
        // Only merge an item that belongs to the board on screen: the channel is per workspace, so
        // a sibling board's events arrive here too.
        if (payload !== undefined && payload.boardId === board.id) merge(payload);
      }
    });
  }, [onEvents, userId, board.id, merge, drop]);

  const create = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed.length === 0 || busy) return;

    setBusy(true);
    try {
      // An idempotency key per submission, so a retry after a timeout cannot create two items.
      const created = await client.createItem(board.id, { title: trimmed }, crypto.randomUUID());
      merge(created);
      setTitle("");
      setNotice(null);
    } catch (thrown) {
      setNotice({
        kind: "error",
        text: thrown instanceof ApiError ? thrown.message : "could not create that item",
      });
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (item: Item, status: ItemStatus): Promise<void> => {
    setBusy(true);
    try {
      merge(await client.updateItem(item.id, { expectedVersion: item.version, status }));
      setNotice(null);
    } catch (thrown) {
      if (thrown instanceof ApiError && thrown.isVersionConflict) {
        // Somebody else wrote first. Refetch rather than retrying blindly: their change may be one
        // this user would not want to overwrite, and they need to see it before deciding.
        await load();
        setNotice({
          kind: "warning",
          text: "Somebody else changed this item first, so it was reloaded. Try again if you still want that change.",
        });
        return;
      }
      setNotice({
        kind: "error",
        text: thrown instanceof ApiError ? thrown.message : "could not update that item",
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: Item): Promise<void> => {
    setBusy(true);
    try {
      await client.deleteItem(item.id);
      drop(item.id);
      setNotice(null);
    } catch (thrown) {
      setNotice({
        kind: "error",
        text: thrown instanceof ApiError ? thrown.message : "could not delete that item",
      });
    } finally {
      setBusy(false);
    }
  };

  const grouped = useMemo(
    () =>
      STATUS_ORDER.map((status) => ({
        status,
        items: items.filter((item) => item.status === status),
      })),
    [items],
  );

  return (
    <section aria-labelledby="board-heading" className="board">
      <header className="board-header">
        <h2 id="board-heading">{board.name}</h2>
        <p className="muted">
          {items.length} item{items.length === 1 ? "" : "s"}
        </p>
      </header>

      {notice !== null && (
        <p className={`notice notice-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.text}
        </p>
      )}

      {mayCreate ? (
        <form onSubmit={create} className="new-item">
          <label htmlFor="new-item-title">New item</label>
          <input
            id="new-item-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs doing?"
            maxLength={300}
            disabled={busy}
          />
          <button type="submit" disabled={busy || title.trim().length === 0}>
            Add
          </button>
        </form>
      ) : (
        // Said plainly rather than showing a control that always fails.
        <p className="muted">Your role on this workspace is read-only.</p>
      )}

      {loading ? (
        <p role="status">Loading items…</p>
      ) : items.length === 0 ? (
        <p className="muted">No items on this board yet.</p>
      ) : (
        <div className="columns">
          {grouped.map(({ status, items: columnItems }) => (
            <div key={status} className="column">
              <h3>
                {STATUS_LABELS[status]} <span className="muted">({columnItems.length})</span>
              </h3>
              <ul>
                {columnItems.map((item) => {
                  const mayEdit = canEditItem(view, item, userId);
                  const mayDelete = canDeleteItem(view, item, userId);
                  return (
                    <li key={item.id} className="item">
                      <span className="item-title">{item.title}</span>
                      <span className="muted item-version">v{item.version}</span>
                      <div className="item-actions">
                        <label className="visually-hidden" htmlFor={`status-${item.id}`}>
                          Status for {item.title}
                        </label>
                        <select
                          id={`status-${item.id}`}
                          value={item.status}
                          disabled={!mayEdit || busy}
                          onChange={(event) =>
                            void changeStatus(item, event.target.value as ItemStatus)
                          }
                        >
                          {STATUS_ORDER.map((option) => (
                            <option key={option} value={option}>
                              {STATUS_LABELS[option]}
                            </option>
                          ))}
                        </select>
                        {mayDelete && (
                          <button
                            type="button"
                            onClick={() => void remove(item)}
                            disabled={busy}
                            aria-label={`Delete ${item.title}`}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
