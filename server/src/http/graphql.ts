/**
 * The GraphQL HTTP endpoint.
 *
 * Mounted on the same Fastify instance as REST, so it inherits CORS, security headers, rate
 * limiting and authentication from the shared hooks. A GraphQL server bolted on as its own
 * listener is how an endpoint ends up unrate-limited and differently authenticated from its
 * REST neighbour.
 *
 * Three protections that are not defaults anywhere:
 *
 * **Query depth is bounded.** A recursive selection is a cheap way to make the server do
 * quadratic work. This schema has no recursive relations today, so the limit is generous, but it
 * is enforced now rather than after someone adds one.
 *
 * **Introspection is disabled outside development.** Not a security boundary -- the schema is in
 * this repository -- but there is no reason for a production endpoint to enumerate itself, and
 * turning it off later is the change nobody remembers to make.
 *
 * **GET is rejected.** A mutation over GET is CSRF-able and cacheable. Rejecting the method
 * outright is simpler and safer than inspecting the document to decide.
 */

import type { FastifyInstance } from "fastify";
import {
  GraphQLError,
  Kind,
  execute,
  parse as parseGraphQL,
  specifiedRules,
  validate,
  type ASTVisitor,
  type DocumentNode,
  type ValidationContext,
} from "graphql";

import type { Container } from "../container.js";
import { AppError, toAppError } from "../errors.js";
import { schema, type GraphQLContext } from "../graphql/schema.js";

export const MAX_QUERY_DEPTH = 12;

/**
 * Reject a document nested deeper than `maxDepth`.
 *
 * Written as a validation rule rather than a post-parse walk so it runs inside `validate`,
 * before any resolver executes and before the cost is paid.
 */
const depthLimit =
  (maxDepth: number) =>
  (context: ValidationContext): ASTVisitor => {
    let depth = 0;
    return {
      SelectionSet: {
        enter() {
          depth += 1;
          if (depth > maxDepth) {
            context.reportError(
              new GraphQLError(`query exceeds the maximum depth of ${maxDepth}`),
            );
          }
        },
        leave() {
          depth -= 1;
        },
      },
    };
  };

/** True if the document contains an introspection-only selection at the top level. */
const isIntrospection = (document: DocumentNode): boolean =>
  document.definitions.every((definition) => {
    if (definition.kind !== Kind.OPERATION_DEFINITION) return true;
    return definition.selectionSet.selections.every(
      (selection) => selection.kind === Kind.FIELD && selection.name.value.startsWith("__"),
    );
  });

interface GraphQLBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

export const registerGraphQLRoute = async (
  app: FastifyInstance,
  container: Container,
): Promise<void> => {
  const introspectionAllowed = container.config.nodeEnv !== "production";

  app.get("/graphql", async (_request, reply) =>
    reply.code(405).header("allow", "POST").send({
      error: {
        code: "bad_request",
        message: "GraphQL is POST only; a mutation over GET is CSRF-able and cacheable",
      },
    }),
  );

  app.post("/graphql", async (request, reply) => {
    const body = (request.body ?? {}) as GraphQLBody;
    if (typeof body.query !== "string" || body.query.trim().length === 0) {
      return reply.code(400).send({
        errors: [{ message: "a query string is required", extensions: { code: "bad_request" } }],
      });
    }

    let document: DocumentNode;
    try {
      document = parseGraphQL(body.query);
    } catch (thrown) {
      return reply.code(400).send({
        errors: [
          {
            message: thrown instanceof GraphQLError ? thrown.message : "could not parse the query",
            extensions: { code: "bad_request" },
          },
        ],
      });
    }

    if (!introspectionAllowed && isIntrospection(document)) {
      return reply.code(400).send({
        errors: [
          { message: "introspection is disabled", extensions: { code: "bad_request" } },
        ],
      });
    }

    const validationErrors = validate(schema, document, [
      ...specifiedRules,
      depthLimit(MAX_QUERY_DEPTH),
    ]);
    if (validationErrors.length > 0) {
      // 400, not 200. A document that does not validate never ran, and reporting that as a
      // success with errors in the body makes every client's error handling harder.
      return reply.code(400).send({
        errors: validationErrors.map((error) => ({
          message: error.message,
          ...(error.locations === undefined ? {} : { locations: error.locations }),
          extensions: { code: "bad_request" },
        })),
      });
    }

    const context: GraphQLContext = {
      userId: request.claims?.userId ?? null,
      accounts: container.accounts,
      workspaces: container.workspaces,
      work: container.work,
      events: request.events,
    };

    const result = await execute({
      schema,
      document,
      contextValue: context,
      ...(body.variables !== undefined && body.variables !== null
        ? { variableValues: body.variables as Record<string, unknown> }
        : {}),
      ...(typeof body.operationName === "string" ? { operationName: body.operationName } : {}),
    });

    // Field errors carry the same `code` as the REST surface would return for the same cause.
    // That is what makes the two surfaces comparable, and a parity test asserts it.
    const errors = result.errors?.map((error) => {
      const original = error.originalError;
      const appError = original instanceof AppError ? original : toAppError(original);
      if (!(original instanceof AppError)) {
        request.log.error({ err: original ?? error }, "graphql resolver error");
      }
      return {
        message: appError.code === "internal" ? "internal error" : error.message,
        ...(error.path === undefined ? {} : { path: error.path }),
        extensions: {
          code: appError.code,
          ...(Object.keys(appError.details).length > 0 ? { details: appError.details } : {}),
        },
      };
    });

    // 200 even with field errors: the document was valid and executed. A partial result is the
    // GraphQL contract, and collapsing it to a 4xx would discard the data that did resolve.
    return reply.code(200).send({
      ...(result.data === undefined ? {} : { data: result.data }),
      ...(errors === undefined ? {} : { errors }),
    });
  });
};
