/**
 * REST and GraphQL must agree.
 *
 * This is the test the whole two-surface design exists to make possible. The bug it guards
 * against is specific and common: a REST route checks a permission, the resolver over the same
 * data does not, and the GraphQL endpoint becomes a documented way around the permission system.
 * Both surfaces work, both are tested in isolation, and nothing notices.
 *
 * The defence is structural -- resolvers hold no authorization logic and call the same service
 * methods -- and this file is the proof. A table of (role, operation) pairs is run through both
 * transports and the *decisions* are compared, not just the happy paths.
 *
 * It would also fail if someone added a field to one surface and forgot the other, which is the
 * milder version of the same problem.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Role } from "../src/authz/policy.js";
import {
  createBoard,
  createHarness,
  createItem,
  createUser,
  createWorkspace,
  graphql,
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

/**
 * The outcome of an operation, reduced to what both transports can express.
 *
 * HTTP says 403 with `error.code`; GraphQL says 200 with `errors[0].extensions.code`. Comparing
 * status codes directly would be comparing transport conventions, not decisions, so both are
 * normalised to `{ ok, code }` first.
 */
interface Outcome {
  readonly ok: boolean;
  readonly code: string | null;
}

const restOutcome = (status: number, payload: string): Outcome => {
  if (status < 400) return { ok: true, code: null };
  const body = json<{ error?: { code?: string } }>(payload);
  return { ok: false, code: body.error?.code ?? null };
};

const graphqlOutcome = (result: {
  errors: Array<{ extensions?: { code?: string } }>;
}): Outcome => {
  const first = result.errors[0];
  if (first === undefined) return { ok: true, code: null };
  return { ok: false, code: first.extensions?.code ?? null };
};

interface Fixture {
  readonly owner: TestUser;
  readonly actor: TestUser;
  readonly workspaceId: string;
  readonly boardId: string;
  /** An item created by the owner, so the actor does not own it. */
  readonly othersItemId: string;
  readonly othersItemVersion: number;
}

const setUp = async (role: Role | null): Promise<Fixture> => {
  const owner = await createUser(harness);
  const actor = await createUser(harness);
  const workspace = await createWorkspace(
    harness,
    owner,
    role === null || role === "owner" ? [] : [{ user: actor, role }],
  );
  if (role === "owner") {
    await harness.container.database.query(
      `insert into memberships (id, workspace_id, user_id, role, created_at, updated_at)
       values ($1, $2, $3, 'owner', now(), now())`,
      [`mbr_PARITY${Math.random().toString(36).slice(2, 12).toUpperCase()}`, workspace.id, actor.id],
    );
  }
  const board = await createBoard(harness, workspace.id, owner);
  const item = await createItem(harness, board.id, owner, "Owner's item");
  return {
    owner,
    actor,
    workspaceId: workspace.id,
    boardId: board.id,
    othersItemId: item.id,
    othersItemVersion: item.version,
  };
};

/**
 * Each case names one operation and how to invoke it on both surfaces.
 *
 * Every case is run for all four roles plus a non-member, so the table is 4 operations x 5 actors
 * of paired assertions rather than a handful of happy paths.
 */
interface Case {
  readonly name: string;
  rest(fixture: Fixture): Promise<Outcome>;
  graphql(fixture: Fixture): Promise<Outcome>;
}

