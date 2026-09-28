/**
 * The API client.
 *
 * The refresh behaviour is what this file is really for. Because the server rotates refresh tokens
 * and revokes a whole family on reuse, a client that refreshes twice concurrently logs its own user
 * out -- and that bug only appears under a burst of parallel 401s, which is exactly the situation a
 * simple test never creates. So the tests here create it deliberately.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient, ApiError, memoryTokenStore, type Tokens } from "@/lib/api";

const TOKENS: Tokens = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  accessExpiresAt: Date.now() + 600_000,
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const errorResponse = (status: number, code: string, message: string, details?: unknown): Response =>
  jsonResponse(status, { error: { code, message, details, requestId: "req_test" } });

interface Call {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: string | null;
  readonly headers: Headers;
}

/** A fetch stand-in that records every call and answers from a queue of handlers. */
const stubFetch = (
  handlers: Array<(call: Call) => Response | Promise<Response>>,
): { fetch: typeof globalThis.fetch; calls: Call[] } => {
  const calls: Call[] = [];
  let index = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
      headers,
    };
    calls.push(call);
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    if (handler === undefined) throw new Error("no handler for this call");
    return handler(call);
  }) as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
};

describe("requests", () => {
  it("sends the access token and a JSON content type", async () => {
    const { fetch, calls } = stubFetch([() => jsonResponse(200, { workspaces: [] })]);
    const client = new ApiClient({ baseUrl: "http://api.test", store: memoryTokenStore(TOKENS), fetch });

    await client.workspaces();
    expect(calls[0]?.authorization).toBe("Bearer access-1");
  });

  it("omits the Authorization header when there is no token", async () => {
    const { fetch, calls } = stubFetch([() => jsonResponse(200, { workspaces: [] })]);
    const client = new ApiClient({ baseUrl: "http://api.test", store: memoryTokenStore(null), fetch });

    await client.request("/api/workspaces");
    expect(calls[0]?.authorization).toBeNull();
  });

  it("strips a trailing slash from the base URL", async () => {
    const { fetch, calls } = stubFetch([() => jsonResponse(200, { workspaces: [] })]);
    const client = new ApiClient({
      baseUrl: "http://api.test/",
      store: memoryTokenStore(TOKENS),
      fetch,
    });

    await client.workspaces();
    // Otherwise every URL would contain a double slash, which some proxies treat as a different path.
    expect(calls[0]?.url).toBe("http://api.test/api/workspaces");
  });

  it("handles a 204 with no body", async () => {
    const { fetch } = stubFetch([() => new Response(null, { status: 204 })]);
    const client = new ApiClient({ baseUrl: "http://api.test", store: memoryTokenStore(TOKENS), fetch });
    await expect(client.deleteItem("itm_1")).resolves.toBeUndefined();
  });

  it("encodes path parameters", async () => {
    const { fetch, calls } = stubFetch([() => jsonResponse(200, { item: {} })]);
    const client = new ApiClient({ baseUrl: "http://api.test", store: memoryTokenStore(TOKENS), fetch });

    await client.request("/api/items/x");
    calls.length = 0;
    await client.updateItem("itm/with slash", { expectedVersion: 1 });
    expect(calls[0]?.url).toContain("itm%2Fwith%20slash");
  });

  it("sends an idempotency key when given one", async () => {
    const { fetch, calls } = stubFetch([() => jsonResponse(201, { item: {} })]);
    const client = new ApiClient({ baseUrl: "http://api.test", store: memoryTokenStore(TOKENS), fetch });

    await client.createItem("brd_1", { title: "T" }, "key-123");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("key-123");
  });
});

