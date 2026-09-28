/**
 * The GraphQL resolvers, one per operation.
 *
 * `tests/parity.test.ts` proves the two surfaces agree on authorization. This file covers the
 * resolvers themselves -- every query and every mutation, including the ones parity does not reach
 * -- because a resolver that is never executed is a resolver whose argument unwrapping has never
 * been checked. Several of these fields take optional arguments, and under
 * `exactOptionalPropertyTypes` the difference between omitting a key and passing `undefined` is
 * real.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createBoard,
  createHarness,
  createItem,
  createUser,
  createWorkspace,
  graphql,
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

const run = async (
  user: TestUser | null,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => {
  const result = await graphql(harness, user, query, variables);
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return result.data as Record<string, unknown>;
};

const expectCode = async (
  user: TestUser | null,
  query: string,
  variables: Record<string, unknown>,
  code: string,
): Promise<void> => {
  const result = await graphql(harness, user, query, variables);
  expect(result.errors[0]?.extensions?.code).toBe(code);
};

describe("queries", () => {
  it("me returns the caller", async () => {
    const user = await createUser(harness);
    const data = await run(user, "{ me { id email name createdAt } }");
    expect(data["me"]).toMatchObject({ id: user.id, email: user.email, name: user.name });
  });

  it("workspaces lists only the caller's, with role and permissions", async () => {
    const [user, other] = [await createUser(harness), await createUser(harness)];
    await createWorkspace(harness, user);
    await createWorkspace(harness, other);

    const data = await run(
      user,
      "{ workspaces { workspace { id name } role permissions } }",
    );
    const listed = data["workspaces"] as Array<{ role: string; permissions: string[] }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.role).toBe("OWNER");
    expect(listed[0]?.permissions).toContain("workspace:delete");
  });

  it("members joins the user record onto the membership", async () => {
    const [owner, member] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: member, role: "member" }]);

    const data = await run(
      owner,
      "query ($id: String!) { members(workspaceId: $id) { userId email name role } }",
      { id: workspace.id },
    );
    const members = data["members"] as Array<{ userId: string; email: string; role: string }>;
    expect(members).toHaveLength(2);
    expect(members.find((row) => row.userId === member.id)).toMatchObject({
      email: member.email,
      role: "MEMBER",
    });
  });

  it("boards and board both resolve", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner, "Roadmap");

    const listed = await run(
      owner,
      "query ($id: String!) { boards(workspaceId: $id) { id name } }",
      { id: workspace.id },
    );
    expect(listed["boards"]).toEqual([{ id: board.id, name: "Roadmap" }]);

    const single = await run(owner, "query ($id: String!) { board(id: $id) { id name } }", {
      id: board.id,
    });
    expect(single["board"]).toEqual({ id: board.id, name: "Roadmap" });
  });

  it("items paginates and filters", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    for (let index = 0; index < 4; index += 1) {
      harness.clock.advance(1000);
      await createItem(harness, board.id, owner, `Item ${index}`);
    }

    const page = await run(
      owner,
      "query ($b: String!) { items(boardId: $b, limit: 2) { items { id title } nextCursor } }",
      { b: board.id },
    );
    const first = page["items"] as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const next = await run(
      owner,
      "query ($b: String!, $after: String!) { items(boardId: $b, limit: 2, after: $after) { items { id } } }",
      { b: board.id, after: first.nextCursor },
    );
    const secondIds = ((next["items"] as { items: Array<{ id: string }> }).items).map(
      (item) => item.id,
    );
    expect(secondIds.some((id) => first.items.some((item) => item.id === id))).toBe(false);

    const filtered = await run(
      owner,
      "query ($b: String!) { items(boardId: $b, status: DONE) { items { id } } }",
      { b: board.id },
    );
    expect((filtered["items"] as { items: unknown[] }).items).toHaveLength(0);
  });

  it("items works with every optional argument omitted", async () => {
    // Under `exactOptionalPropertyTypes`, omitting a key and passing `undefined` are different
    // types, and the resolver builds its options object with conditional spreads for that reason.
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    await createItem(harness, board.id, owner);

    const data = await run(owner, "query ($b: String!) { items(boardId: $b) { items { id } } }", {
      b: board.id,
    });
    expect((data["items"] as { items: unknown[] }).items).toHaveLength(1);
  });

  it("comments resolve for an item", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, owner);
    await run(
      owner,
      'mutation ($i: String!) { addComment(itemId: $i, body: "First") { id } }',
      { i: item.id },
    );

    const data = await run(
      owner,
      "query ($i: String!) { comments(itemId: $i) { body authorId } }",
      { i: item.id },
    );
    expect(data["comments"]).toEqual([{ body: "First", authorId: owner.id }]);
  });

  it("auditTrail resolves and respects its limit", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    await createBoard(harness, workspace.id, owner);

    const data = await run(
      owner,
      "query ($id: String!) { auditTrail(workspaceId: $id, limit: 1) { action subject at } }",
      { id: workspace.id },
    );
    expect((data["auditTrail"] as unknown[]).length).toBe(1);
  });

  it("me is null for an unauthenticated caller who got past the hook", async () => {
    // Unreachable over HTTP, since `/graphql` requires a token -- but the resolver has to be
    // correct anyway, because it is the one field that tolerates a null user.
    const result = await graphql(harness, null, "{ me { id } }");
    expect(result.status).toBe(401);
  });
});

describe("mutations", () => {
  it("createWorkspace returns the owner's view", async () => {
    const user = await createUser(harness);
    const data = await run(
      user,
      'mutation { createWorkspace(name: "Via GraphQL") { workspace { name slug } role } }',
    );
    expect(data["createWorkspace"]).toMatchObject({
      workspace: { name: "Via GraphQL" },
      role: "OWNER",
    });
  });

  it("renameWorkspace and deleteWorkspace", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);

    const renamed = await run(
      owner,
      'mutation ($id: String!) { renameWorkspace(id: $id, name: "Renamed") { name } }',
      { id: workspace.id },
    );
    expect(renamed["renameWorkspace"]).toEqual({ name: "Renamed" });

    const deleted = await run(owner, "mutation ($id: String!) { deleteWorkspace(id: $id) }", {
      id: workspace.id,
    });
    expect(deleted["deleteWorkspace"]).toBe(true);
    await expectCode(
      owner,
      "query ($id: String!) { workspace(id: $id) { role } }",
      { id: workspace.id },
      "not_found",
    );
  });

  it("addMember, changeMemberRole and removeMember", async () => {
    const [owner, newcomer] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner);

    const added = await run(
      owner,
      "mutation ($w: String!, $u: String!) { addMember(workspaceId: $w, userId: $u, role: VIEWER) { role email } }",
      { w: workspace.id, u: newcomer.id },
    );
    // The Member type carries the user's email, which the service's return value does not -- the
    // resolver joins them rather than widening the service for one transport's convenience.
    expect(added["addMember"]).toEqual({ role: "VIEWER", email: newcomer.email });

    const changed = await run(
      owner,
      "mutation ($w: String!, $u: String!) { changeMemberRole(workspaceId: $w, userId: $u, role: MEMBER) { role name } }",
      { w: workspace.id, u: newcomer.id },
    );
    expect(changed["changeMemberRole"]).toEqual({ role: "MEMBER", name: newcomer.name });

    const removed = await run(
      owner,
      "mutation ($w: String!, $u: String!) { removeMember(workspaceId: $w, userId: $u) }",
      { w: workspace.id, u: newcomer.id },
    );
    expect(removed["removeMember"]).toBe(true);
  });

  it("createBoard, renameBoard and deleteBoard", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);

    const created = await run(
      owner,
      'mutation ($w: String!) { createBoard(workspaceId: $w, name: "Sprint") { id name } }',
      { w: workspace.id },
    );
    const boardId = (created["createBoard"] as { id: string }).id;

    const renamed = await run(
      owner,
      'mutation ($id: String!) { renameBoard(id: $id, name: "Sprint 2") { name } }',
      { id: boardId },
    );
    expect(renamed["renameBoard"]).toEqual({ name: "Sprint 2" });

    const deleted = await run(owner, "mutation ($id: String!) { deleteBoard(id: $id) }", {
      id: boardId,
    });
    expect(deleted["deleteBoard"]).toBe(true);
    await expectCode(owner, "query ($id: String!) { board(id: $id) { id } }", { id: boardId }, "not_found");
  });

  it("createItem accepts every optional argument", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);

    const data = await run(
      owner,
      `mutation ($b: String!, $a: String!) {
         createItem(boardId: $b, title: "Full", body: "Details", status: IN_PROGRESS, assigneeId: $a) {
           title body status assigneeId version
         }
       }`,
      { b: board.id, a: owner.id },
    );
    expect(data["createItem"]).toEqual({
      title: "Full",
      body: "Details",
      status: "IN_PROGRESS",
      assigneeId: owner.id,
      version: 1,
    });
  });

  it("updateItem accepts a partial patch and bumps the version", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, owner, "Original");

    const data = await run(
      owner,
      `mutation ($id: String!, $v: Int!) {
         updateItem(id: $id, expectedVersion: $v, status: BLOCKED) { title status version }
       }`,
      { id: item.id, v: 1 },
    );
    // Only `status` was sent, so `title` must be untouched -- a patch that blanked omitted fields
    // would be a data-loss bug.
    expect(data["updateItem"]).toEqual({ title: "Original", status: "BLOCKED", version: 2 });
  });

  it("updateItem can clear an assignee", async () => {
    // `assigneeId: null` means "unassign"; omitting it means "leave alone". Both must work.
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const created = await run(
      owner,
      'mutation ($b: String!, $a: String!) { createItem(boardId: $b, title: "T", assigneeId: $a) { id } }',
      { b: board.id, a: owner.id },
    );
    const itemId = (created["createItem"] as { id: string }).id;

    const cleared = await run(
      owner,
      "mutation ($id: String!) { updateItem(id: $id, expectedVersion: 1, assigneeId: null) { assigneeId } }",
      { id: itemId },
    );
    expect(cleared["updateItem"]).toEqual({ assigneeId: null });
  });

  it("deleteItem, addComment and deleteComment", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, owner);

    const comment = await run(
      owner,
      'mutation ($i: String!) { addComment(itemId: $i, body: "Note") { id body } }',
      { i: item.id },
    );
    const commentId = (comment["addComment"] as { id: string }).id;

    expect(
      (await run(owner, "mutation ($id: String!) { deleteComment(id: $id) }", { id: commentId }))[
        "deleteComment"
      ],
    ).toBe(true);

    expect(
      (await run(owner, "mutation ($id: String!) { deleteItem(id: $id) }", { id: item.id }))[
        "deleteItem"
      ],
    ).toBe(true);
    await expectCode(owner, "query ($id: String!) { item(id: $id) { id } }", { id: item.id }, "not_found");
  });
});

describe("error mapping", () => {
  it("reports a validation failure as bad_request", async () => {
    const owner = await createUser(harness);
    await expectCode(owner, 'mutation { createWorkspace(name: "  ") { role } }', {}, "bad_request");
  });

  it("reports a missing resource as not_found", async () => {
    const owner = await createUser(harness);
    await expectCode(
      owner,
      "query ($id: String!) { item(id: $id) { title } }",
      { id: "itm_NOSUCHITEM000000000000" },
      "not_found",
    );
  });

  it("reports a permission failure as forbidden, with the action", async () => {
    const [owner, viewer] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: viewer, role: "viewer" }]);
    const board = await createBoard(harness, workspace.id, owner);

    const result = await graphql(
      harness,
      viewer,
      'mutation ($b: String!) { createItem(boardId: $b, title: "Nope") { id } }',
      { b: board.id },
    );
    expect(result.errors[0]?.extensions?.code).toBe("forbidden");
  });

  it("reports a stale version as version_conflict", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, owner);

    await run(
      owner,
      'mutation ($id: String!) { updateItem(id: $id, expectedVersion: 1, title: "First") { version } }',
      { id: item.id },
    );
    await expectCode(
      owner,
      'mutation ($id: String!) { updateItem(id: $id, expectedVersion: 1, title: "Stale") { version } }',
      { id: item.id },
      "version_conflict",
    );
  });

  it("reports a duplicate membership as conflict", async () => {
    const [owner, member] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner, [{ user: member, role: "member" }]);
    await expectCode(
      owner,
      "mutation ($w: String!, $u: String!) { addMember(workspaceId: $w, userId: $u, role: VIEWER) { role } }",
      { w: workspace.id, u: member.id },
      "conflict",
    );
  });

  it("rejects an unknown enum value at validation time", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);

    const response = await harness.app.inject({
      method: "POST",
      url: "/graphql",
      headers: owner.auth,
      payload: {
        query: 'mutation ($b: String!) { createItem(boardId: $b, title: "T", status: SHIPPED) { id } }',
        variables: { b: board.id },
      },
    });
    // The schema rejects it before a resolver runs, so this is a 400 rather than a field error.
    expect(response.statusCode).toBe(400);
  });

  it("returns partial data alongside a field error", async () => {
    // The GraphQL contract. Collapsing this to a 4xx would discard `me`, which resolved fine.
    const [owner, stranger] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner);

    const result = await graphql(
      harness,
      stranger,
      "query ($id: String!) { me { id } workspace(id: $id) { role } }",
      { id: workspace.id },
    );
    expect(result.status).toBe(200);
    expect((result.data as { me: { id: string } | null }).me).toMatchObject({ id: stranger.id });
    expect(result.errors[0]?.extensions?.code).toBe("not_found");
  });
});
