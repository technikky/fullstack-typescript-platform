/**
 * The WebSocket client: connect, authenticate, subscribe, reconnect.
 *
 * Reconnection is the part worth reading. A socket that reconnects immediately on every close turns
 * a server restart into a connection storm: every client in the fleet retries at the same instant,
 * the server comes up, and is knocked over again. So:
 *
 * - **Exponential backoff** from 500 ms to 30 s, so the load a restarting server sees decays.
 * - **Jitter** on every delay. Without it, clients that disconnected together stay in lockstep and
 *   retry together forever; the backoff curve changes but the thundering herd does not.
 * - **Subscriptions are replayed** after reconnecting. A client that silently stops receiving
 *   updates is worse than one that visibly disconnects, because nothing on screen says the data is
 *   stale.
 * - **A deliberate close does not reconnect.** Signing out or unmounting must actually stop.
 * - **Authentication failure does not retry.** A bad token will still be bad in 500 ms; retrying
 *   burns the rate limit and delays the sign-in prompt the user needs.
 */

export type ConnectionState = "idle" | "connecting" | "authenticating" | "ready" | "reconnecting" | "closed";

export interface DomainEvent {
  readonly type: string;
  readonly workspaceId: string;
  readonly subjectId: string;
  readonly actorId: string;
  readonly at: number;
  readonly payload?: Record<string, unknown>;
}

export interface RealtimeHandlers {
  onEvent?(event: DomainEvent): void;
  onState?(state: ConnectionState): void;
  /** The server dropped a subscription -- access revoked, most likely. */
  onUnsubscribed?(workspaceId: string, reason: string | null): void;
  onError?(code: string, message: string): void;
}

export interface RealtimeOptions extends RealtimeHandlers {
  readonly url: string;
  /** Called on every connect, so a refreshed token is used rather than a stale one. */
  readonly token: () => string | null;
  /** Injected in tests. */
  readonly socketFactory?: (url: string) => WebSocketLike;
  readonly now?: () => number;
  readonly setTimeoutFn?: (handler: () => void, millis: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  /** Deterministic in tests; `Math.random` in a browser. */
  readonly random?: () => number;
}

/** The part of `WebSocket` this client uses. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

const BASE_DELAY_MILLIS = 500;
const MAX_DELAY_MILLIS = 30_000;
/** Application close codes the server uses for an authentication failure. */
const AUTH_CLOSE_CODES = new Set([4001, 4002, 4003]);

export class RealtimeClient {
  readonly #options: RealtimeOptions;
  readonly #wanted = new Set<string>();
  #socket: WebSocketLike | null = null;
  #state: ConnectionState = "idle";
  #attempt = 0;
  #retryHandle: unknown = null;
  #deliberatelyClosed = false;