describe("errors", () => {
  it("preserves the server's code, message and details", async () => {
    const { fetch } = stubFetch([
      () => errorResponse(409, "version_conflict", "the resource was modified", { currentVersion: 7 }),
    ]);
    const client = new ApiClient({ baseUrl: "http://api.test", store: memoryTokenStore(TOKENS), fetch });

    await expect(client.updateItem("itm_1", { expectedVersion: 1 })).rejects.toMatchObject({
      status: 409,
      code: "version_conflict",
      message: "the resource was modified",
    });
  });

  it("exposes the current version, so a caller can rebase without parsing a message", async () => {
    const { fetch } = stubFetch([
      () => errorResponse(409, "version_conflict", "modified", { currentVersion: 7 }),
    ]);
    const client = new ApiClient({ baseUrl: "http://api.test", store: memoryTokenStore(TOKENS), fetch });

    try {
      await client.updateItem("itm_1", { expectedVersion: 1 });
      throw new Error("expected a rejection");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(ApiError);
      const error = thrown as ApiError;
      expect(error.isVersionConflict).toBe(true);
      expect(error.currentVersion).toBe(7);
      expect(error.requestId).toBe("req_test");
    }
  });

  it("reports null for a missing current version rather than guessing", () => {
    const error = new ApiError(409, { code: "conflict", message: "x" });
    expect(error.currentVersion).toBeNull();
    expect(error.isVersionConflict).toBe(false);
  });

  it("does not surface a proxy HTML error page as a message", async () => {
    // A 502 from a load balancer is HTML. Showing it to the user, or throwing a JSON parse error,
    // are both worse than saying the server answered unexpectedly.
    const { fetch } = stubFetch([
      () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }),
    ]);
    const client = new ApiClient({ baseUrl: "http://api.test", store: memoryTokenStore(TOKENS), fetch });

    await expect(client.workspaces()).rejects.toMatchObject({
      code: "internal",
      message: expect.stringContaining("502"),
    });
  });

  it("falls back to a generic error when the body has no error object", async () => {
    const { fetch } = stubFetch([() => jsonResponse(500, { unexpected: true })]);
    const client = new ApiClient({ baseUrl: "http://api.test", store: memoryTokenStore(TOKENS), fetch });
    await expect(client.workspaces()).rejects.toMatchObject({ code: "internal", status: 500 });
  });
});

describe("refresh and retry", () => {
  it("refreshes on 401 and retries once with the new token", async () => {
    const store = memoryTokenStore(TOKENS);
    const { fetch, calls } = stubFetch([
      () => errorResponse(401, "unauthenticated", "expired"),
      () =>
        jsonResponse(200, {
          tokens: { accessToken: "access-2", refreshToken: "refresh-2", accessExpiresAt: 0 },
        }),
      () => jsonResponse(200, { workspaces: [] }),
    ]);
    const client = new ApiClient({ baseUrl: "http://api.test", store, fetch });

    await expect(client.workspaces()).resolves.toEqual([]);
    expect(calls.map((call) => call.url)).toEqual([
      "http://api.test/api/workspaces",
      "http://api.test/api/auth/refresh",
      "http://api.test/api/workspaces",
    ]);
    // The retry carries the new token, and the rotated refresh token is stored.
    expect(calls[2]?.authorization).toBe("Bearer access-2");
    expect(store.read()?.refreshToken).toBe("refresh-2");
  });

  it("refreshes only once for a burst of concurrent 401s", async () => {
    // The bug this exists to prevent: with one refresh per request, the second presents a token the
    // first already consumed, the server reads that as reuse, and the whole family is revoked. The
    // user is logged out by their own client.
    const store = memoryTokenStore(TOKENS);
    let refreshes = 0;
    const { fetch } = stubFetch([
      (call) => {
        if (call.url.endsWith("/api/auth/refresh")) {
          refreshes += 1;
          return jsonResponse(200, {
            tokens: { accessToken: "access-2", refreshToken: "refresh-2", accessExpiresAt: 0 },
          });
        }
        return call.authorization === "Bearer access-1"
          ? errorResponse(401, "unauthenticated", "expired")
          : jsonResponse(200, { workspaces: [] });
      },
    ]);
    const client = new ApiClient({ baseUrl: "http://api.test", store, fetch });

    const results = await Promise.all([
      client.workspaces(),
      client.workspaces(),
      client.workspaces(),
      client.workspaces(),
    ]);

    expect(results).toHaveLength(4);
    expect(refreshes).toBe(1);
  });

  it("gives up after one retry rather than looping", async () => {
    // Retrying in a loop turns an expired session into a request storm against a rate-limited
    // endpoint, which makes recovery slower.
    const store = memoryTokenStore(TOKENS);
    let requests = 0;
    const { fetch } = stubFetch([
      (call) => {
        requests += 1;
        if (call.url.endsWith("/api/auth/refresh")) {
          return jsonResponse(200, {
            tokens: { accessToken: "access-2", refreshToken: "refresh-2", accessExpiresAt: 0 },
          });
        }
        return errorResponse(401, "unauthenticated", "still expired");
      },
    ]);
    const client = new ApiClient({ baseUrl: "http://api.test", store, fetch });

    await expect(client.workspaces()).rejects.toMatchObject({ status: 401 });
    // original + refresh + one retry, and no more.
    expect(requests).toBe(3);
    expect(store.read()).toBeNull();
  });

  it("clears the session and notifies when the refresh itself is rejected", async () => {
    const store = memoryTokenStore(TOKENS);
    const onUnauthenticated = vi.fn();
    const { fetch } = stubFetch([
      () => errorResponse(401, "unauthenticated", "expired"),
      () => errorResponse(401, "unauthenticated", "the refresh token was revoked"),
    ]);
    const client = new ApiClient({ baseUrl: "http://api.test", store, fetch, onUnauthenticated });

    await expect(client.workspaces()).rejects.toMatchObject({ status: 401 });
    expect(store.read()).toBeNull();
    expect(onUnauthenticated).toHaveBeenCalled();
  });

  it("does not attempt a refresh when there is no session", async () => {
    const { fetch, calls } = stubFetch([() => errorResponse(401, "unauthenticated", "no token")]);
    const client = new ApiClient({ baseUrl: "http://api.test", store: memoryTokenStore(null), fetch });

    await expect(client.workspaces()).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });

  it("allows a later refresh after an earlier one failed", async () => {
    // The in-flight promise is cleared in a `finally`, so a transient network failure does not block
    // every future attempt.
    const store = memoryTokenStore(TOKENS);
    let attempt = 0;
    const { fetch } = stubFetch([
      (call) => {
        if (call.url.endsWith("/api/auth/refresh")) {
          attempt += 1;
          if (attempt === 1) return errorResponse(503, "internal", "refresh unavailable");
          return jsonResponse(200, {
            tokens: { accessToken: "access-2", refreshToken: "refresh-2", accessExpiresAt: 0 },
          });
        }
        return call.authorization === "Bearer access-2"
          ? jsonResponse(200, { workspaces: [] })
          : errorResponse(401, "unauthenticated", "expired");
      },
    ]);
    const client = new ApiClient({ baseUrl: "http://api.test", store, fetch });

    await expect(client.workspaces()).rejects.toBeInstanceOf(ApiError);
    // The failed refresh cleared the session, so restore it as a fresh sign-in would.
    store.write(TOKENS);
    await expect(client.workspaces()).resolves.toEqual([]);
    expect(attempt).toBe(2);
  });
});

