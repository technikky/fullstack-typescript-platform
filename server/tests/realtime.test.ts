/**
 * The realtime hub.
 *
 * Three properties are worth more than the rest of this file, and each is a bug in most
 * implementations:
 *
 * 1. **Fan-out survives more than one replica.** Two hubs sharing one broker is the same topology
 *    as two pods sharing one Redis. An implementation that iterates its own socket list passes
 *    every single-process test and silently breaks on scale-up, and the failure is invisible in
 *    development because there is only ever one process.
 * 2. **A revoked member stops receiving events immediately.** A socket authorised at subscribe
 *    time stays open for hours. Removing someone must take effect now, not at their next
 *    reconnect.
 * 3. **Channels are the authorization boundary.** A socket that is not subscribed cannot receive
 *    another workspace's events at all, rather than receiving them and being filtered.
 *
 * The socket is a small fake implementing the `Socket` interface the hub takes. That is not
 * mocking the behaviour under test -- the hub's logic, the broker, the token verification and the
 * membership lookups are all real. It avoids binding a port, which would make these tests slow
 * and flaky for no extra coverage. `tests/e2e-ws.test.ts` drives a real `ws` connection over a
 * real HTTP upgrade for the parts a fake cannot prove.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { MemoryBroker } from "../src/adapters/memory-keyvalue.js";
import { MINUTE } from "../src/clock.js";
import { workspaceChannel, decodeEvent, encodeEvent, EventBuffer } from "../src/domain/events.js";
import {
  CLOSE_AUTH_TIMEOUT,
  CLOSE_PROTOCOL,
  CLOSE_UNAUTHENTICATED,
  RealtimeHub,
  type ServerMessage,
  type Socket,
} from "../src/realtime/hub.js";
import { TokenService } from "../src/auth/tokens.js";
import {
  createBoard,
  createHarness,
  createUser,
  createWorkspace,
  type Harness,
  type TestUser,
} from "./support/harness.js";

/** A socket that records what was sent to it. */
class FakeSocket implements Socket {
  readonly sent: ServerMessage[] = [];
  closed: { code?: number; reason?: string } | null = null;
  #messageHandler: ((data: unknown) => void) | null = null;
  #closeHandler: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  close(code?: number, reason?: string): void {
    if (this.closed !== null) return;
    this.closed = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
    this.#closeHandler?.();
  }

  on(event: "message" | "close", handler: (data?: unknown) => void): void {
    if (event === "message") this.#messageHandler = handler as (data: unknown) => void;
    else this.#closeHandler = handler as () => void;
  }

  /**
   * Simulate the client sending a frame, and wait for the hub to finish handling it.
   *
   * Polled rather than a fixed number of ticks. The hub's message handler is async and the
   * socket interface gives it nowhere to return a promise, so there is nothing to await
   * directly -- and the depth of the await chain varies: authenticating verifies a JWT and
   * reads the denylist, subscribing queries the database. A fixed `await Promise.resolve()`
   * twice was enough for every case except the first authentication in a process, where
   * jose's one-off key import pushed it over. Waiting for the observable effect instead
   * removes the guesswork.
   */
  async receive(message: Record<string, unknown>, expectReply = true): Promise<void> {
    await this.#deliver(JSON.stringify(message), expectReply);
  }

  /** Simulate a raw frame that is not a JSON object. */
  async receiveRaw(payload: string): Promise<void> {
    await this.#deliver(payload, true);
  }

  async #deliver(payload: string, expectReply: boolean): Promise<void> {
    const before = this.sent.length;
    this.#messageHandler?.(payload);
    for (let tick = 0; tick < 50; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (!expectReply) return;
      if (this.sent.length > before || this.closed !== null) return;
    }
  }

  types(): string[] {
    return this.sent.map((message) => message.type);
  }

  last(): ServerMessage | undefined {
    return this.sent[this.sent.length - 1];
  }
}

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});
afterEach(async () => {
  await harness.container.hub.closeAll();
  await harness.reset();
});
afterAll(async () => {
  await harness.close();
});

