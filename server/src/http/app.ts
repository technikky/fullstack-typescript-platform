/**
 * The HTTP surface: REST, GraphQL, health, and the WebSocket upgrade.
 *
 * Both API surfaces are mounted here and both go through the same request pipeline -- CORS,
 * security headers, rate limit, authentication, error mapping. Mounting GraphQL outside that
 * pipeline is the standard way an endpoint ends up unrated-limited and differently authenticated
 * from its REST neighbour.
 *
 * Built with `app.inject()` in mind: every test in this repository exercises the real routing,
 * parsing, serialisation and error mapping in-process, with no listening socket and no port. A
 * test that calls a handler function directly proves nothing about the route it is mounted on.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import type { Container } from "../container.js";
import { AppError, toAppError, unauthenticated } from "../errors.js";
import { EventBuffer } from "../domain/events.js";
import type { AccessClaims } from "../auth/tokens.js";
import { registerRestRoutes } from "./rest.js";
import { registerGraphQLRoute } from "./graphql.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the authentication hook. Null for an anonymous request. */
    claims: AccessClaims | null;
    /** Events accumulated by this request's handlers, flushed after a successful response. */
    events: EventBuffer;
  }
}

/** Endpoints reachable without a token. Everything else requires one. */
const PUBLIC_ROUTES = new Set([
  "POST /api/auth/register",
  "POST /api/auth/login",
  "POST /api/auth/refresh",
  "GET /health",
  "GET /ready",
]);

/**
 * Auth endpoints get their own, much smaller rate-limit budget.
 *
 * This is the credential-stuffing surface, and it is the one endpoint class where the caller has
 * no identity yet -- so the limit is keyed on IP and set low. Sharing the general API budget here
 * would allow hundreds of password guesses a minute.
 */
const AUTH_ROUTES = new Set([
  "POST /api/auth/register",
  "POST /api/auth/login",
  "POST /api/auth/refresh",
]);

/** No route matched, so this request is heading for the not-found handler. */
const isUnmatched = (request: FastifyRequest): boolean => request.routeOptions.url === undefined;

const routeKey = (request: FastifyRequest): string => {
  // `routeOptions.url` is the registered pattern (`/api/items/:id`), not the concrete path, so a
  // rate-limit bucket cannot be defeated by varying the id. Unmatched requests share one bucket
  // for the same reason: bucketing them by their concrete path would give a caller an unlimited
  // supply of fresh budgets just by inventing URLs.
  const url = request.routeOptions.url ?? "(unmatched)";
  return `${request.method} ${url}`;
};

export interface AppOptions {
  readonly container: Container;
  /** Overridden in tests so a failing assertion is not buried in request logs. */
  readonly logger?: boolean;
}

