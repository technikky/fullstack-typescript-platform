/**
 * A real WebSocket connection over a real HTTP upgrade.
 *
 * `tests/realtime.test.ts` covers the hub's logic through a fake socket, which is faster and
 * gives sharper failures. This file covers what a fake cannot: that the upgrade is actually
 * routed, that `ws` and the hub agree on framing, that an upgrade to the wrong path is refused
 * cleanly rather than leaving a dangling socket, and that one port serves both HTTP and
 * WebSocket.
 *
 * It is the only suite that binds a port. Port 0 lets the OS pick a free one, so parallel runs and
 * busy development machines cannot collide.
 */

import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asSocket, CLOSE_UNAUTHENTICATED } from "../src/realtime/hub.js";
import { EventBuffer } from "../src/domain/events.js";
import {
  createBoard,
  createHarness,
  createUser,
  createWorkspace,
  type Harness,
  type TestUser,
} from "./support/harness.js";

let harness: Harness;
let server: Server;
let wss: WebSocketServer;
let port: number;

beforeAll(async () => {
  harness = await createHarness();
  await harness.app.ready();

  // The same wiring `main.ts` uses: Fastify's own server, with `ws` in `noServer` mode routing
  // the upgrade. Building a second server here would test something the production path does not
  // do.
  server = harness.app.server;
  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (connected) => {
      harness.container.hub.accept(asSocket(connected));
    });
  });

  await harness.app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port bound");
  port = address.port;
});

afterAll(async () => {
  wss.close();
  await harness.close();
});

interface Client {
  readonly socket: WebSocket;
  /** Wait for the next message, or reject after `timeoutMillis`. */
  next(timeoutMillis?: number): Promise<Record<string, unknown>>;
  send(message: Record<string, unknown>): void;
  close(): void;
  /** Resolves with the close code. */
  closed(): Promise<number>;
}

const open = async (path = "/ws"): Promise<Client> => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const queue: Record<string, unknown>[] = [];
  const waiting: Array<(message: Record<string, unknown>) => void> = [];
  let closeCode: number | null = null;
  const closeWaiters: Array<(code: number) => void> = [];

  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    const resolve = waiting.shift();
    if (resolve === undefined) queue.push(message);
    else resolve(message);
  });
  socket.on("close", (code) => {
    closeCode = code;
    for (const resolve of closeWaiters.splice(0)) resolve(code);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  return {
    socket,
    next: (timeoutMillis = 2000) =>
      new Promise((resolve, reject) => {
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), timeoutMillis);
        waiting.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      }),
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
    closed: () =>
      closeCode !== null
        ? Promise.resolve(closeCode)
        : new Promise((resolve) => closeWaiters.push(resolve)),
  };
};

const authenticate = async (user: TestUser): Promise<Client> => {
  const client = await open();
  client.send({ type: "authenticate", token: user.accessToken });
  const ready = await client.next();
  expect(ready).toEqual({ type: "ready", userId: user.id });
  return client;
};

describe("HTTP and WebSocket share one port", () => {
  it("serves HTTP on the same port the socket upgrades on", async () => {
    // One port, one certificate, one ingress rule.
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string }).toMatchObject({ status: "ok" });
  });

  it("refuses an upgrade on an unknown path with a clean HTTP response", async () => {
    // Not a dangling socket: an unrouted upgrade that is merely ignored leaves the client waiting
    // until its own timeout.
    await expect(open("/not-the-socket-path")).rejects.toThrow();
  });
});

describe("the real socket protocol", () => {
  it("authenticates from the first message, not the query string", async () => {
    // A URL carrying a credential ends up in access logs, proxy logs and browser history. The
    // handshake URL here has no token in it at all.
    const user = await createUser(harness);
    const client = await authenticate(user);
    client.close();
    await client.closed();
  });

  it("closes on a bad token with the documented code", async () => {
    const client = await open();
    client.send({ type: "authenticate", token: "not-a-real-token" });
    expect(await client.next()).toMatchObject({ type: "error", code: "unauthenticated" });
    expect(await client.closed()).toBe(CLOSE_UNAUTHENTICATED);
  });

  it("answers a ping, so a client can keep an idle connection alive", async () => {
    const user = await createUser(harness);
    const client = await authenticate(user);
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    client.close();
  });

  it("delivers a live event end to end", async () => {
    const user = await createUser(harness);
    const workspace = await createWorkspace(harness, user);
    const board = await createBoard(harness, workspace.id, user);

    const client = await authenticate(user);
    client.send({ type: "subscribe", workspaceId: workspace.id });
    expect(await client.next()).toEqual({ type: "subscribed", workspaceId: workspace.id });

    // Through the HTTP API, over the wire, as a client would.
    const created = await fetch(`http://127.0.0.1:${port}/api/boards/${board.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json", ...user.auth },
      body: JSON.stringify({ title: "Live update" }),
    });
    expect(created.status).toBe(201);

    const message = await client.next();
    expect(message).toMatchObject({
      type: "event",
      event: { type: "item.created", workspaceId: workspace.id, actorId: user.id },
    });
    client.close();
  });

  it("refuses to subscribe to a workspace the caller is not in", async () => {
    const [owner, stranger] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner);

    const client = await authenticate(stranger);
    client.send({ type: "subscribe", workspaceId: workspace.id });
    expect(await client.next()).toMatchObject({ type: "error", code: "not_found" });
    client.close();
  });

  it("two clients on the same workspace both receive an event", async () => {
    const [owner, member] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: member, role: "member" }]);

    const ownerClient = await authenticate(owner);
    const memberClient = await authenticate(member);
    for (const client of [ownerClient, memberClient]) {
      client.send({ type: "subscribe", workspaceId: workspace.id });
      expect(await client.next()).toMatchObject({ type: "subscribed" });
    }

    const events = new EventBuffer();
    await harness.container.work.createBoard(workspace.id, owner.id, "Shared", events);
    await harness.container.hub.publish(events.drain());

    for (const client of [ownerClient, memberClient]) {
      expect(await client.next()).toMatchObject({ type: "event", event: { type: "board.created" } });
      client.close();
    }
  });

  it("cuts a removed member off mid-connection", async () => {
    const [owner, member] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: member, role: "member" }]);

    const client = await authenticate(member);
    client.send({ type: "subscribe", workspaceId: workspace.id });
    expect(await client.next()).toMatchObject({ type: "subscribed" });

    const removal = await fetch(
      `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/members/${member.id}`,
      { method: "DELETE", headers: owner.auth },
    );
    expect(removal.status).toBe(204);

    expect(await client.next()).toEqual({
      type: "unsubscribed",
      workspaceId: workspace.id,
      reason: "access revoked",
    });
    client.close();
  });

  it("reports a malformed frame without dropping the connection", async () => {
    const user = await createUser(harness);
    const client = await authenticate(user);
    client.socket.send("this is not json");
    expect(await client.next()).toMatchObject({ type: "error", code: "bad_message" });

    // Still usable.
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    client.close();
  });
});