/** Connect a socket and authenticate it. */
const connect = async (user: TestUser): Promise<FakeSocket> => {
  const socket = new FakeSocket();
  harness.container.hub.accept(socket);
  await socket.receive({ type: "authenticate", token: user.accessToken });
  return socket;
};

const subscribe = async (socket: FakeSocket, workspaceId: string): Promise<void> => {
  await socket.receive({ type: "subscribe", workspaceId });
};

describe("authentication", () => {
  it("accepts a valid token and reports the user", async () => {
    const user = await createUser(harness);
    const socket = await connect(user);
    expect(socket.last()).toEqual({ type: "ready", userId: user.id });
  });

  it("closes on an invalid token", async () => {
    const socket = new FakeSocket();
    harness.container.hub.accept(socket);
    await socket.receive({ type: "authenticate", token: "garbage" });
    expect(socket.closed?.code).toBe(CLOSE_UNAUTHENTICATED);
  });

  it("closes on an expired token", async () => {
    const user = await createUser(harness);
    harness.clock.advance(11 * MINUTE);
    const socket = new FakeSocket();
    harness.container.hub.accept(socket);
    await socket.receive({ type: "authenticate", token: user.accessToken });
    expect(socket.closed?.code).toBe(CLOSE_UNAUTHENTICATED);
  });

  it("rejects a revoked token, because the denylist is consulted here too", async () => {
    const user = await createUser(harness);
    const claims = await harness.container.tokens.verifyAccess(user.accessToken);
    await harness.container.tokens.logout(claims);

    const socket = new FakeSocket();
    harness.container.hub.accept(socket);
    await socket.receive({ type: "authenticate", token: user.accessToken });
    expect(socket.closed?.code).toBe(CLOSE_UNAUTHENTICATED);
  });

  it("refuses to subscribe before authenticating, and closes", async () => {
    const socket = new FakeSocket();
    harness.container.hub.accept(socket);
    await socket.receive({ type: "subscribe", workspaceId: "wsp_ANYTHING000000000000000" });

    expect(socket.sent[0]).toMatchObject({ type: "error", code: "unauthenticated" });
    expect(socket.closed?.code).toBe(CLOSE_PROTOCOL);
  });

  it("closes an unauthenticated socket after the timeout", async () => {
    // An unauthenticated socket sitting open is a consumed connection slot.
    const broker = new MemoryBroker();
    const hub = new RealtimeHub({
      broker,
      tokens: harness.container.tokens,
      workspaces: harness.container.workspaces,
      clock: harness.clock,
      authTimeoutMillis: 5,
    });
    const socket = new FakeSocket();
    hub.accept(socket);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(socket.closed?.code).toBe(CLOSE_AUTH_TIMEOUT);
    await hub.closeAll();
    await broker.close();
  });

  it("answers a ping without a token", async () => {
    // Keepalive must work before authentication, or a client that is slow to obtain a token gets
    // dropped by an intermediary for being idle.
    const socket = new FakeSocket();
    harness.container.hub.accept(socket);
    await socket.receive({ type: "ping" });
    expect(socket.last()).toEqual({ type: "pong" });
  });

  it("reports a malformed frame without closing", async () => {
    const user = await createUser(harness);
    const socket = await connect(user);
    for (const payload of ["not json", "[]", '"a string"', '{"type":"unknown"}']) {
      await socket.receiveRaw(payload);
    }
    expect(socket.sent.filter((message) => message.type === "error")).toHaveLength(4);
    expect(socket.closed).toBeNull();
  });
});

