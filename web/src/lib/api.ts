/**
 * The API client.
 *
 * Three behaviours here are the reason this is a module rather than scattered `fetch` calls:
 *
 * **Refresh happens once, not once per request.** When several requests race and all get a 401, a
 * naive client refreshes once per request -- and because refresh tokens rotate, the second refresh
 * presents a token the first already consumed, which trips reuse detection and logs the user out.
 * A single in-flight refresh promise is shared by every waiting caller.
 *
 * **Retry is attempted exactly once.** If the retried request also returns 401, the session is
 * genuinely gone and the client stops. Retrying in a loop turns an expired session into a request
 * storm against the auth endpoint, which is rate-limited, which makes recovery slower still.
 *
 * **Errors keep their code.** The server sends `{ error: { code, message } }`; this preserves both,
 * so a caller can branch on `version_conflict` without matching on message text.
 */

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.details = body.details ?? {};
    this.requestId = body.requestId ?? null;
  }

  /** True when the resource changed underneath us and the client should rebase. */
  get isVersionConflict(): boolean {
    return this.code === "version_conflict";
  }

  /** The version the server holds, when it told us. */
  get currentVersion(): number | null {
    const value = this.details["currentVersion"];
    return typeof value === "number" ? value : null;
  }
}

export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: number;
}

export interface TokenStore {
  read(): Tokens | null;
  write(tokens: Tokens | null): void;
}

/**
 * Tokens in memory, with the refresh token in `localStorage`.
 *
 * The access token is deliberately **not** persisted: it lives for ten minutes, and keeping it in
 * storage widens the XSS window for no benefit -- a page reload can obtain a fresh one from the
 * refresh token in a single request.
 *
 * The refresh token is in `localStorage`, which is honestly a compromise: it is readable by any
 * script on the origin. The better answer is an httpOnly, Secure, SameSite cookie, which script
 * cannot read at all. That needs the API and the client on the same site (or a cookie-issuing
 * proxy), so it is a deployment decision rather than a client one. `docs/auth.md` records the
 * trade-off rather than leaving `localStorage` looking like an oversight.
 */
export const browserTokenStore = (storageKey = "platform.refresh"): TokenStore => {
  let cached: Tokens | null = null;

  return {
    read: () => {
      if (cached !== null) return cached;
      try {
        const stored = globalThis.localStorage?.getItem(storageKey);
        if (stored === null || stored === undefined) return null;
        // Only the refresh token survives a reload; the access token is re-obtained.
        cached = { accessToken: "", refreshToken: stored, accessExpiresAt: 0 };
        return cached;
      } catch {
        // Private browsing, blocked site data, or a sandboxed iframe. Not being able to persist is
        // not a reason to fail: the session simply does not survive a reload.
        return null;
      }
    },
    write: (tokens) => {
      cached = tokens;
      try {
        if (tokens === null) globalThis.localStorage?.removeItem(storageKey);
        else globalThis.localStorage?.setItem(storageKey, tokens.refreshToken);
      } catch {
        // Same as above: keep working in memory.
      }
    },
  };
};

/** Tokens held only in memory. Used by tests and by server-side rendering. */
export const memoryTokenStore = (initial: Tokens | null = null): TokenStore => {
  let tokens = initial;
  return { read: () => tokens, write: (next) => void (tokens = next) };
};

export interface ClientOptions {
  readonly baseUrl: string;
  readonly store: TokenStore;
  /** Injected so tests need no network. */
  readonly fetch?: typeof globalThis.fetch;
  /** Called when the session is gone for good, so the UI can send the user to sign in. */
  readonly onUnauthenticated?: () => void;
}

