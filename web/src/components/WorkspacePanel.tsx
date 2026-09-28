"use client";

/**
 * The signed-in shell: workspaces, boards, and the live connection.
 *
 * This is where the client's moving parts are wired together, and two of the joins matter:
 *
 * **The socket subscribes to the selected workspace and unsubscribes from the previous one.** A
 * client that only ever subscribes accumulates channels as the user browses, and then receives
 * events for every workspace they have visited this session -- which the server will happily deliver,
 * because they are a member of all of them.
 *
 * **A revoked subscription is handled, not ignored.** If the server drops the subscription because
 * the user was removed mid-session, the workspace list is refetched so the UI stops showing a
 * workspace they can no longer read.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, type ApiClient, type Board, type User, type WorkspaceView } from "@/lib/api";
import { RealtimeClient, type ConnectionState, type DomainEvent } from "@/lib/realtime";
import { ROLE_LABELS, can } from "@/lib/permissions";
import { BoardView } from "./BoardView";
import { ConnectionBadge } from "./ConnectionBadge";

export interface WorkspacePanelProps {
  readonly client: ApiClient;
  readonly user: User;
  readonly wsUrl: string;
  readonly onSignOut: () => void;
  /** Injected by tests so no socket is opened. */
  readonly realtimeFactory?: (options: {
    url: string;
    token: () => string | null;
    onEvent: (event: DomainEvent) => void;
    onState: (state: ConnectionState) => void;
    onUnsubscribed: (workspaceId: string, reason: string | null) => void;
  }) => { connect(): void; close(): void; subscribe(id: string): void; unsubscribe(id: string): void; attempts: number };
}