export const buildApp = async (options: AppOptions): Promise<FastifyInstance> => {
  const { container } = options;
  const { config } = container;

  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    bodyLimit: config.bodyLimitBytes,
    // Request ids come from the client only when they look like ids. An unbounded
    // `x-request-id` would let a caller write arbitrary text into every log line.
    genReqId: (request) => {
      const supplied = request.headers["x-request-id"];
      if (typeof supplied === "string" && /^[\w.:-]{1,128}$/.test(supplied)) return supplied;
      return `req_${Math.random().toString(36).slice(2, 12)}`;
    },
    trustProxy: true,
  });

  app.decorateRequest("claims", null);
  // Declared without a value: Fastify shares a decorator's value between requests, so
  // seeding it with one EventBuffer would let two concurrent requests append to the same
  // buffer. Each request gets its own in the `preHandler` hook below.
  app.decorateRequest("events");

  // --- CORS ------------------------------------------------------------------------
  //
  // Written out rather than taken from a plugin, because the behaviour that matters is the part
  // a plugin's defaults usually get wrong: the origin is echoed only when it is on the allow
  // list, and `Access-Control-Allow-Credentials` is only ever sent alongside a concrete origin.
  // `*` with credentials is rejected by every browser, and sending both is the most common CORS
  // misconfiguration there is.
  const allowedOrigins = new Set(config.corsOrigins);
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && allowedOrigins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "origin");
    }
    if (request.method === "OPTIONS") {
      reply
        .header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS")
        .header(
          "access-control-allow-headers",
          "content-type,authorization,idempotency-key,x-request-id",
        )
        .header("access-control-max-age", "600")
        .code(204)
        .send();
    }
  });

  // --- security headers ------------------------------------------------------------
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    // This is a JSON API: nothing it returns should ever be rendered as a document, and
    // `frame-ancestors 'none'` is the modern replacement for X-Frame-Options.
    reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    reply.header("cross-origin-resource-policy", "same-origin");
    // An API response is never a cache candidate: several of these are per-actor and one cached
    // by a shared proxy would be served to the wrong user.
    reply.header("cache-control", "no-store");
    return payload;
  });

  // --- rate limit ------------------------------------------------------------------
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    const key = routeKey(request);
    const isAuthRoute = AUTH_ROUTES.has(key);

    // Keyed on the user when known, on the IP otherwise. Auth routes are always keyed on IP,
    // because the caller has no identity yet -- which is exactly why they need the tighter limit.
    const subject = isAuthRoute ? (request.ip ?? "unknown") : null;
    const bucket = isAuthRoute ? "auth" : "api";
    const limits = isAuthRoute
      ? { windowSeconds: config.rateLimit.windowSeconds, maxRequests: config.rateLimit.authMaxRequests }
      : { windowSeconds: config.rateLimit.windowSeconds, maxRequests: config.rateLimit.maxRequests };

    // The authenticated subject is not known yet at `onRequest`, so the general bucket keys on
    // IP here and the per-user bucket is applied in `preHandler` once the token is verified.
    const decision = await container.rateLimiter.check(bucket, subject ?? (request.ip ?? "unknown"), limits);
    reply.header("x-ratelimit-limit", String(decision.limit));
    reply.header("x-ratelimit-remaining", String(decision.remaining));
    reply.header("x-ratelimit-reset", String(decision.resetSeconds));
    if (!decision.allowed) {
      reply.header("retry-after", String(decision.resetSeconds));
      throw new AppError("rate_limited", "too many requests", {
        retryAfterSeconds: decision.resetSeconds,
      });
    }
  });

  // --- authentication --------------------------------------------------------------
  app.addHook("preHandler", async (request) => {
    request.events = new EventBuffer();

    const header = request.headers.authorization;
    const token =
      typeof header === "string" && header.toLowerCase().startsWith("bearer ")
        ? header.slice(7).trim()
        : null;

    if (token !== null) {
      // A bad token is an error even on a public route. Silently ignoring it would make
      // "logged in with an expired session" indistinguishable from "logged out", and the client
      // would never know to refresh.
      request.claims = await container.tokens.verifyAccess(token);
    }

    // An unknown route answers 404 whether or not a token was supplied. Requiring auth first
    // would turn every mistyped URL into "your token was rejected", which costs far more
    // developer time than the route table is worth hiding -- and that table is in the README.
    // A *bad* token still fails above, so a broken session is still reported as one.
    if (request.claims === null && !isUnmatched(request) && !PUBLIC_ROUTES.has(routeKey(request))) {
      // GraphQL is deliberately not public: an anonymous query would have to be authorised
      // field by field, and one missed field is a leak. A token is required to reach the
      // resolver at all.
      throw unauthenticated();
    }

    if (request.claims !== null) {
      // Per-user budget, on top of the per-IP one above. Neither alone is enough: per-IP only
      // punishes shared networks, per-user only leaves anonymous traffic unbounded.
      await container.rateLimiter.enforce("user", request.claims.userId, {
        windowSeconds: config.rateLimit.windowSeconds,
        maxRequests: config.rateLimit.maxRequests,
      });
    }
  });

  // --- events ----------------------------------------------------------------------
  //
  // Flushed after the response, and only for a success. Publishing before the status is known
  // would announce changes that a later error means did not happen; publishing inside the
  // transaction would announce ones a rollback undid.
  app.addHook("onResponse", async (request, reply) => {
    const pending = request.events?.drain() ?? [];
    if (pending.length === 0) return;
    if (reply.statusCode >= 400) return;
    try {
      await container.hub.publish(pending);
    } catch (thrown) {
      // A broker outage must not fail a request that already committed and already returned
      // 200. The cost is a stale screen until the next fetch, which is the right trade.
      request.log.error({ err: thrown }, "failed to publish domain events");
    }
  });

  // --- error mapping ---------------------------------------------------------------
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    // Fastify's own errors (body too large, malformed JSON, unsupported media type) arrive here
    // with a status already attached; preserving it means a 413 does not become a 500.
    const fastifyStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;

    const appError =
      error instanceof AppError
        ? error
        : fastifyStatus !== null && fastifyStatus < 500
          ? new AppError("bad_request", error.message)
          : toAppError(error);

    const status = error instanceof AppError ? appError.status : (fastifyStatus ?? appError.status);

    if (status >= 500) {
      // The full error is logged; the response says nothing about it.
      request.log.error({ err: error }, "unhandled error");
    }
    if (appError.code === "rate_limited") {
      const retryAfter = appError.details["retryAfterSeconds"];
      if (typeof retryAfter === "number") reply.header("retry-after", String(retryAfter));
    }

    reply.code(status).send({
      error: {
        code: appError.code,
        message: appError.message,
        ...(Object.keys(appError.details).length > 0 ? { details: appError.details } : {}),
        requestId: request.id,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: "not_found", message: "no such route", requestId: request.id },
    });
  });

  // --- health ----------------------------------------------------------------------
  //
  // Two endpoints, because Kubernetes asks two different questions. `/health` is liveness: is
  // the process alive -- if it fails, restart me. `/ready` is readiness: can I serve traffic --
  // if it fails, take me out of the load balancer but do not restart me. Wiring a dependency
  // check into liveness turns a brief database blip into a restart loop across every replica.
  app.get("/health", async () => ({ status: "ok", adapters: container.adapters }));

  app.get("/ready", async (_request, reply: FastifyReply) => {
    const checks: Record<string, "ok" | "failed"> = {};
    try {
      await container.database.query("select 1");
      checks["database"] = "ok";
    } catch {
      checks["database"] = "failed";
    }
    try {
      await container.keyValue.ttl("readiness-probe");
      checks["keyValue"] = "ok";
    } catch {
      checks["keyValue"] = "failed";
    }
    const ready = Object.values(checks).every((value) => value === "ok");
    return reply.code(ready ? 200 : 503).send({ ready, checks });
  });

  await registerRestRoutes(app, container);
  await registerGraphQLRoute(app, container);

  return app;
};