const CASES: readonly Case[] = [
  {
    name: "read the workspace",
    rest: async (fixture) => {
      const response = await harness.app.inject({
        method: "GET",
        url: `/api/workspaces/${fixture.workspaceId}`,
        headers: fixture.actor.auth,
      });
      return restOutcome(response.statusCode, response.payload);
    },
    graphql: async (fixture) =>
      graphqlOutcome(
        await graphql(
          harness,
          fixture.actor,
          "query ($id: String!) { workspace(id: $id) { role permissions } }",
          { id: fixture.workspaceId },
        ),
      ),
  },
  {
    name: "rename the workspace",
    rest: async (fixture) => {
      const response = await harness.app.inject({
        method: "PATCH",
        url: `/api/workspaces/${fixture.workspaceId}`,
        headers: fixture.actor.auth,
        payload: { name: "Renamed by REST" },
      });
      return restOutcome(response.statusCode, response.payload);
    },
    graphql: async (fixture) =>
      graphqlOutcome(
        await graphql(
          harness,
          fixture.actor,
          "mutation ($id: String!, $name: String!) { renameWorkspace(id: $id, name: $name) { id } }",
          { id: fixture.workspaceId, name: "Renamed by GraphQL" },
        ),
      ),
  },
  {
    name: "create an item",
    rest: async (fixture) => {
      const response = await harness.app.inject({
        method: "POST",
        url: `/api/boards/${fixture.boardId}/items`,
        headers: fixture.actor.auth,
        payload: { title: "Created by REST" },
      });
      return restOutcome(response.statusCode, response.payload);
    },
    graphql: async (fixture) =>
      graphqlOutcome(
        await graphql(
          harness,
          fixture.actor,
          "mutation ($boardId: String!, $title: String!) { createItem(boardId: $boardId, title: $title) { id } }",
          { boardId: fixture.boardId, title: "Created by GraphQL" },
        ),
      ),
  },
  {
    name: "update somebody else's item",
    rest: async (fixture) => {
      const response = await harness.app.inject({
        method: "PATCH",
        url: `/api/items/${fixture.othersItemId}`,
        headers: fixture.actor.auth,
        payload: { expectedVersion: fixture.othersItemVersion, title: "Edited by REST" },
      });
      return restOutcome(response.statusCode, response.payload);
    },
    graphql: async (fixture) =>
      graphqlOutcome(
        await graphql(
          harness,
          fixture.actor,
          `mutation ($id: String!, $v: Int!, $title: String!) {
             updateItem(id: $id, expectedVersion: $v, title: $title) { id version }
           }`,
          {
            id: fixture.othersItemId,
            v: fixture.othersItemVersion,
            title: "Edited by GraphQL",
          },
        ),
      ),
  },
  {
    name: "read the audit trail",
    rest: async (fixture) => {
      const response = await harness.app.inject({
        method: "GET",
        url: `/api/workspaces/${fixture.workspaceId}/audit`,
        headers: fixture.actor.auth,
      });
      return restOutcome(response.statusCode, response.payload);
    },
    graphql: async (fixture) =>
      graphqlOutcome(
        await graphql(
          harness,
          fixture.actor,
          "query ($id: String!) { auditTrail(workspaceId: $id) { action } }",
          { id: fixture.workspaceId },
        ),
      ),
  },
  {
    name: "delete the workspace",
    rest: async (fixture) => {
      const response = await harness.app.inject({
        method: "DELETE",
        url: `/api/workspaces/${fixture.workspaceId}`,
        headers: fixture.actor.auth,
      });
      return restOutcome(response.statusCode, response.payload);
    },
    graphql: async (fixture) =>
      graphqlOutcome(
        await graphql(harness, fixture.actor, "mutation ($id: String!) { deleteWorkspace(id: $id) }", {
          id: fixture.workspaceId,
        }),
      ),
  },
];

const ACTORS: ReadonlyArray<Role | null> = ["owner", "admin", "member", "viewer", null];

describe("REST and GraphQL reach the same authorization decision", () => {
  for (const actorRole of ACTORS) {
    for (const testCase of CASES) {
      it(`${actorRole ?? "non-member"} / ${testCase.name}`, async () => {
        // Two independent fixtures, because the operations mutate. Running both surfaces against
        // one fixture would let the first call change what the second sees -- a rename that
        // succeeded would make the second rename a no-op rather than an equivalent test.
        const restFixture = await setUp(actorRole);
        const restResult = await testCase.rest(restFixture);

        const graphqlFixture = await setUp(actorRole);
        const graphqlResult = await testCase.graphql(graphqlFixture);

        expect(graphqlResult, `${actorRole ?? "non-member"} / ${testCase.name}`).toEqual(restResult);
      });
    }
  }
});