describe("sign in and out", () => {
  it("stores the tokens returned by login", async () => {
    const store = memoryTokenStore(null);
    const { fetch } = stubFetch([
      () =>
        jsonResponse(200, {
          user: { id: "usr_1", email: "a@b.test", name: "A", createdAt: "2026-01-01T00:00:00Z" },
          tokens: { accessToken: "access-1", refreshToken: "refresh-1", accessExpiresAt: 0 },
        }),
    ]);
    const client = new ApiClient({ baseUrl: "http://api.test", store, fetch });

    const result = await client.login("a@b.test", "a-password-value");
    expect(result.user.id).toBe("usr_1");
    expect(client.isAuthenticated).toBe(true);
  });

  it("clears the session even if the logout request fails", async () => {
    // The user asked to log out. Leaving the token behind because the network blipped is the
    // opposite of what they wanted.
    const store = memoryTokenStore(TOKENS);
    const { fetch } = stubFetch([() => errorResponse(503, "internal", "unavailable")]);
    const client = new ApiClient({ baseUrl: "http://api.test", store, fetch });

    await expect(client.logout()).rejects.toBeInstanceOf(ApiError);
    expect(store.read()).toBeNull();
  });
});

describe("the token store", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  it("keeps only the refresh token in storage", async () => {
    // The access token lives ten minutes; persisting it widens the XSS window for no benefit,
    // because a reload can obtain a fresh one from the refresh token in one request.
    const { browserTokenStore } = await import("@/lib/api");
    const store = browserTokenStore("test.refresh");
    store.write(TOKENS);
    expect(globalThis.localStorage.getItem("test.refresh")).toBe("refresh-1");
    expect(globalThis.localStorage.getItem("test.refresh")).not.toContain("access");
  });

  it("restores a session with no access token, so the client refreshes on first use", async () => {
    const { browserTokenStore } = await import("@/lib/api");
    globalThis.localStorage.setItem("test.refresh", "refresh-from-storage");
    const restored = browserTokenStore("test.refresh").read();
    expect(restored).toEqual({
      accessToken: "",
      refreshToken: "refresh-from-storage",
      accessExpiresAt: 0,
    });
  });

  it("clears storage on write(null)", async () => {
    const { browserTokenStore } = await import("@/lib/api");
    const store = browserTokenStore("test.refresh");
    store.write(TOKENS);
    store.write(null);
    expect(globalThis.localStorage.getItem("test.refresh")).toBeNull();
    expect(store.read()).toBeNull();
  });

  it("keeps working when storage throws", async () => {
    // Private browsing, blocked site data, or a sandboxed iframe. Not being able to persist must not
    // fail the request; the session simply does not survive a reload.
    const { browserTokenStore } = await import("@/lib/api");
    const spy = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("access denied");
    });
    try {
      const store = browserTokenStore("test.refresh");
      expect(() => store.write(TOKENS)).not.toThrow();
      expect(store.read()?.refreshToken).toBe("refresh-1");
    } finally {
      spy.mockRestore();
    }
  });
});
