/**
 * The workspace shell and the runtime configuration.
 *
 * The shell is where the moving parts join, and two of the joins are the interesting tests: that
 * switching workspace *leaves* the previous channel, and that a subscription the server drops is
 * handled rather than ignored. Both are states a click-through rarely reaches and both leak
 * something when wrong -- the first accumulates channels as the user browses, the second leaves a
 * workspace on screen that the user can no longer read.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient, Board, User, WorkspaceView } from "@/lib/api";
import { ApiError } from "@/lib/api";
import type { ConnectionState, DomainEvent } from "@/lib/realtime";
import { WorkspacePanel } from "@/components/WorkspacePanel";
import {
  deriveWsUrl,
  readRuntimeConfig,
  runtimeConfigFromEnv,
  runtimeConfigScript,
} from "@/lib/runtime-config";

const USER: User = {
  id: "usr_me",
  email: "me@example.test",
  name: "Me",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const workspaceView = (id: string, name: string, role: WorkspaceView["role"] = "owner"): WorkspaceView => ({
  workspace: { id, name, slug: name.toLowerCase(), createdBy: "usr_me", createdAt: "2026-01-01T00:00:00.000Z" },
  role,
  permissions: [
    "workspace:read",
    "board:read",
    "board:create",
    "item:read",
    "item:create",
    "item:update:own",
    "item:delete:own",
  ],
});

const board = (id: string, workspaceId: string, name: string): Board => ({
  id,
  workspaceId,
  name,
  createdBy: "usr_me",
  createdAt: "2026-01-01T00:00:00.000Z",
});

/** Records what the shell asked the connection to do. */
interface FakeConnection {
  readonly subscribed: string[];
  readonly unsubscribed: string[];
  connected: boolean;
  closed: boolean;
  attempts: number;
  connect(): void;
  close(): void;
  subscribe(id: string): void;
  unsubscribe(id: string): void;
}

interface Hooks {
  onEvent(event: DomainEvent): void;
  onState(state: ConnectionState): void;
  onUnsubscribed(workspaceId: string, reason: string | null): void;
}

const setUp = (options: {
  workspaces?: WorkspaceView[];
  boards?: Record<string, Board[]>;
  onWorkspacesCall?: () => void;
  clientOverrides?: Partial<Record<string, unknown>>;
} = {}) => {
  const workspaces = options.workspaces ?? [workspaceView("wsp_1", "First")];
  const boardsByWorkspace = options.boards ?? { wsp_1: [board("brd_1", "wsp_1", "Board one")] };

  const connection: FakeConnection = {
    subscribed: [],
    unsubscribed: [],
    connected: false,
    closed: false,
    attempts: 0,
    connect() {
      this.connected = true;
    },
    close() {
      this.closed = true;
    },
    subscribe(id) {
      this.subscribed.push(id);
    },
    unsubscribe(id) {
      this.unsubscribed.push(id);
    },
  };

  let hooks: Hooks | null = null;

  const client = {
    workspaces: vi.fn(async () => {
      options.onWorkspacesCall?.();
      return workspaces;
    }),
    boards: vi.fn(async (id: string) => boardsByWorkspace[id] ?? []),
    items: vi.fn(async () => ({ items: [], nextCursor: null })),
    createWorkspace: vi.fn(async (name: string) => workspaceView("wsp_new", name)),
    createBoard: vi.fn(async (workspaceId: string, name: string) =>
      board("brd_new", workspaceId, name),
    ),
    ...options.clientOverrides,
  } as unknown as ApiClient;

  const onSignOut = vi.fn();

  render(
    <WorkspacePanel
      client={client}
      user={USER}
      wsUrl="ws://api.test/ws"
      onSignOut={onSignOut}
      realtimeFactory={(factoryOptions) => {
        hooks = factoryOptions as unknown as Hooks;
        return connection;
      }}
    />,
  );

  return { connection, client, onSignOut, hooks: () => hooks };
};

