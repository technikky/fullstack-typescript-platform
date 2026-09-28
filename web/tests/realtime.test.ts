/**
 * The WebSocket client.
 *
 * Reconnection is the whole subject. The failure mode this file exists to prevent is a fleet of
 * clients that all reconnect at the same instant after a server restart, knock it over, and repeat --
 * and the failure mode it exists to catch is subtler: a client that reconnects successfully but
 * silently stops receiving updates, because it never replayed its subscriptions.
 *
 * Time is injected rather than waited on, so the backoff curve is asserted exactly instead of
 * approximately.
 */

import { describe, expect, it, vi } from "vitest";

import { RealtimeClient, type ConnectionState, type DomainEvent, type WebSocketLike } from "@/lib/realtime";

/** A socket the test drives. */
class FakeSocket implements WebSocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000): void {
    if (this.closedWith !== null) return;
    this.closedWith = code;
    this.onclose?.({ code });
  }

  /** Simulate the server accepting the connection. */
  open(): void {
    this.onopen?.();
  }

  /** Simulate a server message. */
  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  receiveRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** Simulate the connection dropping. */
  drop(code = 1006): void {
    this.closedWith = code;
    this.onclose?.({ code });
  }

  sentTypes(): string[] {
    return this.sent.map((message) => String(message["type"]));
  }
}

interface Harness {
  readonly client: RealtimeClient;
  readonly sockets: FakeSocket[];
  readonly states: ConnectionState[];
  readonly events: DomainEvent[];
  readonly errors: Array<{ code: string; message: string }>;
  readonly unsubscribed: Array<{ workspaceId: string; reason: string | null }>;
  /** Run the pending reconnect timer, if any. */
  runTimers(): void;
  readonly delays: number[];
  readonly latest: () => FakeSocket;
}

const harness = (options: { token?: string | null } = {}): Harness => {
  const sockets: FakeSocket[] = [];
  const states: ConnectionState[] = [];
  const events: DomainEvent[] = [];
  const errors: Array<{ code: string; message: string }> = [];
  const unsubscribed: Array<{ workspaceId: string; reason: string | null }> = [];
  const delays: number[] = [];
  const pending: Array<() => void> = [];

  const client = new RealtimeClient({
    url: "ws://api.test/ws",
    token: () => (options.token === undefined ? "access-1" : options.token),
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onEvent: (event) => events.push(event),
    onState: (state) => states.push(state),
    onError: (code, message) => errors.push({ code, message }),
    onUnsubscribed: (workspaceId, reason) => unsubscribed.push({ workspaceId, reason }),
    setTimeoutFn: (handler, millis) => {
      delays.push(millis);
      pending.push(handler);
      return pending.length;
    },
    clearTimeoutFn: () => void pending.splice(0),
    // Fixed, so the jitter range is asserted deterministically rather than flakily.
    random: () => 1,
  });

  return {
    client,
    sockets,
    states,
    events,
    errors,
    unsubscribed,
    delays,
    runTimers: () => {
      for (const handler of pending.splice(0)) handler();
    },
    latest: () => sockets[sockets.length - 1]!,
  };
};

/** Connect and reach `ready`. */
const ready = (test: Harness): FakeSocket => {
  test.client.connect();
  const socket = test.latest();
  socket.open();
  socket.receive({ type: "ready", userId: "usr_1" });
  return socket;
};

describe("connecting", () => {
  it("authenticates from the first message, never the URL", () => {
    const test = harness();
    test.client.connect();
    const socket = test.latest();
    socket.open();

    // A handshake URL carrying a credential ends up in access logs, proxy logs and browser history.
    expect(socket.sent[0]).toEqual({ type: "authenticate", token: "access-1" });
  });

  it("moves through connecting, authenticating, ready", () => {
    const test = harness();
    ready(test);
    expect(test.states).toEqual(["connecting", "authenticating", "ready"]);
  });

  it("does nothing without a token", () => {
    // Not an error and not a retry: the caller reconnects once it has one.
    const test = harness({ token: null });
    test.client.connect();
    expect(test.sockets).toHaveLength(0);
    expect(test.client.state).toBe("idle");
  });

  it("does not open a second socket while one is open", () => {
    const test = harness();
    test.client.connect();
    test.client.connect();
    expect(test.sockets).toHaveLength(1);
  });
});