describe("the two surfaces return the same data", () => {
  it("a workspace view matches field for field", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);

    const rest = await harness.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}`,
      headers: owner.auth,
    });
    const restBody = json<{
      workspace: Record<string, unknown>;
      role: string;
      permissions: string[];
    }>(rest.payload);

    const result = await graphql(
      harness,
      owner,
      // Every field the REST shape carries, so a field added to one surface and forgotten on
      // the other fails here rather than in a client.
      `query ($id: String!) {
         workspace(id: $id) {
           workspace { id name slug createdBy createdAt }
           role
           permissions
         }
       }`,
      { id: workspace.id },
    );
    const gqlBody = (result.data as {
      workspace: { workspace: Record<string, unknown>; role: string; permissions: string[] };
    }).workspace;

    expect(gqlBody.workspace).toEqual(restBody.workspace);
    // GraphQL uppercases enum values by convention; the underlying value is the same.
    expect(gqlBody.role.toLowerCase()).toBe(restBody.role);
    expect(new Set(gqlBody.permissions)).toEqual(new Set(restBody.permissions));
  });

  it("an item matches field for field, including its version", async () => {
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, owner, "Shared item");

    const rest = await harness.app.inject({
      method: "GET",
      url: `/api/items/${item.id}`,
      headers: owner.auth,
    });
    const restItem = json<{ item: Record<string, unknown> }>(rest.payload).item;

    const result = await graphql(
      harness,
      owner,
      `query ($id: String!) {
         item(id: $id) {
           id boardId title body status assigneeId version createdBy createdAt updatedAt
         }
       }`,
      { id: item.id },
    );
    const gqlItem = (result.data as { item: Record<string, unknown> }).item;

    expect({ ...gqlItem, status: String(gqlItem["status"]).toLowerCase() }).toEqual(restItem);
  });

  it("both expose the version, so an optimistic update is possible on either", async () => {
    // A surface that hides `version` forces blind writes, and then the two surfaces disagree
    // about whether concurrency is checked at all.
    const owner = await createUser(harness);
    const workspace = await createWorkspace(harness, owner);
    const board = await createBoard(harness, workspace.id, owner);
    const item = await createItem(harness, board.id, owner);

    const result = await graphql(
      harness,
      owner,
      `mutation ($id: String!, $v: Int!) { updateItem(id: $id, expectedVersion: $v, title: "Bumped") { version } }`,
      { id: item.id, v: 1 },
    );
    expect((result.data as { updateItem: { version: number } }).updateItem.version).toBe(2);

    // And a stale version conflicts on GraphQL exactly as it does on REST.
    const stale = await graphql(
      harness,
      owner,
      `mutation ($id: String!, $v: Int!) { updateItem(id: $id, expectedVersion: $v, title: "Stale") { version } }`,
      { id: item.id, v: 1 },
    );
    expect(stale.errors[0]?.extensions?.code).toBe("version_conflict");
  });
});

describe("the GraphQL endpoint shares the HTTP pipeline", () => {
  it("requires a token", async () => {
    // Not public: an anonymous query would have to be authorised field by field, and one missed
    // field is a leak.
    const response = await harness.app.inject({
      method: "POST",
      url: "/graphql",
      payload: { query: "{ me { id } }" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a bad token the same way REST does", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/graphql",
      headers: { authorization: "Bearer garbage" },
      payload: { query: "{ me { id } }" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("carries the same security headers", async () => {
    const user = await createUser(harness);
    const response = await harness.app.inject({
      method: "POST",
      url: "/graphql",
      headers: user.auth,
      payload: { query: "{ me { id } }" },
    });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-ratelimit-limit"]).toBeDefined();
  });

  it("is counted against the rate limit", async () => {
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
              method: "POST",
              url: "/graphql",
              headers: user.auth,
              payload: { query: "{ me { id } }" },
            })
          ).statusCode,
        );
      }
      expect(statuses).toContain(429);
    } finally {
      await limited.close();
    }
  });

  it("rejects GET", async () => {
    // A mutation over GET is CSRF-able and cacheable.
    const user = await createUser(harness);
    const response = await harness.app.inject({
      method: "GET",
      url: "/graphql",
      headers: user.auth,
    });
    expect(response.statusCode).toBe(405);
    expect(response.headers["allow"]).toBe("POST");
  });

  it("rejects a missing or unparseable query with 400", async () => {
    const user = await createUser(harness);
    for (const payload of [{}, { query: "" }, { query: "{ this is not graphql" }]) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/graphql",
        headers: user.auth,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("rejects a query that does not validate with 400, not 200-with-errors", async () => {
    // A document that never ran is not a successful response, and reporting it as one makes
    // every client's error handling harder.
    const user = await createUser(harness);
    const response = await harness.app.inject({
      method: "POST",
      url: "/graphql",
      headers: user.auth,
      payload: { query: "{ noSuchField }" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("enforces a depth limit", async () => {
    const user = await createUser(harness);
    // Deeply nested aliases of a scalar: valid syntax, and enough selection sets to exceed the
    // limit.
    const nested = `{ ${"me { ".repeat(15)}id ${"}".repeat(15)} }`;
    const response = await harness.app.inject({
      method: "POST",
      url: "/graphql",
      headers: user.auth,
      payload: { query: nested },
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 200 with an errors array for a field-level failure", async () => {
    // The GraphQL contract: a partial result is still a result, and collapsing it to a 4xx would
    // discard the data that did resolve.
    const [owner, stranger] = [await createUser(harness), await createUser(harness)];
    const workspace = await createWorkspace(harness, owner);

    const response = await harness.app.inject({
      method: "POST",
      url: "/graphql",
      headers: stranger.auth,
      payload: {
        query: "query ($id: String!) { workspace(id: $id) { role } }",
        variables: { id: workspace.id },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = json<{ errors: Array<{ extensions: { code: string } }> }>(response.payload);
    expect(body.errors[0]?.extensions.code).toBe("not_found");
  });

  it("allows introspection outside production and refuses it in production", async () => {
    const user = await createUser(harness);
    const allowed = await harness.app.inject({
      method: "POST",
      url: "/graphql",
      headers: user.auth,
      payload: { query: "{ __schema { queryType { name } } }" },
    });
    expect(allowed.statusCode).toBe(200);

    const production = await createHarness({ nodeEnv: "production" });
    try {
      const productionUser = await createUser(production);
      const refused = await production.app.inject({
        method: "POST",
        url: "/graphql",
        headers: productionUser.auth,
        payload: { query: "{ __schema { queryType { name } } }" },
      });
      expect(refused.statusCode).toBe(400);
    } finally {
      await production.close();
    }
  });

  it("exposes no field that could return a password hash", async () => {
    const user = await createUser(harness);
    const result = await graphql(
      harness,
      user,
      `{ __type(name: "User") { fields { name } } }`,
    );
    const fields = (
      result.data as { __type: { fields: Array<{ name: string }> } }
    ).__type.fields.map((field) => field.name);
    expect(fields).toEqual(["id", "email", "name", "createdAt"]);
  });
});