  constructor(options: RealtimeOptions) {
    this.#options = options;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** Workspaces this client wants to be subscribed to, replayed after a reconnect. */
  get subscriptions(): readonly string[] {
    return [...this.#wanted];
  }

  get attempts(): number {
    return this.#attempt;
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onState?.(state);
  }

  #setTimeout(handler: () => void, millis: number): unknown {
    return (this.#options.setTimeoutFn ?? setTimeout)(handler, millis);
  }

  #clearTimeout(handle: unknown): void {
    (this.#options.clearTimeoutFn ?? clearTimeout)(handle as never);
  }

  /**
   * Backoff with jitter.
   *
   * Full jitter (a uniform draw from `[0, delay]`) rather than a fixed fraction: clients that
   * disconnected together must not come back together, and a deterministic multiplier keeps them
   * in lockstep.
   */
  backoffMillis(attempt: number): number {
    const ceiling = Math.min(MAX_DELAY_MILLIS, BASE_DELAY_MILLIS * 2 ** Math.max(0, attempt - 1));
    const random = this.#options.random ?? Math.random;
    return Math.round(ceiling * (0.5 + 0.5 * random()));
  }

  connect(): void {
    if (this.#socket !== null) return;
    this.#deliberatelyClosed = false;

    const token = this.#options.token();
    if (token === null || token.length === 0) {
      // Nothing to authenticate with. Not an error, and not something to retry: the caller
      // reconnects once it has a token.
      this.#setState("idle");
      return;
    }

    this.#setState(this.#attempt === 0 ? "connecting" : "reconnecting");
    const socket = (this.#options.socketFactory ?? defaultSocketFactory)(this.#options.url);
    this.#socket = socket;

    socket.onopen = () => {
      this.#setState("authenticating");
      // The token goes in the first message, not the URL: a handshake URL carrying a credential
      // ends up in access logs, proxy logs and browser history.
      socket.send(JSON.stringify({ type: "authenticate", token }));
    };

    socket.onmessage = (event) => {
      this.#handle(event.data);
    };

    socket.onerror = () => {
      // `onclose` always follows, and it is where retry is decided. Handling both would schedule
      // two reconnects for one failure.
    };

    socket.onclose = (event) => {
      this.#socket = null;
      if (this.#deliberatelyClosed) {
        this.#setState("closed");
        return;
      }
      if (AUTH_CLOSE_CODES.has(event.code)) {
        // A bad token will still be bad in 500 ms. Retrying burns the rate limit and delays the
        // sign-in prompt the user actually needs.
        this.#setState("closed");
        this.#options.onError?.("unauthenticated", "the session was rejected by the server");
        return;
      }
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect(): void {
    this.#attempt += 1;
    this.#setState("reconnecting");
    const delay = this.backoffMillis(this.#attempt);
    this.#retryHandle = this.#setTimeout(() => {
      this.#retryHandle = null;
      this.connect();
    }, delay);
  }

  #handle(raw: unknown): void {
    if (typeof raw !== "string") return;
    let message: { type?: unknown; userId?: unknown; workspaceId?: unknown; reason?: unknown; event?: unknown; code?: unknown; message?: unknown };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }

    switch (message.type) {
      case "ready": {
        // The connection is only usable now, so the attempt counter resets here rather than on
        // `open`: a socket that opens and is then rejected has not succeeded.
        this.#attempt = 0;
        this.#setState("ready");
        // Replay, so a reconnect does not silently stop delivering updates.
        for (const workspaceId of this.#wanted) this.#send({ type: "subscribe", workspaceId });
        return;
      }
      case "event": {
        const event = message.event as DomainEvent | undefined;
        if (event !== undefined) this.#options.onEvent?.(event);
        return;
      }
      case "unsubscribed": {
        const workspaceId = typeof message.workspaceId === "string" ? message.workspaceId : null;
        if (workspaceId === null) return;
        // Dropped by the server, so stop wanting it -- otherwise the next reconnect would try
        // again and be refused again, forever.
        this.#wanted.delete(workspaceId);
        this.#options.onUnsubscribed?.(
          workspaceId,
          typeof message.reason === "string" ? message.reason : null,
        );
        return;
      }
      case "error": {
        this.#options.onError?.(
          typeof message.code === "string" ? message.code : "error",
          typeof message.message === "string" ? message.message : "unknown error",
        );
        return;
      }
      default:
        return;
    }
  }

  #send(message: Record<string, unknown>): void {
    this.#socket?.send(JSON.stringify(message));
  }

  subscribe(workspaceId: string): void {
    this.#wanted.add(workspaceId);
    if (this.#state === "ready") this.#send({ type: "subscribe", workspaceId });
  }

  unsubscribe(workspaceId: string): void {
    this.#wanted.delete(workspaceId);
    if (this.#state === "ready") this.#send({ type: "unsubscribe", workspaceId });
  }

  ping(): void {
    this.#send({ type: "ping" });
  }

  /** Close for good. Does not reconnect. */
  close(): void {
    this.#deliberatelyClosed = true;
    if (this.#retryHandle !== null) {
      this.#clearTimeout(this.#retryHandle);
      this.#retryHandle = null;
    }
    this.#socket?.close(1000, "client closed");
    this.#socket = null;
    this.#setState("closed");
  }
}

const defaultSocketFactory = (url: string): WebSocketLike =>
  new WebSocket(url) as unknown as WebSocketLike;