describe("subscriptions", () => {
  it("subscribes once ready", () => {
    const test = harness();
    const socket = ready(test);
    test.client.subscribe("wsp_1");
    expect(socket.sent).toContainEqual({ type: "subscribe", workspaceId: "wsp_1" });
  });

  it("remembers a subscription requested before the connection is ready", () => {
    const test = harness();
    test.client.subscribe("wsp_1");
    expect(test.client.subscriptions).toEqual(["wsp_1"]);

    const socket = ready(test);
    // Sent on `ready`, not dropped.
    expect(socket.sent).toContainEqual({ type: "subscribe", workspaceId: "wsp_1" });
  });

  it("replays every subscription after a reconnect", () => {
    // A client that reconnects but forgets what it was watching shows data that silently stops
    // updating, which is worse than a visible disconnection.
    const test = harness();
    ready(test);
    test.client.subscribe("wsp_1");
    test.client.subscribe("wsp_2");

    test.latest().drop();
    test.runTimers();
    const reconnected = test.latest();
    reconnected.open();
    reconnected.receive({ type: "ready", userId: "usr_1" });

    const resubscribed = reconnected.sent
      .filter((message) => message["type"] === "subscribe")
      .map((message) => message["workspaceId"]);
    expect(new Set(resubscribed)).toEqual(new Set(["wsp_1", "wsp_2"]));
  });

  it("stops wanting a subscription the server dropped", () => {
    // Otherwise the next reconnect asks again and is refused again, forever.
    const test = harness();
    const socket = ready(test);
    test.client.subscribe("wsp_1");

    socket.receive({ type: "unsubscribed", workspaceId: "wsp_1", reason: "access revoked" });

    expect(test.client.subscriptions).toEqual([]);
    expect(test.unsubscribed).toEqual([{ workspaceId: "wsp_1", reason: "access revoked" }]);
  });

  it("unsubscribes on request", () => {
    const test = harness();
    const socket = ready(test);
    test.client.subscribe("wsp_1");
    test.client.unsubscribe("wsp_1");

    expect(socket.sent).toContainEqual({ type: "unsubscribe", workspaceId: "wsp_1" });
    expect(test.client.subscriptions).toEqual([]);
  });
});

describe("messages", () => {
  it("delivers events", () => {
    const test = harness();
    const socket = ready(test);
    const event: DomainEvent = {
      type: "item.created",
      workspaceId: "wsp_1",
      subjectId: "itm_1",
      actorId: "usr_2",
      at: 1,
    };
    socket.receive({ type: "event", event });
    expect(test.events).toEqual([event]);
  });

  it("surfaces a server error", () => {
    const test = harness();
    const socket = ready(test);
    socket.receive({ type: "error", code: "not_found", message: "workspace not found" });
    expect(test.errors).toEqual([{ code: "not_found", message: "workspace not found" }]);
  });

  it("ignores anything unparseable or unknown without throwing", () => {
    const test = harness();
    const socket = ready(test);
    socket.receiveRaw("not json");
    socket.receiveRaw(42);
    socket.receive({ type: "unrecognised" });
    socket.receive({ type: "event" }); // no event payload
    expect(test.events).toEqual([]);
    expect(test.errors).toEqual([]);
  });

  it("sends a ping", () => {
    const test = harness();
    const socket = ready(test);
    test.client.ping();
    expect(socket.sentTypes()).toContain("ping");
  });
});