describe("subscription authorization", () => {
  it("subscribes a member", async () => {
    const user = await createUser(harness);
    const workspace = await createWorkspace(harness, user);
    const socket = await connect(user);
    await subscribe(socket, workspace.id);

    expect(socket.last()).toEqual({ type: "subscribed", workspaceId: workspace.id });
    expect(harness.container.hub.subscriberCount(workspace.id)).toBe(1);
  });

  it("refuses a workspace the caller is not a member of", async () => {
    const [owner, stranger] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner);
    const socket = await connect(stranger);
    await subscribe(socket, workspace.id);

    expect(socket.last()).toMatchObject({ type: "error", code: "not_found" });
    expect(harness.container.hub.subscriberCount(workspace.id)).toBe(0);
  });

  it("gives the same answer for a workspace that does not exist", async () => {
    // A socket must not be a cheaper membership oracle than the HTTP API.
    const user = await createUser(harness);
    const socket = await connect(user);
    await subscribe(socket, "wsp_NOSUCHWORKSPACE00000000");
    expect(socket.last()).toMatchObject({ type: "error", code: "not_found", message: "workspace not found" });
  });

  it("subscribing twice is idempotent", async () => {
    const user = await createUser(harness);
    const workspace = await createWorkspace(harness, user);
    const socket = await connect(user);
    await subscribe(socket, workspace.id);
    await subscribe(socket, workspace.id);
    expect(harness.container.hub.subscriberCount(workspace.id)).toBe(1);
  });

  it("unsubscribes on request", async () => {
    const user = await createUser(harness);
    const workspace = await createWorkspace(harness, user);
    const socket = await connect(user);
    await subscribe(socket, workspace.id);
    await socket.receive({ type: "unsubscribe", workspaceId: workspace.id });

    expect(socket.last()).toEqual({ type: "unsubscribed", workspaceId: workspace.id });
    expect(harness.container.hub.subscriberCount(workspace.id)).toBe(0);
  });

  it("cleans up every subscription when the socket closes", async () => {
    const user = await createUser(harness);
    const [first, second] = [await createWorkspace(harness, user), await createWorkspace(harness, user)];
    const socket = await connect(user);
    await subscribe(socket, first.id);
    await subscribe(socket, second.id);

    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.container.hub.subscriberCount(first.id)).toBe(0);
    expect(harness.container.hub.subscriberCount(second.id)).toBe(0);
    expect(harness.broker.channelCount).toBe(0);
  });
});

