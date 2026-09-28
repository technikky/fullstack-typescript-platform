/**
 * The REST surface, through real routing.
 *
 * Every test goes through `app.inject()`, so routing, body parsing, validation, the auth hook,
 * the rate-limit hook, serialisation and error mapping all execute. A test that called a handler
 * function directly would prove nothing about the route it is mounted on -- and the hook order is
 * where several of these behaviours actually live.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { MINUTE } from "../src/clock.js";
import {
  createBoard,
  createHarness,
  createItem,
  createUser,
  createWorkspace,
  json,
  type Harness,
  type TestUser,
} from "./support/harness.js";

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});
afterEach(async () => {
  await harness.reset();
});
afterAll(async () => {
  await harness.close();
});

const get = (url: string, user?: TestUser) =>
  harness.app.inject({ method: "GET", url, ...(user === undefined ? {} : { headers: user.auth }) });

const post = (
  url: string,
  payload: Record<string, unknown>,
  user?: TestUser,
  headers: Record<string, string> = {},
) =>
  harness.app.inject({
    method: "POST",
    url,
    payload,
    headers: { ...(user === undefined ? {} : user.auth), ...headers },
  });

const patch = (url: string, payload: Record<string, unknown>, user?: TestUser) =>
  harness.app.inject({
    method: "PATCH",
    url,
    payload,
    ...(user === undefined ? {} : { headers: user.auth }),
  });

const remove = (url: string, user?: TestUser) =>
  harness.app.inject({
    method: "DELETE",
    url,
    ...(user === undefined ? {} : { headers: user.auth }),
  });

const errorCode = (payload: string): string =>
  json<{ error: { code: string } }>(payload).error.code;

describe("health", () => {
  it("liveness reports which adapters are in use", async () => {
    const response = await get("/health");
    expect(response.statusCode).toBe(200);
    expect(json<{ adapters: Record<string, string> }>(response.payload).adapters).toEqual({
      database: "pglite",
      keyValue: "memory",
      broker: "memory",
    });
  });

  it("readiness checks the dependencies", async () => {
    // Separate from liveness on purpose: wiring a dependency check into liveness turns a brief
    // database blip into a restart loop across every replica.
    const response = await get("/ready");
    expect(response.statusCode).toBe(200);
    expect(json<{ ready: boolean; checks: Record<string, string> }>(response.payload)).toEqual({
      ready: true,
      checks: { database: "ok", keyValue: "ok" },
    });
  });

  it("both are reachable without a token", async () => {
    for (const url of ["/health", "/ready"]) {
      expect((await get(url)).statusCode).toBe(200);
    }
  });
});

describe("registration and login", () => {
  it("registers and returns a usable token pair", async () => {
    const response = await post("/api/auth/register", {
      email: "New.User@Example.test",
      name: "New User",
      password: "a-sufficiently-long-password",
    });
    expect(response.statusCode).toBe(201);

    const body = json<{ user: { id: string; email: string }; tokens: { accessToken: string } }>(
      response.payload,
    );
    // Normalised on the way in, so `lower(email)` in the unique index matches what is stored.
    expect(body.user.email).toBe("new.user@example.test");

    const me = await harness.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${body.tokens.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it("never returns the password hash", async () => {
    // The mapper names every field rather than spreading the row, which is what makes this true
    // by construction. The test is here because both are strings and no type error would catch it.
    const response = await post("/api/auth/register", {
      email: "hash@example.test",
      name: "Hash",
      password: "a-sufficiently-long-password",
    });
    expect(response.payload).not.toContain("scrypt$");
    expect(response.payload).not.toContain("passwordHash");
  });

  it("rejects a duplicate email regardless of case", async () => {
    const body = {
      email: "dupe@example.test",
      name: "Dupe",
      password: "a-sufficiently-long-password",
    };
    expect((await post("/api/auth/register", body)).statusCode).toBe(201);
    const second = await post("/api/auth/register", { ...body, email: "DUPE@Example.test" });
    expect(second.statusCode).toBe(409);
    expect(errorCode(second.payload)).toBe("conflict");
  });

  it("rejects a bad email, a short password and a blank name", async () => {
    for (const [payload, fragment] of [
      [{ email: "not-an-email", name: "A", password: "a-long-enough-password" }, "valid address"],
      [{ email: "a@b.test", name: "A", password: "short" }, "at least"],
      [{ email: "a@b.test", name: "   ", password: "a-long-enough-password" }, "name is required"],
    ] as const) {
      const response = await post("/api/auth/register", payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(json<{ error: { message: string } }>(response.payload).error.message).toContain(fragment);
    }
  });

  it("logs in with the right password", async () => {
    await post("/api/auth/register", {
      email: "login@example.test",
      name: "Login",
      password: "a-sufficiently-long-password",
    });
    const response = await post("/api/auth/login", {
      email: "LOGIN@example.test",
      password: "a-sufficiently-long-password",
    });
    expect(response.statusCode).toBe(200);
  });

  it("gives the same answer for a wrong password and an unknown address", async () => {
    // Otherwise the login form is a membership oracle: try an address, and the error tells you
    // whether that person has an account here.
    await post("/api/auth/register", {
      email: "known@example.test",
      name: "Known",
      password: "a-sufficiently-long-password",
    });

    const wrongPassword = await post("/api/auth/login", {
      email: "known@example.test",
      password: "the-wrong-password-entirely",
    });
    const unknownEmail = await post("/api/auth/login", {
      email: "nobody@example.test",
      password: "the-wrong-password-entirely",
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(json<{ error: { message: string } }>(wrongPassword.payload).error.message).toBe(
      json<{ error: { message: string } }>(unknownEmail.payload).error.message,
    );
  });

  it("refresh rotates, and logout kills the session immediately", async () => {
    const user = await createUser(harness);

    const refreshed = await post("/api/auth/refresh", { refreshToken: user.refreshToken });
    expect(refreshed.statusCode).toBe(200);

    const replayed = await post("/api/auth/refresh", { refreshToken: user.refreshToken });
    expect(replayed.statusCode).toBe(401);

    const newTokens = json<{ tokens: { accessToken: string } }>(refreshed.payload).tokens;
    const logout = await harness.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { authorization: `Bearer ${newTokens.accessToken}` },
    });
    expect(logout.statusCode).toBe(204);

    const after = await harness.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${newTokens.accessToken}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("changing a password revokes every session", async () => {
    // A password change usually means the old one is compromised; leaving refresh tokens valid
    // means the attacker keeps their access while the user believes otherwise.
    const registered = await post("/api/auth/register", {
      email: "rotate@example.test",
      name: "Rotate",
      password: "the-original-password",
    });
    const tokens = json<{ tokens: { accessToken: string; refreshToken: string } }>(
      registered.payload,
    ).tokens;

    const changed = await harness.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { currentPassword: "the-original-password", newPassword: "the-replacement-password" },
    });
    expect(changed.statusCode).toBe(200);
    expect(json<{ revokedSessions: number }>(changed.payload).revokedSessions).toBeGreaterThan(0);

    expect((await post("/api/auth/refresh", { refreshToken: tokens.refreshToken })).statusCode).toBe(401);
  });

  it("refuses a password change with the wrong current password, or an unchanged one", async () => {
    const registered = await post("/api/auth/register", {
      email: "guard@example.test",
      name: "Guard",
      password: "the-original-password",
    });
    const token = json<{ tokens: { accessToken: string } }>(registered.payload).tokens.accessToken;
    const change = (payload: Record<string, unknown>) =>
      harness.app.inject({
        method: "POST",
        url: "/api/auth/password",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });

    expect(
      (await change({ currentPassword: "wrong-one-entirely", newPassword: "another-password-x" }))
        .statusCode,
    ).toBe(401);
    expect(
      (await change({ currentPassword: "the-original-password", newPassword: "the-original-password" }))
        .statusCode,
    ).toBe(400);
  });
});

describe("authentication is required", () => {
  it("rejects an anonymous request to a private route", async () => {
    const response = await get("/api/workspaces");
    expect(response.statusCode).toBe(401);
    expect(errorCode(response.payload)).toBe("unauthenticated");
  });

  it("rejects a malformed Authorization header", async () => {
    for (const header of ["", "Bearer", "Basic abc", "Bearer not-a-jwt"]) {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/workspaces",
        headers: { authorization: header },
      });
      expect(response.statusCode, header).toBe(401);
    }
  });

  it("rejects an expired token", async () => {
    const user = await createUser(harness);
    harness.clock.advance(11 * MINUTE);
    expect((await get("/api/workspaces", user)).statusCode).toBe(401);
  });

  it("treats a bad token as an error even on a public route", async () => {
    // Silently ignoring it would make "logged in with an expired session" look identical to
    // "logged out", and the client would never know to refresh.
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { authorization: "Bearer garbage" },
      payload: { email: "a@b.test", password: "whatever-goes-here" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("workspaces", () => {
  it("creates a workspace and makes the creator its owner", async () => {
    const user = await createUser(harness);
    const response = await post("/api/workspaces", { name: "Platform Team" }, user);
    expect(response.statusCode).toBe(201);

    const body = json<{ role: string; permissions: string[]; workspace: { slug: string } }>(
      response.payload,
    );
    expect(body.role).toBe("owner");
    expect(body.permissions).toContain("workspace:delete");
    expect(body.workspace.slug).toMatch(/^platform-team-/);
  });

  it("lists only the workspaces the caller belongs to", async () => {
    const [mine, theirs] = [await createUser(harness), await createUser(harness)];
    await createWorkspace(harness, mine);
    await createWorkspace(harness, theirs);

    const response = await get("/api/workspaces", mine);
    expect(json<{ workspaces: unknown[] }>(response.payload).workspaces).toHaveLength(1);
  });

  it("returns 404, not 403, for a workspace the caller is not in", async () => {
    // "Forbidden" would confirm the workspace exists, which is a slow enumeration oracle over a
    // guessable id space.
    const [owner, stranger] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner);

    const response = await get(`/api/workspaces/${workspace.id}`, stranger);
    expect(response.statusCode).toBe(404);
    expect(errorCode(response.payload)).toBe("not_found");
  });

  it("returns the same 404 for a workspace that does not exist", async () => {
    const user = await createUser(harness);
    const real = await createWorkspace(harness, await createUser(harness));
    const missing = await get("/api/workspaces/wsp_DOESNOTEXIST0000000000000", user);
    const notMine = await get(`/api/workspaces/${real.id}`, user);
    expect(missing.statusCode).toBe(notMine.statusCode);
    expect(errorCode(missing.payload)).toBe(errorCode(notMine.payload));
  });

  it("only the owner may delete", async () => {
    const [owner, admin] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: admin, role: "admin" }]);

    const byAdmin = await remove(`/api/workspaces/${workspace.id}`, admin);
    expect(byAdmin.statusCode).toBe(403);
    expect(errorCode(byAdmin.payload)).toBe("forbidden");

    expect((await remove(`/api/workspaces/${workspace.id}`, owner)).statusCode).toBe(204);
  });

  it("a member may not rename, an admin may", async () => {
    const [owner, admin, member] = [
      await createUser(harness),
      await createUser(harness),
      await createUser(harness),
    ];
    const workspace = await createWorkspace(harness, owner, [
      { user: admin, role: "admin" },
      { user: member, role: "member" },
    ]);

    expect((await patch(`/api/workspaces/${workspace.id}`, { name: "Nope" }, member)).statusCode).toBe(403);
    expect((await patch(`/api/workspaces/${workspace.id}`, { name: "Yes" }, admin)).statusCode).toBe(200);
  });

  it("rejects an empty or over-long name", async () => {
    const user = await createUser(harness);
    for (const name of ["", "   ", "x".repeat(201)]) {
      expect((await post("/api/workspaces", { name }, user)).statusCode).toBe(400);
    }
  });
});

describe("membership", () => {
  it("an admin may add a member; a member may not", async () => {
    const [owner, admin, member, newcomer] = await Promise.all([
      createUser(harness),
      createUser(harness),
      createUser(harness),
      createUser(harness),
    ]);
    const workspace = await createWorkspace(harness, owner, [
      { user: admin, role: "admin" },
      { user: member, role: "member" },
    ]);

    expect(
      (await post(`/api/workspaces/${workspace.id}/members`, { userId: newcomer.id, role: "viewer" }, member))
        .statusCode,
    ).toBe(403);
    expect(
      (await post(`/api/workspaces/${workspace.id}/members`, { userId: newcomer.id, role: "viewer" }, admin))
        .statusCode,
    ).toBe(201);
  });

  it("only an owner may add another owner", async () => {
    const [owner, admin, newcomer] = await Promise.all([
      createUser(harness),
      createUser(harness),
      createUser(harness),
    ]);
    const workspace = await createWorkspace(harness, owner, [{ user: admin, role: "admin" }]);

    expect(
      (await post(`/api/workspaces/${workspace.id}/members`, { userId: newcomer.id, role: "owner" }, admin))
        .statusCode,
    ).toBe(403);
    expect(
      (await post(`/api/workspaces/${workspace.id}/members`, { userId: newcomer.id, role: "owner" }, owner))
        .statusCode,
    ).toBe(201);
  });

  it("refuses to add the same person twice", async () => {
    const [owner, member] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: member, role: "member" }]);
    const response = await post(
      `/api/workspaces/${workspace.id}/members`,
      { userId: member.id, role: "viewer" },
      owner,
    );
    expect(response.statusCode).toBe(409);
  });

  it("refuses to add someone who does not exist", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const response = await post(
      `/api/workspaces/${workspace.id}/members`,
      { userId: "usr_NOBODY00000000000000000", role: "member" },
      owner,
    );
    expect(response.statusCode).toBe(404);
  });

  it("an admin may not demote the owner", async () => {
    const [owner, admin] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: admin, role: "admin" }]);
    const response = await patch(
      `/api/workspaces/${workspace.id}/members/${owner.id}`,
      { role: "viewer" },
      admin,
    );
    expect(response.statusCode).toBe(403);
    expect(json<{ error: { message: string } }>(response.payload).error.message).toContain("only an owner");
  });

  it("the last owner cannot demote themselves", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const response = await patch(
      `/api/workspaces/${workspace.id}/members/${owner.id}`,
      { role: "admin" },
      owner,
    );
    expect(response.statusCode).toBe(403);
    expect(json<{ error: { message: string } }>(response.payload).error.message).toContain(
      "at least one owner",
    );
  });

  it("an owner may demote themselves once a second owner exists", async () => {
    const [first, second] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, first, [{ user: second, role: "owner" }]);
    expect(
      (await patch(`/api/workspaces/${workspace.id}/members/${first.id}`, { role: "admin" }, first))
        .statusCode,
    ).toBe(200);
  });

  it("a member may leave although no role below admin can remove", async () => {
    // Routing "leave" through `member:remove` would trap every member in every workspace they
    // ever joined.
    const [owner, member] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: member, role: "member" }]);

    expect(
      (await remove(`/api/workspaces/${workspace.id}/members/${member.id}`, member)).statusCode,
    ).toBe(204);
    // And they can no longer see it.
    expect((await get(`/api/workspaces/${workspace.id}`, member)).statusCode).toBe(404);
  });

  it("a member may not remove somebody else", async () => {
    const [owner, member, other] = await Promise.all([
      createUser(harness),
      createUser(harness),
      createUser(harness),
    ]);
    const workspace = await createWorkspace(harness, owner, [
      { user: member, role: "member" },
      { user: other, role: "member" },
    ]);
    expect(
      (await remove(`/api/workspaces/${workspace.id}/members/${other.id}`, member)).statusCode,
    ).toBe(403);
  });

  it("the last owner may not leave", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    expect(
      (await remove(`/api/workspaces/${workspace.id}/members/${owner.id}`, owner)).statusCode,
    ).toBe(403);
  });

  it("a demotion takes effect on the very next request", async () => {
    // The reason roles are not in the access token. With them, this would keep working until the
    // token expired.
    const [owner, admin] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: admin, role: "admin" }]);

    expect((await patch(`/api/workspaces/${workspace.id}`, { name: "Before" }, admin)).statusCode).toBe(200);
    await patch(`/api/workspaces/${workspace.id}/members/${admin.id}`, { role: "viewer" }, owner);
    // Same token, no refresh, no re-login.
    expect((await patch(`/api/workspaces/${workspace.id}`, { name: "After" }, admin)).statusCode).toBe(403);
  });

  it("the audit trail is admin-only and records role changes", async () => {
    const [owner, member] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: member, role: "member" }]);
    await patch(`/api/workspaces/${workspace.id}/members/${member.id}`, { role: "viewer" }, owner);

    expect((await get(`/api/workspaces/${workspace.id}/audit`, member)).statusCode).toBe(403);

    const trail = await get(`/api/workspaces/${workspace.id}/audit`, owner);
    expect(trail.statusCode).toBe(200);
    const entries = json<{ entries: Array<{ action: string; subject: string }> }>(trail.payload).entries;
    expect(entries.map((entry) => entry.action)).toContain("member.role.changed");
    expect(entries.find((entry) => entry.action === "member.role.changed")?.subject).toBe(member.id);
  });
});

describe("cross-workspace isolation", () => {
  it("an owner of one workspace has no standing in another", async () => {
    // The bug this guards: looking the resource up by id and then checking the actor's role
    // somewhere, rather than in that resource's workspace.
    const [first, second] = [await createUser(harness), await createUser(harness)];
    const theirs = await createWorkspace(harness, second);
    const board = await createBoard(harness, theirs.id, second);
    const item = await createItem(harness, board.id, second);
    await createWorkspace(harness, first); // first is an owner -- of their own workspace

    expect((await get(`/api/boards/${board.id}`, first)).statusCode).toBe(404);
    expect((await get(`/api/items/${item.id}`, first)).statusCode).toBe(404);
    expect(
      (await patch(`/api/items/${item.id}`, { expectedVersion: 1, title: "Hijacked" }, first))
        .statusCode,
    ).toBe(404);
    expect((await post(`/api/boards/${board.id}/items`, { title: "Injected" }, first)).statusCode).toBe(404);
  });

  it("an item cannot be assigned to somebody outside the workspace", async () => {
    // Otherwise any user id in the system could be assigned work in a workspace they cannot see,
    // which both leaks that the id exists and puts a name on a board they have no access to.
    const [owner, outsider] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);

    const response = await post(
      `/api/boards/${board.id}/items`,
      { title: "Task", assigneeId: outsider.id },
      owner,
    );
    expect(response.statusCode).toBe(400);
    expect(json<{ error: { message: string } }>(response.payload).error.message).toContain(
      "not a member",
    );
  });
});

describe("items", () => {
  it("a viewer may read but not create", async () => {
    const [owner, viewer] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: viewer, role: "viewer" }]);
    const board = await createBoard(harness, workspace.id, owner);
    await createItem(harness, board.id, owner);

    expect((await get(`/api/boards/${board.id}/items`, viewer)).statusCode).toBe(200);
    expect((await post(`/api/boards/${board.id}/items`, { title: "Nope" }, viewer)).statusCode).toBe(403);
  });

  it("a member may edit their own item but not someone else's", async () => {
    const [owner, member] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: member, role: "member" }]);
    const board = await createBoard(harness, workspace.id, owner);
    const mine = await createItem(harness, board.id, member, "Mine");
    const theirs = await createItem(harness, board.id, owner, "Theirs");

    expect(
      (await patch(`/api/items/${mine.id}`, { expectedVersion: 1, title: "Edited" }, member))
        .statusCode,
    ).toBe(200);
    const forbidden = await patch(
      `/api/items/${theirs.id}`,
      { expectedVersion: 1, title: "Edited" },
      member,
    );
    expect(forbidden.statusCode).toBe(403);
    expect(json<{ error: { message: string } }>(forbidden.payload).error.message).toContain(
      "own resources",
    );
  });

  it("an admin may edit anyone's item", async () => {
    const [owner, admin, member] = await Promise.all([
      createUser(harness),
      createUser(harness),
      createUser(harness),
    ]);
    const workspace = await createWorkspace(harness, owner, [
      { user: admin, role: "admin" },
      { user: member, role: "member" },
    ]);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, member);

    expect(
      (await patch(`/api/items/${item.id}`, { expectedVersion: 1, status: "done" }, admin)).statusCode,
    ).toBe(200);
  });

  it("a member may not reassign, even their own item", async () => {
    // Assignment is a coordination act, not an editing one: letting members reassign work is how
    // an item ends up owned by whoever touched it last.
    const [owner, member] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: member, role: "member" }]);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, member);

    const response = await patch(
      `/api/items/${item.id}`,
      { expectedVersion: 1, assigneeId: owner.id },
      member,
    );
    expect(response.statusCode).toBe(403);
    expect(json<{ error: { details?: { action?: string } } }>(response.payload).error.details?.action).toBe(
      "item:assign",
    );
  });

  it("a member may still edit other fields without tripping the assign check", async () => {
    // Checking `item:assign` unconditionally would make saving an unrelated field fail.
    const [owner, member] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: member, role: "member" }]);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, member);

    const response = await patch(
      `/api/items/${item.id}`,
      { expectedVersion: 1, title: "Renamed", assigneeId: null },
      member,
    );
    expect(response.statusCode).toBe(200);
  });

  it("a member cannot assign on create either", async () => {
    // Otherwise "cannot reassign" is bypassed by doing it at creation time.
    const [owner, member] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: member, role: "member" }]);
    const board = await createBoard(harness, workspace.id, owner);

    expect(
      (await post(`/api/boards/${board.id}/items`, { title: "T", assigneeId: owner.id }, member))
        .statusCode,
    ).toBe(403);
    // Assigning to themselves is fine: that is not handing work to anybody.
    expect(
      (await post(`/api/boards/${board.id}/items`, { title: "T", assigneeId: member.id }, member))
        .statusCode,
    ).toBe(201);
  });

  it("validates title and status", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);

    expect((await post(`/api/boards/${board.id}/items`, { title: "  " }, owner)).statusCode).toBe(400);
    expect((await post(`/api/boards/${board.id}/items`, { title: "x".repeat(301) }, owner)).statusCode).toBe(400);
    expect(
      (await post(`/api/boards/${board.id}/items`, { title: "T", status: "invented" }, owner)).statusCode,
    ).toBe(400);
  });

  it("filters and paginates with a stable cursor", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    for (let index = 0; index < 5; index += 1) {
      harness.clock.advance(1000); // distinct created_at values, so the ordering is total
      await createItem(harness, board.id, owner, `Item ${index}`);
    }

    const first = await get(`/api/boards/${board.id}/items?limit=2`, owner);
    const firstPage = json<{ items: Array<{ id: string }>; nextCursor: string | null }>(first.payload);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const second = await get(
      `/api/boards/${board.id}/items?limit=2&after=${firstPage.nextCursor}`,
      owner,
    );
    const secondPage = json<{ items: Array<{ id: string }> }>(second.payload);
    // Keyset, not offset: no overlap between pages even if rows were inserted in between.
    const firstIds = new Set(firstPage.items.map((item) => item.id));
    expect(secondPage.items.some((item) => firstIds.has(item.id))).toBe(false);
  });

  it("filters by status", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const open = await createItem(harness, board.id, owner, "Open");
    const done = await createItem(harness, board.id, owner, "Done");
    await patch(`/api/items/${done.id}`, { expectedVersion: 1, status: "done" }, owner);

    const response = await get(`/api/boards/${board.id}/items?status=done`, owner);
    const items = json<{ items: Array<{ id: string }> }>(response.payload).items;
    expect(items.map((item) => item.id)).toEqual([done.id]);
    expect(items.map((item) => item.id)).not.toContain(open.id);
  });

  it("rejects an unknown status filter", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    expect((await get(`/api/boards/${board.id}/items?status=invented`, owner)).statusCode).toBe(400);
  });
});

describe("optimistic concurrency", () => {
  it("increments the version on every update", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, owner);

    const first = await patch(`/api/items/${item.id}`, { expectedVersion: 1, title: "A" }, owner);
    expect(json<{ item: { version: number } }>(first.payload).item.version).toBe(2);

    const second = await patch(`/api/items/${item.id}`, { expectedVersion: 2, title: "B" }, owner);
    expect(json<{ item: { version: number } }>(second.payload).item.version).toBe(3);
  });

  it("rejects a stale write with 409 and the current version", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, owner);

    await patch(`/api/items/${item.id}`, { expectedVersion: 1, title: "First" }, owner);
    const stale = await patch(`/api/items/${item.id}`, { expectedVersion: 1, title: "Second" }, owner);

    expect(stale.statusCode).toBe(409);
    const body = json<{ error: { code: string; details: { currentVersion: number } } }>(stale.payload);
    expect(body.error.code).toBe("version_conflict");
    // Sent back so the client can rebase rather than guess.
    expect(body.error.details.currentVersion).toBe(2);

    const current = await get(`/api/items/${item.id}`, owner);
    expect(json<{ item: { title: string } }>(current.payload).item.title).toBe("First");
  });

  it("only one of two concurrent updates at the same version wins", async () => {
    // A read-then-write in application code cannot do this: both requests read version 1, both
    // decide they are fine, and the second silently overwrites the first.
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, owner);

    const [first, second] = await Promise.all([
      patch(`/api/items/${item.id}`, { expectedVersion: 1, title: "Writer A" }, owner),
      patch(`/api/items/${item.id}`, { expectedVersion: 1, title: "Writer B" }, owner),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const final = await get(`/api/items/${item.id}`, owner);
    expect(json<{ item: { version: number } }>(final.payload).item.version).toBe(2);
  });

  it("requires expectedVersion", async () => {
    // An update without one is a blind write, so the field is required rather than optional.
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, owner);

    expect((await patch(`/api/items/${item.id}`, { title: "No version" }, owner)).statusCode).toBe(400);
    for (const expectedVersion of [0, -1, 1.5]) {
      expect(
        (await patch(`/api/items/${item.id}`, { expectedVersion, title: "Bad" }, owner)).statusCode,
        String(expectedVersion),
      ).toBe(400);
    }
  });
});

describe("idempotency", () => {
  const key = { "idempotency-key": "client-generated-key-1" };

  it("a retried POST creates one item and replays the response", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);

    const first = await post(`/api/boards/${board.id}/items`, { title: "Task" }, owner, key);
    const second = await post(`/api/boards/${board.id}/items`, { title: "Task" }, owner, key);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(json<{ item: { id: string } }>(second.payload).item.id).toBe(
      json<{ item: { id: string } }>(first.payload).item.id,
    );

    const listed = await get(`/api/boards/${board.id}/items`, owner);
    expect(json<{ items: unknown[] }>(listed.payload).items).toHaveLength(1);
  });

  it("the same key with a different body is a conflict", async () => {
    // Otherwise a client that reuses a key by mistake is silently handed the wrong resource.
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);

    await post(`/api/boards/${board.id}/items`, { title: "First" }, owner, key);
    const different = await post(`/api/boards/${board.id}/items`, { title: "Second" }, owner, key);
    expect(different.statusCode).toBe(409);
    expect(json<{ error: { message: string } }>(different.payload).error.message).toContain(
      "different request",
    );
  });

  it("keys are scoped per user", async () => {
    const [first, second] = [await createUser(harness), await createUser(harness)];
    const firstWorkspace = await createWorkspace(harness, first);
    const secondWorkspace = await createWorkspace(harness, second);
    const firstBoard = await createBoard(harness, firstWorkspace.id, first);
    const secondBoard = await createBoard(harness, secondWorkspace.id, second);

    expect((await post(`/api/boards/${firstBoard.id}/items`, { title: "A" }, first, key)).statusCode).toBe(201);
    // Same key, different user: must not replay the other user's response or conflict with it.
    expect((await post(`/api/boards/${secondBoard.id}/items`, { title: "B" }, second, key)).statusCode).toBe(201);
  });

  it("a failed request releases the key so a retry can work", async () => {
    // Leaving the claim would answer every retry with "in progress" until the TTL expired.
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);

    const failed = await post(`/api/boards/${board.id}/items`, { title: "  " }, owner, key);
    expect(failed.statusCode).toBe(400);

    const retried = await post(`/api/boards/${board.id}/items`, { title: "Valid" }, owner, key);
    expect(retried.statusCode).toBe(201);
  });

  it("exactly one of two simultaneous retries creates the resource", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);

    const [first, second] = await Promise.all([
      post(`/api/boards/${board.id}/items`, { title: "Task" }, owner, key),
      post(`/api/boards/${board.id}/items`, { title: "Task" }, owner, key),
    ]);

    // One creates; the other either replays it or is told it is still in flight. Never two items.
    expect([first.statusCode, second.statusCode].filter((status) => status === 201).length).toBeGreaterThanOrEqual(1);
    const listed = await get(`/api/boards/${board.id}/items`, owner);
    expect(json<{ items: unknown[] }>(listed.payload).items).toHaveLength(1);
  });

  it("a POST without a key is unaffected", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);

    await post(`/api/boards/${board.id}/items`, { title: "One" }, owner);
    await post(`/api/boards/${board.id}/items`, { title: "One" }, owner);
    const listed = await get(`/api/boards/${board.id}/items`, owner);
    expect(json<{ items: unknown[] }>(listed.payload).items).toHaveLength(2);
  });

  it("rejects an over-long key", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const response = await post(`/api/boards/${board.id}/items`, { title: "T" }, owner, {
      "idempotency-key": "x".repeat(300),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("comments", () => {
  it("a member may comment and delete their own; a viewer may not comment", async () => {
    const [owner, member, viewer] = await Promise.all([
      createUser(harness),
      createUser(harness),
      createUser(harness),
    ]);
    const workspace = await createWorkspace(harness, owner, [
      { user: member, role: "member" },
      { user: viewer, role: "viewer" },
    ]);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, owner);

    expect((await post(`/api/items/${item.id}/comments`, { body: "No" }, viewer)).statusCode).toBe(403);

    const created = await post(`/api/items/${item.id}/comments`, { body: "Looks good" }, member);
    expect(created.statusCode).toBe(201);
    const commentId = json<{ comment: { id: string } }>(created.payload).comment.id;

    expect((await remove(`/api/comments/${commentId}`, member)).statusCode).toBe(204);
  });

  it("a member may not delete another member's comment, an admin may", async () => {
    const [owner, member, admin] = await Promise.all([
      createUser(harness),
      createUser(harness),
      createUser(harness),
    ]);
    const workspace = await createWorkspace(harness, owner, [
      { user: member, role: "member" },
      { user: admin, role: "admin" },
    ]);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, owner);

    const created = await post(`/api/items/${item.id}/comments`, { body: "Mine" }, owner);
    const commentId = json<{ comment: { id: string } }>(created.payload).comment.id;

    expect((await remove(`/api/comments/${commentId}`, member)).statusCode).toBe(403);
    expect((await remove(`/api/comments/${commentId}`, admin)).statusCode).toBe(204);
  });

  it("validates the body", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, owner);

    for (const body of ["", "   ", "x".repeat(5001)]) {
      expect((await post(`/api/items/${item.id}/comments`, { body }, owner)).statusCode).toBe(400);
    }
  });
});

describe("transport behaviour", () => {
  it("sets the security headers on every response", async () => {
    const response = await get("/health");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    // An API response cached by a shared proxy would be served to the wrong user.
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("echoes an allowed origin and never a wildcard with credentials", async () => {
    const allowed = await harness.app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:3000" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    expect(allowed.headers["vary"]).toBe("origin");

    const denied = await harness.app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example" },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    expect(denied.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("answers a preflight without running the route", async () => {
    const response = await harness.app.inject({
      method: "OPTIONS",
      url: "/api/workspaces",
      headers: { origin: "http://localhost:3000" },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(String(response.headers["access-control-allow-headers"])).toContain("idempotency-key");
  });

  it("returns a structured 404 for an unknown route, with or without a token", async () => {
    // Not 401. Requiring auth before routing would report every mistyped URL as a rejected
    // token, and the route table is in the README anyway.
    const anonymous = await get("/api/nope");
    expect(anonymous.statusCode).toBe(404);
    expect(errorCode(anonymous.payload)).toBe("not_found");

    const authenticated = await get("/api/nope", await createUser(harness));
    expect(authenticated.statusCode).toBe(404);
  });

  it("still reports a bad token on an unknown route", async () => {
    // A broken session is a different problem from a wrong URL, and the caller needs to be able
    // to tell them apart.
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/nope",
      headers: { authorization: "Bearer garbage" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("unknown routes share one rate-limit bucket", async () => {
    // Otherwise inventing a fresh URL per request hands the caller an unlimited supply of
    // budgets.
    const limited = await createHarness({
      rateLimit: { windowSeconds: 60, maxRequests: 3, authMaxRequests: 3 },
    });
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        statuses.push(
          (await limited.app.inject({ method: "GET", url: `/api/invented-${attempt}` })).statusCode,
        );
      }
      expect(statuses).toContain(429);
    } finally {
      await limited.close();
    }
  });

  it("rejects a malformed JSON body as 400, not 500", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(400);
  });

  it("includes a request id in every error, echoing a well-formed one", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { "x-request-id": "trace-abc-123" },
    });
    expect(json<{ error: { requestId: string } }>(response.payload).error.requestId).toBe("trace-abc-123");
  });

  it("ignores an implausible request id rather than writing it into the logs", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { "x-request-id": "a".repeat(500) },
    });
    const requestId = json<{ error: { requestId: string } }>(response.payload).error.requestId;
    expect(requestId).toMatch(/^req_/);
  });
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After once the budget is exhausted", async () => {
    const limited = await createHarness({
      rateLimit: { windowSeconds: 60, maxRequests: 3, authMaxRequests: 3 },
    });
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        statuses.push((await limited.app.inject({ method: "GET", url: "/health" })).statusCode);
      }
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses.slice(3)).toEqual([429, 429]);

      const blocked = await limited.app.inject({ method: "GET", url: "/health" });
      expect(blocked.headers["retry-after"]).toBeDefined();
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });

  it("reports the budget on every response", async () => {
    const limited = await createHarness({
      rateLimit: { windowSeconds: 60, maxRequests: 5, authMaxRequests: 5 },
    });
    try {
      const response = await limited.app.inject({ method: "GET", url: "/health" });
      expect(response.headers["x-ratelimit-limit"]).toBe("5");
      expect(response.headers["x-ratelimit-remaining"]).toBe("4");
      expect(Number(response.headers["x-ratelimit-reset"])).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });

  it("recovers once the window elapses, rather than locking the client out for good", async () => {
    // The bug the fixed window exists to avoid: re-stamping the TTL on every increment means a
    // client that keeps retrying is never allowed back.
    const limited = await createHarness({
      rateLimit: { windowSeconds: 60, maxRequests: 2, authMaxRequests: 2 },
    });
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await limited.app.inject({ method: "GET", url: "/health" });
      }
      expect((await limited.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(429);

      limited.clock.advanceSeconds(61);
      expect((await limited.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it("gives the auth routes their own, tighter budget", async () => {
    // The credential-stuffing surface, and the one endpoint class where the caller has no
    // identity yet. Sharing the general budget here would allow hundreds of guesses a minute.
    const limited = await createHarness({
      rateLimit: { windowSeconds: 60, maxRequests: 100, authMaxRequests: 2 },
    });
    try {
      const attempt = () =>
        limited.app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: "a@b.test", password: "wrong-password-here" },
        });

      expect((await attempt()).statusCode).toBe(401);
      expect((await attempt()).statusCode).toBe(401);
      expect((await attempt()).statusCode).toBe(429);

      // The general budget is untouched: exhausting the login limit must not take the API down.
      expect((await limited.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it("cannot be defeated by varying a path parameter", async () => {
    // The bucket is keyed on the registered route pattern, not the concrete URL.
    const limited = await createHarness({
      rateLimit: { windowSeconds: 60, maxRequests: 3, authMaxRequests: 3 },
    });
    try {
      const user = await createUser(limited);
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        statuses.push(
          (
            await limited.app.inject({
              method: "GET",
              url: `/api/workspaces/wsp_VARYING${attempt}0000000000000`,
              headers: user.auth,
            })
          ).statusCode,
        );
      }
      expect(statuses).toContain(429);
    } finally {
      await limited.close();
    }
  });
});
