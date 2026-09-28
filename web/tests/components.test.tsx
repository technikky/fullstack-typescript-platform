/**
 * Component behaviour.
 *
 * The tests worth having here are the ones about *recovery*, not rendering: what the board does when
 * somebody else wrote first, and what it does with a live event that arrives while the user is
 * looking at it. Both are states a manual click-through almost never reaches.
 *
 * Everything is driven through the rendered DOM with Testing Library, so a change that keeps the
 * component's internals working while breaking the accessible name of a control still fails.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiError, type ApiClient, type Board, type Item, type WorkspaceView } from "@/lib/api";
import type { DomainEvent } from "@/lib/realtime";
import { BoardView } from "@/components/BoardView";
import { ConnectionBadge } from "@/components/ConnectionBadge";
import { SignInForm } from "@/components/SignInForm";
import { canDeleteItem, canEditItem, can } from "@/lib/permissions";

const BOARD: Board = {
  id: "brd_1",
  workspaceId: "wsp_1",
  name: "Roadmap",
  createdBy: "usr_owner",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const item = (overrides: Partial<Item> = {}): Item => ({
  id: "itm_1",
  boardId: "brd_1",
  title: "Write the docs",
  body: "",
  status: "open",
  assigneeId: null,
  version: 1,
  createdBy: "usr_me",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const view = (role: WorkspaceView["role"], permissions: string[]): WorkspaceView => ({
  workspace: {
    id: "wsp_1",
    name: "Team",
    slug: "team",
    createdBy: "usr_owner",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  role,
  permissions,
});

const MEMBER_VIEW = view("member", [
  "workspace:read",
  "board:read",
  "item:read",
  "item:create",
  "item:update:own",
  "item:delete:own",
]);

const VIEWER_VIEW = view("viewer", ["workspace:read", "board:read", "item:read"]);
const ADMIN_VIEW = view("admin", [
  ...MEMBER_VIEW.permissions,
  "item:update:any",
  "item:delete:any",
]);

/** A client with just the methods `BoardView` calls. */
const clientStub = (overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient =>
  ({
    items: vi.fn(async () => ({ items: [item()], nextCursor: null })),
    createItem: vi.fn(async () => item({ id: "itm_new", title: "Created" })),
    updateItem: vi.fn(async () => item({ version: 2, status: "done" })),
    deleteItem: vi.fn(async () => undefined),
    ...overrides,
  }) as unknown as ApiClient;

describe("BoardView", () => {
  it("renders the items it loaded", async () => {
    render(<BoardView client={clientStub()} board={BOARD} view={MEMBER_VIEW} userId="usr_me" />);
    expect(await screen.findByText("Write the docs")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Roadmap" })).toBeInTheDocument();
  });

  it("shows the version, so a reader can see the row moved", async () => {
    render(<BoardView client={clientStub()} board={BOARD} view={MEMBER_VIEW} userId="usr_me" />);
    expect(await screen.findByText("v1")).toBeInTheDocument();
  });

  it("says so plainly when the role is read-only", async () => {
    // Better than rendering a control that always fails.
    render(<BoardView client={clientStub()} board={BOARD} view={VIEWER_VIEW} userId="usr_me" />);
    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("New item")).not.toBeInTheDocument();
  });

  it("disables the status control on somebody else's item for a member", async () => {
    const client = clientStub({
      items: vi.fn(async () => ({
        items: [item({ id: "itm_mine", createdBy: "usr_me", title: "Mine" }),
                item({ id: "itm_theirs", createdBy: "usr_other", title: "Theirs" })],
        nextCursor: null,
      })),
    });
    render(<BoardView client={client} board={BOARD} view={MEMBER_VIEW} userId="usr_me" />);

    await screen.findByText("Mine");
    expect(screen.getByLabelText("Status for Mine")).toBeEnabled();
    expect(screen.getByLabelText("Status for Theirs")).toBeDisabled();
    // And the delete button only exists for their own.
    expect(screen.getByRole("button", { name: "Delete Mine" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Theirs" })).not.toBeInTheDocument();
  });

  it("lets an admin edit anyone's item", async () => {
    const client = clientStub({
      items: vi.fn(async () => ({
        items: [item({ id: "itm_theirs", createdBy: "usr_other", title: "Theirs" })],
        nextCursor: null,
      })),
    });
    render(<BoardView client={client} board={BOARD} view={ADMIN_VIEW} userId="usr_me" />);

    await screen.findByText("Theirs");
    expect(screen.getByLabelText("Status for Theirs")).toBeEnabled();
  });

  it("creates an item with an idempotency key", async () => {
    // A retry after a timeout must not create two items, and the key is what makes that possible.
    const createItem = vi.fn(async () => item({ id: "itm_new", title: "Created" }));
    render(
      <BoardView client={clientStub({ createItem })} board={BOARD} view={MEMBER_VIEW} userId="usr_me" />,
    );
    await screen.findByText("Write the docs");

    await userEvent.type(screen.getByLabelText("New item"), "A new task");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(createItem).toHaveBeenCalledTimes(1));
    const [, , key] = createItem.mock.calls[0] as unknown as [string, unknown, string];
    expect(key).toBeTypeOf("string");
    expect(key.length).toBeGreaterThan(8);
  });

  it("sends the version it rendered when changing status", async () => {
    const updateItem = vi.fn(async () => item({ version: 2, status: "done" }));
    render(
      <BoardView client={clientStub({ updateItem })} board={BOARD} view={MEMBER_VIEW} userId="usr_me" />,
    );
    await screen.findByText("Write the docs");

    await userEvent.selectOptions(screen.getByLabelText("Status for Write the docs"), "done");

    await waitFor(() => expect(updateItem).toHaveBeenCalled());
    expect(updateItem).toHaveBeenCalledWith("itm_1", { expectedVersion: 1, status: "done" });
  });

  it("recovers from a version conflict by reloading and explaining", async () => {
    // The behaviour the 409 body exists to enable. Showing a raw error and leaving stale data on
    // screen would be strictly worse: the user cannot see what changed.
    let loads = 0;
    const client = clientStub({
      items: vi.fn(async () => {
        loads += 1;
        return {
          items: [item({ version: loads === 1 ? 1 : 5, title: loads === 1 ? "Original" : "Changed by Sam" })],
          nextCursor: null,
        };
      }),
      updateItem: vi.fn(async () => {
        throw new ApiError(409, {
          code: "version_conflict",
          message: "the resource was modified by someone else",
          details: { currentVersion: 5 },
        });
      }),
    });

    render(<BoardView client={client} board={BOARD} view={MEMBER_VIEW} userId="usr_me" />);
    await screen.findByText("Original");

    await userEvent.selectOptions(screen.getByLabelText("Status for Original"), "done");

    expect(await screen.findByText(/changed this item first/i)).toBeInTheDocument();
    // The list was refetched, so the user can see what the other person did.
    expect(await screen.findByText("Changed by Sam")).toBeInTheDocument();
    expect(loads).toBe(2);
  });

  it("reports an ordinary failure without reloading", async () => {
    const client = clientStub({
      updateItem: vi.fn(async () => {
        throw new ApiError(403, { code: "forbidden", message: "role member cannot item:assign" });
      }),
    });
    render(<BoardView client={client} board={BOARD} view={MEMBER_VIEW} userId="usr_me" />);
    await screen.findByText("Write the docs");

    await userEvent.selectOptions(screen.getByLabelText("Status for Write the docs"), "blocked");
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot item:assign");
  });

  it("removes an item it deleted", async () => {
    const client = clientStub();
    render(<BoardView client={client} board={BOARD} view={MEMBER_VIEW} userId="usr_me" />);
    await screen.findByText("Write the docs");

    await userEvent.click(screen.getByRole("button", { name: "Delete Write the docs" }));
    await waitFor(() => expect(screen.queryByText("Write the docs")).not.toBeInTheDocument());
  });

  it("merges a live event from another user", async () => {
    const handlers: Array<(event: DomainEvent) => void> = [];
    render(
      <BoardView
        client={clientStub()}
        board={BOARD}
        view={MEMBER_VIEW}
        userId="usr_me"
        onEvents={(handler) => {
          handlers.push(handler);
          return () => void handlers.splice(handlers.indexOf(handler), 1);
        }}
      />,
    );
    await screen.findByText("Write the docs");

    handlers[0]?.({
      type: "item.created",
      workspaceId: "wsp_1",
      subjectId: "itm_2",
      actorId: "usr_other",
      at: Date.now(),
      payload: item({ id: "itm_2", title: "Added by Sam" }) as unknown as Record<string, unknown>,
    });

    expect(await screen.findByText("Added by Sam")).toBeInTheDocument();
  });

  it("ignores the echo of its own action", async () => {
    // The response already carried the authoritative row; applying the echo too replaces it and
    // flickers, and can discard an in-flight optimistic update.
    const handlers: Array<(event: DomainEvent) => void> = [];
    render(
      <BoardView
        client={clientStub()}
        board={BOARD}
        view={MEMBER_VIEW}
        userId="usr_me"
        onEvents={(handler) => {
          handlers.push(handler);
          return () => undefined;
        }}
      />,
    );
    await screen.findByText("Write the docs");

    handlers[0]?.({
      type: "item.created",
      workspaceId: "wsp_1",
      subjectId: "itm_echo",
      actorId: "usr_me",
      at: Date.now(),
      payload: item({ id: "itm_echo", title: "My own echo" }) as unknown as Record<string, unknown>,
    });

    await waitFor(() => expect(screen.queryByText("My own echo")).not.toBeInTheDocument());
  });

  it("ignores an event for a different board on the same workspace channel", async () => {
    // The channel is per workspace, so a sibling board's events arrive here too.
    const handlers: Array<(event: DomainEvent) => void> = [];
    render(
      <BoardView
        client={clientStub()}
        board={BOARD}
        view={MEMBER_VIEW}
        userId="usr_me"
        onEvents={(handler) => {
          handlers.push(handler);
          return () => undefined;
        }}
      />,
    );
    await screen.findByText("Write the docs");

    handlers[0]?.({
      type: "item.created",
      workspaceId: "wsp_1",
      subjectId: "itm_other_board",
      actorId: "usr_other",
      at: Date.now(),
      payload: item({ id: "itm_other_board", boardId: "brd_2", title: "Other board" }) as unknown as Record<
        string,
        unknown
      >,
    });

    await waitFor(() => expect(screen.queryByText("Other board")).not.toBeInTheDocument());
  });

  it("removes an item deleted by somebody else", async () => {
    const handlers: Array<(event: DomainEvent) => void> = [];
    render(
      <BoardView
        client={clientStub()}
        board={BOARD}
        view={MEMBER_VIEW}
        userId="usr_me"
        onEvents={(handler) => {
          handlers.push(handler);
          return () => undefined;
        }}
      />,
    );
    await screen.findByText("Write the docs");

    handlers[0]?.({
      type: "item.deleted",
      workspaceId: "wsp_1",
      subjectId: "itm_1",
      actorId: "usr_other",
      at: Date.now(),
    });

    await waitFor(() => expect(screen.queryByText("Write the docs")).not.toBeInTheDocument());
  });

  it("groups items into status columns", async () => {
    const client = clientStub({
      items: vi.fn(async () => ({
        items: [
          item({ id: "a", title: "Open one", status: "open" }),
          item({ id: "b", title: "Done one", status: "done" }),
        ],
        nextCursor: null,
      })),
    });
    render(<BoardView client={client} board={BOARD} view={MEMBER_VIEW} userId="usr_me" />);
    await screen.findByText("Open one");

    const doneColumn = screen.getByRole("heading", { name: /^Done/ }).closest(".column");
    expect(doneColumn).not.toBeNull();
    expect(within(doneColumn as HTMLElement).getByText("Done one")).toBeInTheDocument();
  });

  it("reports a load failure", async () => {
    const client = clientStub({
      items: vi.fn(async () => {
        throw new ApiError(404, { code: "not_found", message: "board not found" });
      }),
    });
    render(<BoardView client={client} board={BOARD} view={MEMBER_VIEW} userId="usr_me" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("board not found");
  });
});

describe("SignInForm", () => {
  it("signs in and reports the user", async () => {
    const onSignedIn = vi.fn();
    const login = vi.fn(async () => ({
      user: { id: "usr_1", email: "a@b.test", name: "A", createdAt: "2026-01-01T00:00:00.000Z" },
      tokens: { accessToken: "a", refreshToken: "r", accessExpiresAt: 0 },
    }));
    render(<SignInForm client={{ login } as unknown as ApiClient} onSignedIn={onSignedIn} />);

    await userEvent.type(screen.getByLabelText("Email"), "a@b.test");
    await userEvent.type(screen.getByLabelText("Password"), "a-password-value");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(login).toHaveBeenCalledWith("a@b.test", "a-password-value");
  });

  it("shows the server's message verbatim", async () => {
    // The server gives one message for a wrong password and an unknown address, deliberately.
    // Improving on it here would turn the form into a membership oracle.
    const login = vi.fn(async () => {
      throw new ApiError(401, { code: "unauthenticated", message: "email or password is incorrect" });
    });
    render(<SignInForm client={{ login } as unknown as ApiClient} onSignedIn={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Email"), "a@b.test");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password-x");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("email or password is incorrect");
  });

  it("switches to registration and asks for a name", async () => {
    render(<SignInForm client={{} as ApiClient} onSignedIn={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /create an account instead/i }));

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Create an account" })).toBeInTheDocument();
    // `new-password` so a password manager offers to generate one.
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "new-password");
  });

  it("registers with a name", async () => {
    const onSignedIn = vi.fn();
    const registerFn = vi.fn(async () => ({
      user: { id: "usr_1", email: "a@b.test", name: "Ada", createdAt: "2026-01-01T00:00:00.000Z" },
      tokens: { accessToken: "a", refreshToken: "r", accessExpiresAt: 0 },
    }));
    render(
      <SignInForm client={{ register: registerFn } as unknown as ApiClient} onSignedIn={onSignedIn} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /create an account instead/i }));
    await userEvent.type(screen.getByLabelText("Email"), "a@b.test");
    await userEvent.type(screen.getByLabelText("Name"), "Ada");
    await userEvent.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(registerFn).toHaveBeenCalledWith({
      email: "a@b.test",
      name: "Ada",
      password: "a-long-enough-password",
    });
  });

  it("clears the error when switching mode", async () => {
    const login = vi.fn(async () => {
      throw new ApiError(401, { code: "unauthenticated", message: "email or password is incorrect" });
    });
    render(<SignInForm client={{ login } as unknown as ApiClient} onSignedIn={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Email"), "a@b.test");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password-x");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("alert");

    await userEvent.click(screen.getByRole("button", { name: /create an account instead/i }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ConnectionBadge", () => {
  it("says it is live when connected", () => {
    render(<ConnectionBadge state="ready" />);
    expect(screen.getByRole("status")).toHaveTextContent("Live");
    expect(screen.getByRole("status")).not.toHaveTextContent("out of date");
  });

  it("warns that data may be stale when it is not connected", () => {
    // A user who cannot tell "nothing changed" from "I stopped being told about changes" will trust
    // stale data.
    for (const state of ["idle", "reconnecting", "closed"] as const) {
      const { unmount } = render(<ConnectionBadge state={state} />);
      expect(screen.getByRole("status")).toHaveTextContent(/out of date/);
      unmount();
    }
  });

  it("shows the attempt count once it is retrying repeatedly", () => {
    render(<ConnectionBadge state="reconnecting" attempts={4} />);
    expect(screen.getByRole("status")).toHaveTextContent("attempt 4");
  });

  it("does not show the count on the first attempt", () => {
    render(<ConnectionBadge state="reconnecting" attempts={1} />);
    expect(screen.getByRole("status")).not.toHaveTextContent("attempt");
  });
});

describe("permission helpers", () => {
  it("mirrors the server's own/any resolution", () => {
    const mine = { createdBy: "usr_me" };
    const theirs = { createdBy: "usr_other" };

    expect(canEditItem(MEMBER_VIEW, mine, "usr_me")).toBe(true);
    expect(canEditItem(MEMBER_VIEW, theirs, "usr_me")).toBe(false);
    expect(canEditItem(ADMIN_VIEW, theirs, "usr_me")).toBe(true);

    expect(canDeleteItem(MEMBER_VIEW, mine, "usr_me")).toBe(true);
    expect(canDeleteItem(MEMBER_VIEW, theirs, "usr_me")).toBe(false);
    expect(canDeleteItem(ADMIN_VIEW, theirs, "usr_me")).toBe(true);
  });

  it("grants a viewer nothing, even on their own item", () => {
    expect(canEditItem(VIEWER_VIEW, { createdBy: "usr_me" }, "usr_me")).toBe(false);
    expect(can(VIEWER_VIEW, "item:create")).toBe(false);
  });
});