describe("event delivery", () => {
  it("delivers an event to a subscriber", async () => {
    const user = await createUser(harness);
    const workspace = await createWorkspace(harness, user);
    const socket = await connect(user);
    await subscribe(socket, workspace.id);

    const events = new EventBuffer();
    await harness.container.work.createBoard(workspace.id, user.id, "Board", events);
    await harness.container.hub.publish(events.drain());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const delivered = socket.sent.filter((message) => message.type === "event");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      type: "event",
      event: { type: "board.created", workspaceId: workspace.id, actorId: user.id },
    });
  });

  it("does not deliver another workspace's events", async () => {
    // The channel is the boundary: a socket not subscribed cannot receive the message at all,
    // rather than receiving it and being filtered.
    const user = await createUser(harness);
    const [mine, theirs] = [await createWorkspace(harness, user), await createWorkspace(harness, user)];
    const socket = await connect(user);
    await subscribe(socket, mine.id);

    const events = new EventBuffer();
    await harness.container.work.createBoard(theirs.id, user.id, "Board", events);
    await harness.container.hub.publish(events.drain());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.sent.filter((message) => message.type === "event")).toHaveLength(0);
  });

  it("delivers to every subscriber of a workspace", async () => {
    const [owner, member] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: member, role: "member" }]);
    const ownerSocket = await connect(owner);
    const memberSocket = await connect(member);
    await subscribe(ownerSocket, workspace.id);
    await subscribe(memberSocket, workspace.id);

    const events = new EventBuffer();
    await harness.container.work.createBoard(workspace.id, owner.id, "Board", events);
    await harness.container.hub.publish(events.drain());
    await new Promise((resolve) => setTimeout(resolve, 0));

    for (const socket of [ownerSocket, memberSocket]) {
      expect(socket.sent.filter((message) => message.type === "event")).toHaveLength(1);
    }
  });

  it("carries the actor, so a client can skip echoing its own action", async () => {
    const user = await createUser(harness);
    const workspace = await createWorkspace(harness, user);
    const board = await createBoard(harness, workspace.id, user);
    const socket = await connect(user);
    await subscribe(socket, workspace.id);

    const events = new EventBuffer();
    await harness.container.work.createItem(board.id, user.id, { title: "T" }, events);
    await harness.container.hub.publish(events.drain());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = socket.sent.find((message) => message.type === "event");
    expect(event).toMatchObject({ event: { actorId: user.id, type: "item.created" } });
  });

  it("carries the changed entity, so a client need not re-fetch", async () => {
    // Otherwise one write turns into N reads across every connected client.
    const user = await createUser(harness);
    const workspace = await createWorkspace(harness, user);
    const board = await createBoard(harness, workspace.id, user);
    const socket = await connect(user);
    await subscribe(socket, workspace.id);

    const events = new EventBuffer();
    const item = await harness.container.work.createItem(board.id, user.id, { title: "Titled" }, events);
    await harness.container.hub.publish(events.drain());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = socket.sent.find((message) => message.type === "event");
    expect(event).toMatchObject({ event: { payload: { id: item.id, title: "Titled", version: 1 } } });
  });

  it("ignores a malformed message on the channel rather than dropping the socket", async () => {
    // A broker is shared infrastructure: another process, an old deployment mid-rollout, or a
    // stray `redis-cli publish` must not take down the socket pump for everyone on this replica.
    const user = await createUser(harness);
    const workspace = await createWorkspace(harness, user);
    const socket = await connect(user);
    await subscribe(socket, workspace.id);

    await harness.broker.publish(workspaceChannel(workspace.id), "not json at all");
    await harness.broker.publish(workspaceChannel(workspace.id), JSON.stringify({ nope: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.sent.filter((message) => message.type === "event")).toHaveLength(0);
    expect(socket.closed).toBeNull();
  });
});

describe("fan-out across replicas", () => {
  it("an event published on one hub reaches a subscriber on another", async () => {
    // Two hubs sharing one broker is the same topology as two pods sharing one Redis. A hub that
    // iterated its own socket list would pass every other test in this file and fail this one.
    const user = await createUser(harness);
    const workspace = await createWorkspace(harness, user);

    const secondHub = new RealtimeHub({
      broker: harness.broker,
      tokens: harness.container.tokens,
      workspaces: harness.container.workspaces,
      clock: harness.clock,
    });
    try {
      const onFirst = await connect(user);
      await subscribe(onFirst, workspace.id);

      const onSecond = new FakeSocket();
      secondHub.accept(onSecond);
      await onSecond.receive({ type: "authenticate", token: user.accessToken });
      await onSecond.receive({ type: "subscribe", workspaceId: workspace.id });

      // Published through the *second* hub; the subscriber on the first must still see it.
      const events = new EventBuffer();
      await harness.container.work.createBoard(workspace.id, user.id, "Board", events);
      await secondHub.publish(events.drain());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onFirst.sent.filter((message) => message.type === "event")).toHaveLength(1);
      expect(onSecond.sent.filter((message) => message.type === "event")).toHaveLength(1);
    } finally {
      await secondHub.closeAll();
    }
  });

  it("a hub with a different token secret cannot authenticate a foreign token", async () => {
    // Two deployments sharing a broker must not share sessions.
    const user = await createUser(harness);
    const otherTokens = new TokenService({
      database: harness.container.database,
      keyValue: harness.keyValue,
      clock: harness.clock,
      config: {
        secret: new TextEncoder().encode("an-entirely-different-secret-value-here"),
        issuer: "platform-test",
        audience: "platform-test-api",
        accessTtlMillis: 10 * MINUTE,
        refreshTtlMillis: 30 * 24 * 60 * MINUTE,
      },
    });
    const foreignHub = new RealtimeHub({
      broker: harness.broker,
      tokens: otherTokens,
      workspaces: harness.container.workspaces,
      clock: harness.clock,
    });
    try {
      const socket = new FakeSocket();
      foreignHub.accept(socket);
      await socket.receive({ type: "authenticate", token: user.accessToken });
      expect(socket.closed?.code).toBe(CLOSE_UNAUTHENTICATED);
    } finally {
      await foreignHub.closeAll();
    }
  });
});