export const WorkspacePanel = ({
  client,
  user,
  wsUrl,
  onSignOut,
  realtimeFactory,
}: WorkspacePanelProps): React.JSX.Element => {
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [boards, setBoards] = useState<Board[]>([]);
  const [activeBoard, setActiveBoard] = useState<string | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const [attempts, setAttempts] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [newWorkspace, setNewWorkspace] = useState("");
  const [newBoard, setNewBoard] = useState("");

  /** Event listeners registered by child components. */
  const listeners = useRef(new Set<(event: DomainEvent) => void>());
  const realtime = useRef<{ connect(): void; close(): void; subscribe(id: string): void; unsubscribe(id: string): void; attempts: number } | null>(null);
  const subscribedTo = useRef<string | null>(null);

  const loadWorkspaces = useCallback(async () => {
    try {
      const listed = await client.workspaces();
      setWorkspaces(listed);
      setSelected((current) =>
        current !== null && listed.some((view) => view.workspace.id === current)
          ? current
          : (listed[0]?.workspace.id ?? null),
      );
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : "could not load your workspaces");
    }
  }, [client]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  // --- realtime ---------------------------------------------------------------------

  useEffect(() => {
    const factory =
      realtimeFactory ??
      ((options: Parameters<NonNullable<WorkspacePanelProps["realtimeFactory"]>>[0]) =>
        new RealtimeClient(options));

    const connection = factory({
      url: wsUrl,
      token: () => client.tokens?.accessToken ?? null,
      onEvent: (event) => {
        for (const listener of [...listeners.current]) listener(event);
      },
      onState: (next) => {
        setState(next);
        setAttempts(realtime.current?.attempts ?? 0);
      },
      onUnsubscribed: (workspaceId, reason) => {
        // Most likely the user was removed from the workspace while connected. Refetch so the UI
        // stops offering something they can no longer read.
        subscribedTo.current = null;
        setError(
          reason === "access revoked"
            ? "Your access to that workspace was removed."
            : `Stopped receiving updates for ${workspaceId}.`,
        );
        void loadWorkspaces();
      },
    });

    realtime.current = connection;
    connection.connect();
    return () => {
      connection.close();
      realtime.current = null;
      subscribedTo.current = null;
    };
  }, [client, wsUrl, realtimeFactory, loadWorkspaces]);

  // Subscribe to the selected workspace, and leave the previous one. Without the unsubscribe, a
  // session accumulates channels as the user browses.
  useEffect(() => {
    const connection = realtime.current;
    if (connection === null) return;
    if (subscribedTo.current === selected) return;
    if (subscribedTo.current !== null) connection.unsubscribe(subscribedTo.current);
    if (selected !== null) connection.subscribe(selected);
    subscribedTo.current = selected;
  }, [selected, state]);

  const onEvents = useCallback((handler: (event: DomainEvent) => void) => {
    listeners.current.add(handler);
    return () => void listeners.current.delete(handler);
  }, []);

  // --- boards -----------------------------------------------------------------------

  useEffect(() => {
    if (selected === null) {
      setBoards([]);
      setActiveBoard(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const listed = await client.boards(selected);
        // A response that arrives after the user switched workspace must not overwrite the new
        // one's boards.
        if (cancelled) return;
        setBoards(listed);
        setActiveBoard(listed[0]?.id ?? null);
      } catch (thrown) {
        if (!cancelled) {
          setError(thrown instanceof ApiError ? thrown.message : "could not load boards");
        }
      }
    })();
    return () => void (cancelled = true);
  }, [client, selected]);

  const currentView = workspaces.find((view) => view.workspace.id === selected) ?? null;
  const currentBoard = boards.find((board) => board.id === activeBoard) ?? null;

  const createWorkspace = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const name = newWorkspace.trim();
    if (name.length === 0) return;
    try {
      const created = await client.createWorkspace(name, crypto.randomUUID());
      setWorkspaces((current) => [created, ...current]);
      setSelected(created.workspace.id);
      setNewWorkspace("");
      setError(null);
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : "could not create that workspace");
    }
  };

  const createBoard = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const name = newBoard.trim();
    if (name.length === 0 || selected === null) return;
    try {
      const created = await client.createBoard(selected, name);
      setBoards((current) => [...current, created]);
      setActiveBoard(created.id);
      setNewBoard("");
      setError(null);
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : "could not create that board");
    }
  };

  return (
    <div className="panel">
      <header className="top">
        <div>
          <strong>{user.name}</strong> <span className="muted">{user.email}</span>
        </div>
        <ConnectionBadge state={state} attempts={attempts} />
        <button type="button" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      {error !== null && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      <div className="layout">
        <nav aria-label="Workspaces" className="sidebar">
          <h2>Workspaces</h2>
          {workspaces.length === 0 ? (
            <p className="muted">You are not a member of any workspace yet.</p>
          ) : (
            <ul>
              {workspaces.map((view) => (
                <li key={view.workspace.id}>
                  <button
                    type="button"
                    aria-current={view.workspace.id === selected ? "true" : undefined}
                    onClick={() => setSelected(view.workspace.id)}
                  >
                    {view.workspace.name}
                    <span className="muted"> · {ROLE_LABELS[view.role]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={createWorkspace}>
            <label htmlFor="new-workspace">New workspace</label>
            <input
              id="new-workspace"
              value={newWorkspace}
              onChange={(event) => setNewWorkspace(event.target.value)}
              maxLength={200}
            />
            <button type="submit" disabled={newWorkspace.trim().length === 0}>
              Create
            </button>
          </form>
        </nav>

        <main className="content">
          {currentView === null ? (
            <p className="muted">Select or create a workspace.</p>
          ) : (
            <>
              <div className="board-tabs">
                <h2>Boards</h2>
                {boards.length === 0 ? (
                  <p className="muted">No boards in this workspace yet.</p>
                ) : (
                  <ul>
                    {boards.map((board) => (
                      <li key={board.id}>
                        <button
                          type="button"
                          aria-current={board.id === activeBoard ? "true" : undefined}
                          onClick={() => setActiveBoard(board.id)}
                        >
                          {board.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {can(currentView, "board:create") && (
                  <form onSubmit={createBoard}>
                    <label htmlFor="new-board">New board</label>
                    <input
                      id="new-board"
                      value={newBoard}
                      onChange={(event) => setNewBoard(event.target.value)}
                      maxLength={200}
                    />
                    <button type="submit" disabled={newBoard.trim().length === 0}>
                      Create
                    </button>
                  </form>
                )}
              </div>

              {currentBoard !== null && (
                <BoardView
                  client={client}
                  board={currentBoard}
                  view={currentView}
                  userId={user.id}
                  onEvents={onEvents}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
};
