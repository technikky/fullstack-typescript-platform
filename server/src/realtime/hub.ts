/**
 * The realtime hub: WebSocket connections, authorised subscriptions, broker fan-out.
 *
 * Three decisions, each of which is a bug in most implementations of this:
 *
 * **1. Fan-out goes through the broker, not through a local socket list.** Iterating this
 * process's own connections works perfectly on one replica and silently breaks on two: a client
 * connected to pod A never sees a change made on pod B. Publishing to Redis and subscribing per
 * workspace is the only version that survives a scale-up. The in-memory broker makes the
 * property testable -- two hubs sharing one broker is the same topology as two pods sharing one
 * Redis.
 *
 * **2. Authorization is re-checked on delivery, not only on subscribe.** A socket authorised at
 * subscribe time stays open for hours. A member removed from a workspace in minute two must stop
 * receiving its events in minute two, not at their next reconnect. So membership-changing events
 * trigger a re-check, and a connection that has lost access is unsubscribed immediately.
 *
 * **3. The token is read from the first message, not the query string.** A URL with
 * `?token=...` ends up in access logs, proxy logs and browser history. The browser WebSocket API
 * cannot set headers, so the standard alternatives are the subprotocol field or a first message;
 * a first message is the one that keeps the credential out of the handshake URL entirely. The
 * connection is closed if it does not authenticate within a short window, so an unauthenticated
 * socket cannot sit there consuming a slot.
 */

import type { WebSocket } from "ws";

import type { Clock } from "../clock.js";
import { decodeEvent, encodeEvent, workspaceChannel, MEMBERSHIP_EVENTS } from "../domain/events.js";
import type { DomainEvent } from "../domain/events.js";
import type { Broker } from "../ports/keyvalue.js";
import type { TokenService } from "../auth/tokens.js";
import type { WorkspaceService } from "../domain/workspaces.js";

export const AUTH_TIMEOUT_MILLIS = 10_000;

/** Close codes. 4000-4999 is the range reserved for application use. */
export const CLOSE_UNAUTHENTICATED = 4001;
export const CLOSE_AUTH_TIMEOUT = 4002;
export const CLOSE_PROTOCOL = 4003;

export type ClientMessage =
  | { readonly type: "authenticate"; readonly token: string }
  | { readonly type: "subscribe"; readonly workspaceId: string }
  | { readonly type: "unsubscribe"; readonly workspaceId: string }
  | { readonly type: "ping" };

export type ServerMessage =
  | { readonly type: "ready"; readonly userId: string }
  | { readonly type: "subscribed"; readonly workspaceId: string }
  | { readonly type: "unsubscribed"; readonly workspaceId: string; readonly reason?: string }
  | { readonly type: "event"; readonly event: DomainEvent }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | { readonly type: "pong" };

/** The subset of `ws` this hub uses, so tests need no real socket. */
export interface Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", handler: (data: unknown) => void): void;
  on(event: "close", handler: () => void): void;
}

interface Connection {
  readonly socket: Socket;
  userId: string | null;
  /** workspaceId -> unsubscribe function returned by the broker. */
  readonly subscriptions: Map<string, () => Promise<void>>;
  authTimer: NodeJS.Timeout | null;
  closed: boolean;
}