export class ApiClient {
  readonly #baseUrl: string;
  readonly #store: TokenStore;
  readonly #fetch: typeof globalThis.fetch;
  readonly #onUnauthenticated: (() => void) | null;
  /** The single in-flight refresh, shared by every caller that needs one. */
  #refreshing: Promise<Tokens | null> | null = null;

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#store = options.store;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#onUnauthenticated = options.onUnauthenticated ?? null;
  }

  get tokens(): Tokens | null {
    return this.#store.read();
  }

  get isAuthenticated(): boolean {
    return this.#store.read() !== null;
  }

  async #parse(response: Response): Promise<unknown> {
    if (response.status === 204) return null;
    const text = await response.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      // A proxy error page or a gateway timeout: not JSON, and the raw HTML must not be surfaced
      // as a message.
      throw new ApiError(response.status, {
        code: response.ok ? "internal" : "internal",
        message: `unexpected response from the server (${response.status})`,
      });
    }
  }

  async #send(
    path: string,
    init: RequestInit,
    accessToken: string | null,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (accessToken !== null && accessToken.length > 0) {
      headers.set("authorization", `Bearer ${accessToken}`);
    }
    return this.#fetch(`${this.#baseUrl}${path}`, { ...init, headers });
  }

  /**
   * Refresh, at most once concurrently.
   *
   * Because refresh tokens rotate, two simultaneous refreshes would mean the second presents a
   * token the first already consumed -- which the server correctly reads as reuse and answers by
   * revoking the whole family. Sharing one promise is what stops a burst of 401s from logging the
   * user out.
   */
  async #refresh(): Promise<Tokens | null> {
    this.#refreshing ??= (async () => {
      try {
        const current = this.#store.read();
        if (current === null) return null;

        const response = await this.#send(
          "/api/auth/refresh",
          { method: "POST", body: JSON.stringify({ refreshToken: current.refreshToken }) },
          null,
        );
        if (!response.ok) {
          this.#store.write(null);
          this.#onUnauthenticated?.();
          return null;
        }
        const body = (await this.#parse(response)) as { tokens: Tokens };
        this.#store.write(body.tokens);
        return body.tokens;
      } finally {
        // Cleared in `finally` so a failed refresh does not permanently block later attempts.
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const tokens = this.#store.read();
    let response = await this.#send(path, init, tokens?.accessToken ?? null);

    if (response.status === 401 && this.#store.read() !== null) {
      const refreshed = await this.#refresh();
      if (refreshed !== null) {
        // Exactly one retry. A second 401 means the session is genuinely gone, and looping would
        // turn that into a request storm against a rate-limited endpoint.
        response = await this.#send(path, init, refreshed.accessToken);
      }
    }

    const body = await this.#parse(response);
    if (!response.ok) {
      if (response.status === 401) {
        this.#store.write(null);
        this.#onUnauthenticated?.();
      }
      const error = (body as { error?: ApiErrorBody } | null)?.error;
      throw new ApiError(
        response.status,
        error ?? { code: "internal", message: `request failed with ${response.status}` },
      );
    }
    return body as T;
  }

  // --- auth -------------------------------------------------------------------------

  async register(input: {
    email: string;
    name: string;
    password: string;
  }): Promise<{ user: User; tokens: Tokens }> {
    const result = await this.request<{ user: User; tokens: Tokens }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    });
    this.#store.write(result.tokens);
    return result;
  }

  async login(email: string, password: string): Promise<{ user: User; tokens: Tokens }> {
    const result = await this.request<{ user: User; tokens: Tokens }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    this.#store.write(result.tokens);
    return result;
  }

  async logout(): Promise<void> {
    try {
      await this.request("/api/auth/logout", { method: "POST" });
    } finally {
      // Cleared even if the call failed: the user asked to log out, and leaving the token behind
      // because the network blipped is the opposite of what they wanted.
      this.#store.write(null);
    }
  }

  async me(): Promise<User> {
    return (await this.request<{ user: User }>("/api/auth/me")).user;
  }

  // --- workspaces -------------------------------------------------------------------

  async workspaces(): Promise<WorkspaceView[]> {
    return (await this.request<{ workspaces: WorkspaceView[] }>("/api/workspaces")).workspaces;
  }

  async createWorkspace(name: string, idempotencyKey?: string): Promise<WorkspaceView> {
    return this.request<WorkspaceView>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
      ...(idempotencyKey === undefined ? {} : { headers: { "idempotency-key": idempotencyKey } }),
    });
  }

  async workspace(id: string): Promise<WorkspaceView> {
    return this.request<WorkspaceView>(`/api/workspaces/${encodeURIComponent(id)}`);
  }

  async members(workspaceId: string): Promise<Member[]> {
    return (
      await this.request<{ members: Member[] }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/members`,
      )
    ).members;
  }

  // --- boards and items -------------------------------------------------------------

  async boards(workspaceId: string): Promise<Board[]> {
    return (
      await this.request<{ boards: Board[] }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/boards`,
      )
    ).boards;
  }

  async createBoard(workspaceId: string, name: string): Promise<Board> {
    return (
      await this.request<{ board: Board }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/boards`,
        { method: "POST", body: JSON.stringify({ name }) },
      )
    ).board;
  }

  async items(boardId: string, options: { limit?: number; after?: string } = {}): Promise<ItemPage> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.after !== undefined) query.set("after", options.after);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request<ItemPage>(`/api/boards/${encodeURIComponent(boardId)}/items${suffix}`);
  }

  async createItem(
    boardId: string,
    input: { title: string; body?: string },
    idempotencyKey?: string,
  ): Promise<Item> {
    return (
      await this.request<{ item: Item }>(`/api/boards/${encodeURIComponent(boardId)}/items`, {
        method: "POST",
        body: JSON.stringify(input),
        ...(idempotencyKey === undefined ? {} : { headers: { "idempotency-key": idempotencyKey } }),
      })
    ).item;
  }

  /**
   * Update an item, carrying the version the caller last saw.
   *
   * `expectedVersion` is required by the API, and deliberately required here too: an update helper
   * that made it optional would make the blind write the easy path.
   */
  async updateItem(
    id: string,
    patch: { expectedVersion: number; title?: string; body?: string; status?: ItemStatus },
  ): Promise<Item> {
    return (
      await this.request<{ item: Item }>(`/api/items/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      })
    ).item;
  }

  async deleteItem(id: string): Promise<void> {
    await this.request(`/api/items/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}

// --- shared shapes ------------------------------------------------------------------

export type Role = "owner" | "admin" | "member" | "viewer";
export type ItemStatus = "open" | "in_progress" | "blocked" | "done";

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface WorkspaceView {
  readonly workspace: Workspace;
  readonly role: Role;
  /**
   * What this actor may do, as reported by the server.
   *
   * Used to render the UI truthfully. **Advisory only** -- the server checks every request
   * regardless, and the platform's tests call forbidden endpoints directly to prove that hiding a
   * button is not a permission.
   */
  readonly permissions: string[];
}

export interface Member {
  readonly id: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly email: string;
  readonly name: string;
  readonly role: Role;
  readonly createdAt: string;
}

export interface Board {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface Item {
  readonly id: string;
  readonly boardId: string;
  readonly title: string;
  readonly body: string;
  readonly status: ItemStatus;
  readonly assigneeId: string | null;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ItemPage {
  readonly items: Item[];
  readonly nextCursor: string | null;
}
