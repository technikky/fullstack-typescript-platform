/**
 * The REST surface.
 *
 * Handlers are thin on purpose: validate the shape, call the service, choose a status code. No
 * authorization logic lives here -- it is all in the service, which resolves the actor's role from
 * the database. That is what makes the GraphQL surface safe by construction too, and it is what
 * the parity test checks.
 *
 * Bodies are validated with zod at the boundary. Fastify's JSON schema validation would also
 * work; zod is used because the parsed result is typed, so a handler cannot read a field the
 * schema did not promise.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Container } from "../container.js";
import { badRequest, unauthenticated } from "../errors.js";
import { ITEM_STATUSES } from "../domain/types.js";
import { ROLES } from "../authz/policy.js";

const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    throw badRequest(
      first === undefined
        ? "invalid request body"
        : `${first.path.join(".") || "body"}: ${first.message}`,
      { issues: result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
    );
  }
  return result.data;
};

const userId = (request: FastifyRequest): string => {
  if (request.claims === null) throw unauthenticated();
  return request.claims.userId;
};

const statusEnum = z.enum(ITEM_STATUSES);
const roleEnum = z.enum(ROLES);

const registerBody = z.object({
  email: z.string(),
  name: z.string(),
  password: z.string(),
});
const loginBody = z.object({ email: z.string(), password: z.string() });
const refreshBody = z.object({ refreshToken: z.string().min(1) });
const nameBody = z.object({ name: z.string() });
const memberBody = z.object({ userId: z.string().min(1), role: roleEnum });
const roleBody = z.object({ role: roleEnum });
const createItemBody = z.object({
  title: z.string(),
  body: z.string().optional(),
  status: statusEnum.optional(),
  assigneeId: z.string().nullable().optional(),
});
const updateItemBody = z.object({
  expectedVersion: z.number().int().positive(),
  title: z.string().optional(),
  body: z.string().optional(),
  status: statusEnum.optional(),
  assigneeId: z.string().nullable().optional(),
});
const commentBody = z.object({ body: z.string() });
const passwordBody = z.object({
  currentPassword: z.string(),
  newPassword: z.string(),
});

/**
 * Wrap a mutating handler in idempotency handling when the client supplied a key.
 *
 * Opt-in by header. Requiring a key on every POST would break a plain `curl`, and generating one
 * server-side defeats the purpose: the value of the key is that the *client* keeps it across a
 * retry.
 */