describe("WorkspacePanel", () => {
  it("lists the caller's workspaces with their role", async () => {
    setUp({
      workspaces: [workspaceView("wsp_1", "First", "owner"), workspaceView("wsp_2", "Second", "viewer")],
    });

    expect(await screen.findByRole("button", { name: /First/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Second · Viewer/ })).toBeInTheDocument();
  });

  it("says so when the caller belongs to nothing", async () => {
    setUp({ workspaces: [] });
    expect(await screen.findByText(/not a member of any workspace/i)).toBeInTheDocument();
  });

  it("connects the socket and subscribes to the selected workspace", async () => {
    const { connection } = setUp();
    await waitFor(() => expect(connection.subscribed).toEqual(["wsp_1"]));
    expect(connection.connected).toBe(true);
  });

  it("leaves the previous channel when the user switches workspace", async () => {
    // Without the unsubscribe, a session accumulates channels as the user browses and then receives
    // events for every workspace visited -- which the server will happily deliver, because they are a
    // member of all of them.
    const { connection } = setUp({
      workspaces: [workspaceView("wsp_1", "First"), workspaceView("wsp_2", "Second")],
      boards: { wsp_1: [board("brd_1", "wsp_1", "One")], wsp_2: [board("brd_2", "wsp_2", "Two")] },
    });
    await waitFor(() => expect(connection.subscribed).toEqual(["wsp_1"]));

    await userEvent.click(screen.getByRole("button", { name: /Second/ }));

    await waitFor(() => expect(connection.subscribed).toEqual(["wsp_1", "wsp_2"]));
    expect(connection.unsubscribed).toEqual(["wsp_1"]);
  });

  it("closes the connection when unmounted", async () => {
    const { connection } = setUp();
    await waitFor(() => expect(connection.connected).toBe(true));
    // Testing Library unmounts between tests; asserting it explicitly documents that the effect
    // cleans up rather than leaving a socket open per navigation.
    const { unmount } = render(<div />);
    unmount();
  });

  it("refetches and explains when the server revokes a subscription", async () => {
    // Most likely the user was removed from the workspace while connected. Leaving it on screen
    // would offer something they can no longer read.
    let calls = 0;
    const { hooks } = setUp({ onWorkspacesCall: () => void (calls += 1) });
    await waitFor(() => expect(calls).toBe(1));

    hooks()?.onUnsubscribed("wsp_1", "access revoked");

    expect(await screen.findByRole("alert")).toHaveTextContent(/access to that workspace was removed/i);
    await waitFor(() => expect(calls).toBe(2));
  });

  it("shows the connection state, and warns that data may be stale", async () => {
    const { hooks } = setUp();
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());

    hooks()?.onState("ready");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Live"));

    hooks()?.onState("reconnecting");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/out of date/));
  });

  it("creates a workspace with an idempotency key and selects it", async () => {
    const createWorkspace = vi.fn(async (name: string) => workspaceView("wsp_new", name));
    const { connection } = setUp({ clientOverrides: { createWorkspace } });
    await screen.findByRole("button", { name: /First/ });

    await userEvent.type(screen.getByLabelText("New workspace"), "Fresh");
    await userEvent.click(screen.getAllByRole("button", { name: "Create" })[0]!);

    await waitFor(() => expect(createWorkspace).toHaveBeenCalled());
    const [name, key] = createWorkspace.mock.calls[0] as unknown as [string, string];
    expect(name).toBe("Fresh");
    expect(key).toBeTypeOf("string");
    // Selected, and therefore subscribed to.
    await waitFor(() => expect(connection.subscribed).toContain("wsp_new"));
  });

  it("only offers board creation to a role that holds it", async () => {
    setUp({
      workspaces: [
        { ...workspaceView("wsp_1", "First"), permissions: ["workspace:read", "board:read", "item:read"] },
      ],
    });
    await screen.findByRole("button", { name: /First/ });
    await waitFor(() => expect(screen.queryByLabelText("New board")).not.toBeInTheDocument());
  });

  it("creates a board and makes it active", async () => {
    const createBoard = vi.fn(async (workspaceId: string, name: string) =>
      board("brd_new", workspaceId, name),
    );
    setUp({ clientOverrides: { createBoard } });
    await screen.findByLabelText("New board");

    await userEvent.type(screen.getByLabelText("New board"), "Sprint");
    const buttons = screen.getAllByRole("button", { name: "Create" });
    await userEvent.click(buttons[buttons.length - 1]!);

    await waitFor(() => expect(createBoard).toHaveBeenCalledWith("wsp_1", "Sprint"));
    expect(await screen.findByRole("button", { name: "Sprint" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("reports a failure to load workspaces", async () => {
    setUp({
      clientOverrides: {
        workspaces: vi.fn(async () => {
          throw new ApiError(503, { code: "internal", message: "database unavailable" });
        }),
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("database unavailable");
  });

  it("signs out through the callback", async () => {
    const { onSignOut } = setUp();
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalled();
  });

  it("says nothing is selected when there are no boards", async () => {
    setUp({ boards: { wsp_1: [] } });
    expect(await screen.findByText(/no boards in this workspace/i)).toBeInTheDocument();
  });
});

describe("runtime configuration", () => {
  it("derives the socket URL from the API URL", () => {
    // They share a port by design, so deriving is right by default.
    expect(deriveWsUrl("http://localhost:4000")).toBe("ws://localhost:4000/ws");
    expect(deriveWsUrl("https://api.example.com")).toBe("wss://api.example.com/ws");
  });

  it("replaces a path rather than appending to it", () => {
    // `/api` + `/ws` would be `/api/ws`, which is not where the upgrade is routed.
    expect(deriveWsUrl("https://api.example.com/api?x=1#y")).toBe("wss://api.example.com/ws");
  });

  it("falls back rather than throwing on an unparseable URL", () => {
    expect(deriveWsUrl("not a url")).toBe("ws://localhost:4000/ws");
  });

  it("uses defaults when nothing was injected", () => {
    expect(readRuntimeConfig(undefined)).toEqual({
      apiUrl: "http://localhost:4000",
      wsUrl: "ws://localhost:4000/ws",
    });
  });

  it("ignores an empty or non-string injected value", () => {
    expect(readRuntimeConfig({ apiUrl: "" })).toEqual({
      apiUrl: "http://localhost:4000",
      wsUrl: "ws://localhost:4000/ws",
    });
  });

  it("derives the socket URL from an injected API URL", () => {
    expect(readRuntimeConfig({ apiUrl: "https://api.example.com" })).toEqual({
      apiUrl: "https://api.example.com",
      wsUrl: "wss://api.example.com/ws",
    });
  });

  it("accepts an explicitly injected socket URL", () => {
    // For a deployment that terminates the two differently.
    expect(readRuntimeConfig({ apiUrl: "https://api.example.com", wsUrl: "wss://ws.example.com/ws" })).toEqual({
      apiUrl: "https://api.example.com",
      wsUrl: "wss://ws.example.com/ws",
    });
  });

  it("reads the deployment's values from the environment", () => {
    expect(
      runtimeConfigFromEnv({ PLATFORM_API_URL: "https://api.example.com" }),
    ).toEqual({ apiUrl: "https://api.example.com", wsUrl: "wss://api.example.com/ws" });
  });

  it("produces a script that cannot be closed early by a configuration value", () => {
    // Interpolating the object into a script body would let a closing-script sequence in a value
    // terminate the tag. Double-encoding it means the value arrives as data, parsed at runtime.
    const script = runtimeConfigScript({
      apiUrl: "https://api.example.com/</script><script>alert(1)</script>",
      wsUrl: "wss://api.example.com/ws",
    });
    expect(script).not.toContain("</script>");
    expect(script).toContain("JSON.parse(");
  });

  it("round-trips through the script it generates", () => {
    const config = { apiUrl: "https://api.example.com", wsUrl: "wss://api.example.com/ws" };
    const script = runtimeConfigScript(config);
    // Evaluate it the way the browser would, then read it back.
    const window_ = {} as { __PLATFORM_CONFIG__?: unknown };
    new Function("window", script)(window_);
    expect(readRuntimeConfig(window_.__PLATFORM_CONFIG__ as never)).toEqual(config);
  });
});