const parseClientMessage = (raw: unknown): ClientMessage | null => {
  const text =
    typeof raw === "string"
      ? raw
      : raw instanceof Buffer
        ? raw.toString("utf8")
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString("utf8")
          : null;
  if (text === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as { type?: unknown; token?: unknown; workspaceId?: unknown };

  switch (candidate.type) {
    case "authenticate":
      return typeof candidate.token === "string" ? { type: "authenticate", token: candidate.token } : null;
    case "subscribe":
      return typeof candidate.workspaceId === "string"
        ? { type: "subscribe", workspaceId: candidate.workspaceId }
        : null;
    case "unsubscribe":
      return typeof candidate.workspaceId === "string"
        ? { type: "unsubscribe", workspaceId: candidate.workspaceId }
        : null;
    case "ping":
      return { type: "ping" };
    default:
      return null;
  }
};

export class RealtimeHub {
  readonly #broker: Broker;
  readonly #tokens: TokenService;
  readonly #workspaces: WorkspaceService;
  readonly #clock: Clock;
  readonly #connections = new Set<Connection>();
  readonly #authTimeoutMillis: number;

  constructor(options: {
    broker: Broker;
    tokens: TokenService;
    workspaces: WorkspaceService;
    clock: Clock;
    authTimeoutMillis?: number;
  }) {
    this.#broker = options.broker;
    this.#tokens = options.tokens;
    this.#workspaces = options.workspaces;
    this.#clock = options.clock;
    this.#authTimeoutMillis = options.authTimeoutMillis ?? AUTH_TIMEOUT_MILLIS;
  }

  /** Publish events after their transaction committed. */
  async publish(events: readonly DomainEvent[]): Promise<void> {
    await Promise.all(
      events.map((event) =>
        this.#broker.publish(workspaceChannel(event.workspaceId), encodeEvent(event)),
      ),
    );
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  /** Test-only: how many sockets are subscribed to a workspace on this hub. */
  subscriberCount(workspaceId: string): number {
    let count = 0;
    for (const connection of this.#connections) {
      if (connection.subscriptions.has(workspaceId)) count += 1;
    }
    return count;
  }

  accept(socket: Socket): void {
    const connection: Connection = {
      socket,
      userId: null,
      subscriptions: new Map(),
      authTimer: null,
      closed: false,
    };
    this.#connections.add(connection);

    connection.authTimer = setTimeout(() => {
      if (connection.userId === null) {
        this.#send(connection, {
          type: "error",
          code: "unauthenticated",
          message: "no authenticate message received",
        });
        socket.close(CLOSE_AUTH_TIMEOUT, "authentication timeout");
      }
    }, this.#authTimeoutMillis);
    // Do not hold the process open for an unauthenticated socket's timer.
    connection.authTimer.unref?.();

    socket.on("message", (data: unknown) => {
      void this.#onMessage(connection, data);
    });
    socket.on("close", () => {
      void this.#teardown(connection);
    });
  }

  async #onMessage(connection: Connection, data: unknown): Promise<void> {
    const message = parseClientMessage(data);
    if (message === null) {
      this.#send(connection, {
        type: "error",
        code: "bad_message",
        message: "expected a JSON object with a known type",
      });
      return;
    }

    if (message.type === "ping") {
      this.#send(connection, { type: "pong" });
      return;
    }

    if (message.type === "authenticate") {
      try {
        const claims = await this.#tokens.verifyAccess(message.token);
        connection.userId = claims.userId;
        if (connection.authTimer !== null) {
          clearTimeout(connection.authTimer);
          connection.authTimer = null;
        }
        this.#send(connection, { type: "ready", userId: claims.userId });
      } catch {
        this.#send(connection, {
          type: "error",
          code: "unauthenticated",
          message: "invalid or expired access token",
        });
        connection.socket.close(CLOSE_UNAUTHENTICATED, "invalid token");
      }
      return;
    }

    if (connection.userId === null) {
      this.#send(connection, {
        type: "error",
        code: "unauthenticated",
        message: "authenticate before subscribing",
      });
      connection.socket.close(CLOSE_PROTOCOL, "not authenticated");
      return;
    }

    if (message.type === "subscribe") {
      await this.#subscribe(connection, message.workspaceId);
      return;
    }
    await this.#unsubscribe(connection, message.workspaceId);
  }

  async #subscribe(connection: Connection, workspaceId: string): Promise<void> {
    const userId = connection.userId;
    if (userId === null) return;
    if (connection.subscriptions.has(workspaceId)) {
      this.#send(connection, { type: "subscribed", workspaceId });
      return;
    }

    const role = await this.#workspaces.roleIn(workspaceId, userId);
    if (role === null) {
      // Same wording whether the workspace is missing or the caller is not a member: a socket
      // must not be a cheaper membership oracle than the HTTP API.
      this.#send(connection, {
        type: "error",
        code: "not_found",
        message: "workspace not found",
      });
      return;
    }

    const unsubscribe = await this.#broker.subscribe(workspaceChannel(workspaceId), (raw) => {
      void this.#deliver(connection, workspaceId, raw);
    });

    // The socket may have closed while `subscribe` was in flight; without this the subscription
    // leaks and the broker keeps a handler for a dead connection.
    if (connection.closed) {
      await unsubscribe();
      return;
    }

    connection.subscriptions.set(workspaceId, unsubscribe);
    this.#send(connection, { type: "subscribed", workspaceId });
  }

  async #unsubscribe(connection: Connection, workspaceId: string, reason?: string): Promise<void> {
    const unsubscribe = connection.subscriptions.get(workspaceId);
    if (unsubscribe === undefined) return;
    connection.subscriptions.delete(workspaceId);
    await unsubscribe();
    this.#send(
      connection,
      reason === undefined
        ? { type: "unsubscribed", workspaceId }
        : { type: "unsubscribed", workspaceId, reason },
    );
  }

  /**
   * Deliver one event to one connection, re-checking access when the event could have changed
   * it.
   *
   * Re-checking on *every* event would mean a database query per event per socket, which turns
   * one busy board into a query storm. Re-checking on membership changes only is the same
   * guarantee at a fraction of the cost: those are the only events that can revoke access, and
   * they are rare.
   */
  async #deliver(connection: Connection, workspaceId: string, raw: string): Promise<void> {
    if (connection.closed) return;
    const event = decodeEvent(raw);
    if (event === null) return;
    const userId = connection.userId;
    if (userId === null) return;

    if (MEMBERSHIP_EVENTS.has(event.type)) {
      const role = await this.#workspaces.roleIn(workspaceId, userId);
      if (role === null) {
        // Removed. Tell them why, then stop the feed -- and do not deliver the event that
        // removed them, which describes a workspace they can no longer see.
        await this.#unsubscribe(connection, workspaceId, "access revoked");
        return;
      }
    }

    this.#send(connection, { type: "event", event });
  }

  #send(connection: Connection, message: ServerMessage): void {
    if (connection.closed) return;
    try {
      connection.socket.send(JSON.stringify(message));
    } catch {
      // A socket that fails to accept a write is already gone; the close handler will clean up.
    }
  }

  async #teardown(connection: Connection): Promise<void> {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.authTimer !== null) {
      clearTimeout(connection.authTimer);
      connection.authTimer = null;
    }
    const unsubscribes = [...connection.subscriptions.values()];
    connection.subscriptions.clear();
    this.#connections.delete(connection);
    await Promise.all(unsubscribes.map((unsubscribe) => unsubscribe()));
  }

  /** Close every connection. Used on shutdown and between tests. */
  async closeAll(): Promise<void> {
    for (const connection of [...this.#connections]) {
      await this.#teardown(connection);
      connection.socket.close(1001, "server shutting down");
    }
  }

  /** The hub's notion of now, for events it originates itself. */
  get now(): number {
    return this.#clock.now();
  }
}

/** Adapt a real `ws` socket to the narrow interface above. */
export const asSocket = (socket: WebSocket): Socket => socket as unknown as Socket;