describe("reconnection", () => {
  it("backs off exponentially up to a ceiling", () => {
    const test = harness();
    // `random: () => 1` puts every delay at the top of its jitter window, so the curve is exact.
    expect(test.client.backoffMillis(1)).toBe(500);
    expect(test.client.backoffMillis(2)).toBe(1000);
    expect(test.client.backoffMillis(3)).toBe(2000);
    expect(test.client.backoffMillis(10)).toBe(30_000);
    expect(test.client.backoffMillis(50)).toBe(30_000);
  });

  it("jitters, so clients that dropped together do not return together", () => {
    // Without jitter the backoff curve changes but the thundering herd does not: every client in the
    // fleet waits the same interval and retries in the same instant.
    const lowJitter = new RealtimeClient({
      url: "ws://api.test/ws",
      token: () => "t",
      socketFactory: () => new FakeSocket(),
      random: () => 0,
    });
    const highJitter = new RealtimeClient({
      url: "ws://api.test/ws",
      token: () => "t",
      socketFactory: () => new FakeSocket(),
      random: () => 1,
    });
    expect(lowJitter.backoffMillis(4)).toBe(2000);
    expect(highJitter.backoffMillis(4)).toBe(4000);
  });

  it("schedules a reconnect with an increasing delay", () => {
    const test = harness();
    ready(test);

    test.latest().drop();
    expect(test.delays).toEqual([500]);
    test.runTimers();

    test.latest().drop();
    expect(test.delays).toEqual([500, 1000]);
  });

  it("resets the backoff only once the connection is usable", () => {
    // Reset on `open` would be wrong: a socket that opens and is then rejected has not succeeded, and
    // resetting there turns a rejection loop into a tight retry loop.
    const test = harness();
    ready(test);
    test.latest().drop();
    test.runTimers();
    expect(test.client.attempts).toBe(1);

    const reconnected = test.latest();
    reconnected.open();
    expect(test.client.attempts).toBe(1);
    reconnected.receive({ type: "ready", userId: "usr_1" });
    expect(test.client.attempts).toBe(0);
  });

  it("does not reconnect after an authentication failure", () => {
    // A bad token will still be bad in 500 ms. Retrying burns the rate limit and delays the sign-in
    // prompt the user needs.
    const test = harness();
    test.client.connect();
    test.latest().open();
    test.latest().drop(4001);

    expect(test.delays).toEqual([]);
    expect(test.client.state).toBe("closed");
    expect(test.errors[0]?.code).toBe("unauthenticated");
  });

  it("does not reconnect after a deliberate close", () => {
    const test = harness();
    ready(test);
    test.client.close();
    expect(test.delays).toEqual([]);
    expect(test.client.state).toBe("closed");
  });

  it("cancels a pending reconnect when closed", () => {
    // Otherwise a client that signed out reconnects a moment later, with a token it no longer has.
    const test = harness();
    ready(test);
    test.latest().drop();
    test.client.close();
    test.runTimers();
    // One socket for the original connection, and no more.
    expect(test.sockets).toHaveLength(1);
  });

  it("does not schedule two reconnects for one failure", () => {
    // `onerror` is always followed by `onclose`; handling both would double up.
    const test = harness();
    ready(test);
    const socket = test.latest();
    socket.onerror?.();
    socket.drop();
    expect(test.delays).toHaveLength(1);
  });
});

describe("state reporting", () => {
  it("does not repeat the same state", () => {
    const test = harness();
    const onState = vi.fn();
    const client = new RealtimeClient({
      url: "ws://api.test/ws",
      token: () => "t",
      socketFactory: () => test.latest() ?? new FakeSocket(),
      onState,
    });
    client.connect();
    client.connect();
    // A listener that receives "connecting" twice would render a spinner twice.
    expect(onState.mock.calls.filter(([state]) => state === "connecting")).toHaveLength(1);
  });

  it("reports reconnecting before ready again", () => {
    const test = harness();
    ready(test);
    test.latest().drop();
    test.runTimers();
    const reconnected = test.latest();
    reconnected.open();
    reconnected.receive({ type: "ready", userId: "usr_1" });

    expect(test.states).toEqual([
      "connecting",
      "authenticating",
      "ready",
      "reconnecting",
      "authenticating",
      "ready",
    ]);
  });
});