describe("access revoked mid-session", () => {
  it("a removed member stops receiving events immediately", async () => {
    // A socket authorised at subscribe time stays open for hours. Without a re-check, a removed
    // member keeps receiving the workspace's events until they reconnect.
    const [owner, member] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: member, role: "member" }]);
    const socket = await connect(member);
    await subscribe(socket, workspace.id);

    const removal = new EventBuffer();
    await harness.container.workspaces.removeMember(workspace.id, owner.id, member.id, removal);
    await harness.container.hub.publish(removal.drain());
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Told why, then cut off -- and the event that removed them is not delivered, since it
    // describes a workspace they can no longer see.
    expect(socket.sent).toContainEqual({
      type: "unsubscribed",
      workspaceId: workspace.id,
      reason: "access revoked",
    });
    expect(socket.sent.filter((message) => message.type === "event")).toHaveLength(0);
    expect(harness.container.hub.subscriberCount(workspace.id)).toBe(0);

    // And nothing published afterwards reaches them.
    const later = new EventBuffer();
    await harness.container.work.createBoard(workspace.id, owner.id, "After", later);
    await harness.container.hub.publish(later.drain());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.sent.filter((message) => message.type === "event")).toHaveLength(0);
  });

  it("a demoted member keeps receiving events, because they are still a member", async () => {
    // The re-check asks whether they are still a member, not whether their role changed. A
    // demotion narrows what they may do, not what they may see.
    const [owner, member] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: member, role: "member" }]);
    const socket = await connect(member);
    await subscribe(socket, workspace.id);

    const events = new EventBuffer();
    await harness.container.workspaces.changeRole(workspace.id, owner.id, member.id, "viewer", events);
    await harness.container.hub.publish(events.drain());
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(socket.sent.filter((message) => message.type === "event")).toHaveLength(1);
    expect(harness.container.hub.subscriberCount(workspace.id)).toBe(1);
  });

  it("removing one member leaves the others connected", async () => {
    const [owner, staying, leaving] = await Promise.all([
      createUser(harness),
      createUser(harness),
      createUser(harness),
    ]);
    const workspace = await createWorkspace(harness, owner, [
      { user: staying, role: "member" },
      { user: leaving, role: "member" },
    ]);
    const stayingSocket = await connect(staying);
    const leavingSocket = await connect(leaving);
    await subscribe(stayingSocket, workspace.id);
    await subscribe(leavingSocket, workspace.id);

    const events = new EventBuffer();
    await harness.container.workspaces.removeMember(workspace.id, owner.id, leaving.id, events);
    await harness.container.hub.publish(events.drain());
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.container.hub.subscriberCount(workspace.id)).toBe(1);
    expect(stayingSocket.sent.filter((message) => message.type === "event")).toHaveLength(1);
  });

  it("only membership events trigger the re-check", async () => {
    // Re-checking on every event would mean a database query per event per socket, which turns
    // one busy board into a query storm. Membership events are the only ones that can revoke
    // access, and they are rare.
    const user = await createUser(harness);
    const workspace = await createWorkspace(harness, user);
    const socket = await connect(user);
    await subscribe(socket, workspace.id);

    // A board event for a workspace the socket is subscribed to, with the membership row deleted
    // behind the hub's back. It is still delivered, because a board event triggers no re-check.
    await harness.container.database.query(`delete from memberships where workspace_id = $1`, [
      workspace.id,
    ]);
    await harness.broker.publish(
      workspaceChannel(workspace.id),
      encodeEvent({
        type: "board.created",
        workspaceId: workspace.id,
        subjectId: "brd_X",
        actorId: user.id,
        at: harness.clock.now(),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.sent.filter((message) => message.type === "event")).toHaveLength(1);

    // A membership event does trigger it, and now the socket is cut off.
    await harness.broker.publish(
      workspaceChannel(workspace.id),
      encodeEvent({
        type: "member.removed",
        workspaceId: workspace.id,
        subjectId: user.id,
        actorId: user.id,
        at: harness.clock.now(),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.container.hub.subscriberCount(workspace.id)).toBe(0);
  });
});

describe("events are published only for committed, successful work", () => {
  it("a request that fails publishes nothing", async () => {
    // Publishing before the status is known would announce changes a later error means did not
    // happen, and subscribers have no way to take it back.
    const [owner, viewer] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: viewer, role: "viewer" }]);
    const board = await createBoard(harness, workspace.id, owner);
    const socket = await connect(owner);
    await subscribe(socket, workspace.id);

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/boards/${board.id}/items`,
      headers: viewer.auth,
      payload: { title: "Not allowed" },
    });
    expect(response.statusCode).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(socket.sent.filter((message) => message.type === "event")).toHaveLength(0);
  });

  it("a successful request publishes through the HTTP pipeline", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const socket = await connect(owner);
    await subscribe(socket, workspace.id);

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/boards/${board.id}/items`,
      headers: owner.auth,
      payload: { title: "Allowed" },
    });
    expect(response.statusCode).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const events = socket.sent.filter((message) => message.type === "event");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: { type: "item.created" } });
  });

  it("a GraphQL mutation publishes the same event", async () => {
    // Both surfaces feed the same buffer, so realtime is not a REST-only feature.
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const socket = await connect(owner);
    await subscribe(socket, workspace.id);

    await harness.app.inject({
      method: "POST",
      url: "/graphql",
      headers: owner.auth,
      payload: {
        query: "mutation ($b: String!) { createItem(boardId: $b, title: \"Via GraphQL\") { id } }",
        variables: { b: board.id },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(socket.sent.filter((message) => message.type === "event")).toHaveLength(1);
  });
});

describe("event encoding", () => {
  it("round-trips", () => {
    const event = {
      type: "item.updated" as const,
      workspaceId: "wsp_A",
      subjectId: "itm_B",
      actorId: "usr_C",
      at: 1700000000000,
      payload: { title: "T" },
    };
    expect(decodeEvent(encodeEvent(event))).toEqual(event);
  });

  it("returns null for anything unrecognised", () => {
    for (const message of [
      "",
      "not json",
      "null",
      "[]",
      '"a string"',
      "{}",
      '{"type":"x"}',
      '{"type":"x","workspaceId":"w","subjectId":"s","actorId":"a"}', // no `at`
      '{"type":"x","workspaceId":"w","subjectId":"s","actorId":"a","at":"now"}', // `at` not a number
    ]) {
      expect(decodeEvent(message), message).toBeNull();
    }
  });

  it("scopes the channel to the workspace", () => {
    expect(workspaceChannel("wsp_A")).toBe("ws:events:wsp_A");
    expect(workspaceChannel("wsp_A")).not.toBe(workspaceChannel("wsp_B"));
  });
});

describe("EventBuffer", () => {
  it("accumulates and drains once", () => {
    const buffer = new EventBuffer();
    buffer.add({ type: "item.created", workspaceId: "w", subjectId: "i", actorId: "u", at: 1 });
    expect(buffer.pending).toHaveLength(1);
    expect(buffer.drain()).toHaveLength(1);
    // Drained, so a second flush cannot double-publish.
    expect(buffer.drain()).toHaveLength(0);
    expect(buffer.pending).toHaveLength(0);
  });
});