const withIdempotency = async (
  container: Container,
  request: FastifyRequest,
  reply: FastifyReply,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<unknown> => {
  const header = request.headers["idempotency-key"];
  const key = typeof header === "string" ? header.trim() : null;

  if (key === null || key.length === 0) {
    const result = await run();
    return reply.code(result.status).send(result.body);
  }

  const actor = userId(request);
  const rawBody = JSON.stringify(request.body ?? null);
  const path = request.routeOptions.url ?? request.url;
  const outcome = await container.idempotency.begin(actor, key, request.method, path, rawBody);

  if (outcome.kind === "replay") {
    // Signposted so a client can tell a replay from a fresh write; the body is byte-identical.
    reply.header("idempotency-replayed", "true");
    return reply.code(outcome.status).type("application/json").send(outcome.body);
  }
  if (outcome.kind === "in_flight") {
    reply.header("retry-after", "1");
    return reply.code(409).send({
      error: {
        code: "conflict",
        message: "a request with this Idempotency-Key is still in progress",
        requestId: request.id,
      },
    });
  }

  try {
    const result = await run();
    await container.idempotency.complete(
      actor,
      key,
      request.method,
      path,
      rawBody,
      result.status,
      JSON.stringify(result.body),
    );
    return reply.code(result.status).send(result.body);
  } catch (thrown) {
    // Release the claim so the client can genuinely retry. Keeping it would answer every retry
    // with "in progress" until the TTL expired.
    await container.idempotency.abandon(actor, key).catch(() => undefined);
    throw thrown;
  }
};

export const registerRestRoutes = async (
  app: FastifyInstance,
  container: Container,
): Promise<void> => {
  const { accounts, workspaces, work, tokens } = container;

  // --- auth -------------------------------------------------------------------------

  app.post("/api/auth/register", async (request, reply) => {
    const body = parse(registerBody, request.body);
    const result = await accounts.register(body);
    return reply.code(201).send(result);
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = parse(loginBody, request.body);
    return reply.code(200).send(await accounts.login(body));
  });

  app.post("/api/auth/refresh", async (request, reply) => {
    const body = parse(refreshBody, request.body);
    return reply.code(200).send({ tokens: await tokens.refresh(body.refreshToken) });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    if (request.claims === null) throw unauthenticated();
    await tokens.logout(request.claims);
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (request, reply) => {
    const user = await accounts.byId(userId(request));
    // A valid token for a deleted account: 401, not 404. The caller's problem is that their
    // session is no longer usable, and that is what they need to be told.
    if (user === null) throw unauthenticated("account no longer exists");
    return reply.send({ user });
  });

  app.post("/api/auth/password", async (request, reply) => {
    const body = parse(passwordBody, request.body);
    const result = await accounts.changePassword(
      userId(request),
      body.currentPassword,
      body.newPassword,
    );
    return reply.send(result);
  });

  // --- workspaces -------------------------------------------------------------------

  app.get("/api/workspaces", async (request, reply) =>
    reply.send({ workspaces: await workspaces.listFor(userId(request)) }),
  );

  app.post("/api/workspaces", async (request, reply) =>
    withIdempotency(container, request, reply, async () => {
      const body = parse(nameBody, request.body);
      return { status: 201, body: await workspaces.create(userId(request), body.name) };
    }),
  );

  app.get<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) =>
    reply.send(await workspaces.view(request.params.id, userId(request))),
  );

  app.patch<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
    const body = parse(nameBody, request.body);
    return reply.send({
      workspace: await workspaces.rename(
        request.params.id,
        userId(request),
        body.name,
        request.events,
      ),
    });
  });

  app.delete<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
    await workspaces.remove(request.params.id, userId(request));
    return reply.code(204).send();
  });

  // --- members ----------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/members", async (request, reply) =>
    reply.send({ members: await workspaces.members(request.params.id, userId(request)) }),
  );

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/members", async (request, reply) =>
    withIdempotency(container, request, reply, async () => {
      const body = parse(memberBody, request.body);
      return {
        status: 201,
        body: {
          membership: await workspaces.addMember(
            request.params.id,
            userId(request),
            body.userId,
            body.role,
            request.events,
          ),
        },
      };
    }),
  );

  app.patch<{ Params: { id: string; userId: string } }>(
    "/api/workspaces/:id/members/:userId",
    async (request, reply) => {
      const body = parse(roleBody, request.body);
      return reply.send({
        membership: await workspaces.changeRole(
          request.params.id,
          userId(request),
          request.params.userId,
          body.role,
          request.events,
        ),
      });
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    "/api/workspaces/:id/members/:userId",
    async (request, reply) => {
      await workspaces.removeMember(
        request.params.id,
        userId(request),
        request.params.userId,
        request.events,
      );
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/workspaces/:id/audit",
    async (request, reply) => {
      const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
      if (!Number.isFinite(limit)) throw badRequest("limit must be a number");
      return reply.send({
        entries: await workspaces.auditTrail(request.params.id, userId(request), limit),
      });
    },
  );

  // --- boards -----------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/boards", async (request, reply) =>
    reply.send({ boards: await work.listBoards(request.params.id, userId(request)) }),
  );

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/boards", async (request, reply) =>
    withIdempotency(container, request, reply, async () => {
      const body = parse(nameBody, request.body);
      return {
        status: 201,
        body: {
          board: await work.createBoard(
            request.params.id,
            userId(request),
            body.name,
            request.events,
          ),
        },
      };
    }),
  );

  app.get<{ Params: { id: string } }>("/api/boards/:id", async (request, reply) =>
    reply.send({ board: await work.getBoard(request.params.id, userId(request)) }),
  );

  app.patch<{ Params: { id: string } }>("/api/boards/:id", async (request, reply) => {
    const body = parse(nameBody, request.body);
    return reply.send({
      board: await work.renameBoard(request.params.id, userId(request), body.name, request.events),
    });
  });

  app.delete<{ Params: { id: string } }>("/api/boards/:id", async (request, reply) => {
    await work.deleteBoard(request.params.id, userId(request), request.events);
    return reply.code(204).send();
  });

  // --- items ------------------------------------------------------------------------

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; after?: string; status?: string };
  }>("/api/boards/:id/items", async (request, reply) => {
    const { limit, after, status } = request.query;
    return reply.send(
      await work.listItems(request.params.id, userId(request), {
        ...(limit === undefined ? {} : { limit: Number(limit) }),
        ...(after === undefined ? {} : { after }),
        ...(status === undefined ? {} : { status: parse(statusEnum, status) }),
      }),
    );
  });

  app.post<{ Params: { id: string } }>("/api/boards/:id/items", async (request, reply) =>
    withIdempotency(container, request, reply, async () => {
      const body = parse(createItemBody, request.body);
      // Keys are spread conditionally rather than passed through. Under
      // `exactOptionalPropertyTypes`, `{ body: undefined }` and `{}` are different types, and
      // the distinction is real: the first says "set this to nothing", the second says "leave
      // it alone". A PATCH that conflated them would blank every field the client omitted.
      const input = {
        title: body.title,
        ...(body.body === undefined ? {} : { body: body.body }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.assigneeId === undefined ? {} : { assigneeId: body.assigneeId }),
      };
      return {
        status: 201,
        body: {
          item: await work.createItem(request.params.id, userId(request), input, request.events),
        },
      };
    }),
  );

  app.get<{ Params: { id: string } }>("/api/items/:id", async (request, reply) =>
    reply.send({ item: await work.getItem(request.params.id, userId(request)) }),
  );

  app.patch<{ Params: { id: string } }>("/api/items/:id", async (request, reply) => {
    const body = parse(updateItemBody, request.body);
    const patch = {
      expectedVersion: body.expectedVersion,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.body === undefined ? {} : { body: body.body }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.assigneeId === undefined ? {} : { assigneeId: body.assigneeId }),
    };
    return reply.send({
      item: await work.updateItem(request.params.id, userId(request), patch, request.events),
    });
  });

  app.delete<{ Params: { id: string } }>("/api/items/:id", async (request, reply) => {
    await work.deleteItem(request.params.id, userId(request), request.events);
    return reply.code(204).send();
  });

  // --- comments ---------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/items/:id/comments", async (request, reply) =>
    reply.send({ comments: await work.listComments(request.params.id, userId(request)) }),
  );

  app.post<{ Params: { id: string } }>("/api/items/:id/comments", async (request, reply) =>
    withIdempotency(container, request, reply, async () => {
      const body = parse(commentBody, request.body);
      return {
        status: 201,
        body: {
          comment: await work.addComment(
            request.params.id,
            userId(request),
            body.body,
            request.events,
          ),
        },
      };
    }),
  );

  app.delete<{ Params: { id: string } }>("/api/comments/:id", async (request, reply) => {
    await work.deleteComment(request.params.id, userId(request), request.events);
    return reply.code(204).send();
  });
};
