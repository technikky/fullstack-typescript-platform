# Architecture

## Shape

```
                    browser
                       │
        ┌──────────────┴──────────────┐
        │ HTTP                        │ WebSocket (same port)
        ▼                             ▼
┌───────────────────────────────────────────────────┐
│ Fastify                                           │
│  onRequest   CORS → rate limit (per IP)           │
│  preHandler  verify token → rate limit (per user) │
│  routes      REST  ──┐         ┌── /graphql       │
│  onResponse  publish events after a 2xx           │
│  onError     one taxonomy → status / extensions   │
└──────────────────────┼─────────┼──────────────────┘
                       ▼         ▼
              ┌────────────────────────┐
              │ domain services        │  ← the only place authorization happens
              │  accounts  workspaces  │
              │  work                  │
              └───┬──────────────┬─────┘
                  ▼              ▼
          ┌──────────────┐  ┌──────────────┐
          │ Database     │  │ KeyValue     │   ports
          │ port         │  │ Broker       │
          └──┬────────┬──┘  └──┬────────┬──┘
             ▼        ▼        ▼        ▼
          pglite     pg     memory    redis      adapters
        (in-proc)  (server)          (server)
             └────────┴──── one contract suite ───┴────────┘
```

## The rule everything else follows from

**Authorization lives in exactly one layer.** Transports validate shapes and choose status codes;
services resolve the actor's role from the database and call `authorize`. Neither a REST handler nor a
GraphQL resolver contains a permission check.

That is what makes the parity test possible, and the parity test is what keeps it true: 6 operations ×
5 actors through both transports, asserting the decisions match. A resolver that starts doing its own
checks fails the suite.

## Ports and adapters, and why the seam is where it is

The seam is at the **connection**, not the dialect. Both database adapters are PostgreSQL; the SQL text
is identical in each. The port exists so the connection can be swapped, and that buys three things:

**The test suite is hermetic and fast.** `PgliteDatabase` runs PostgreSQL 17 compiled to WebAssembly
in-process — real `jsonb`, real `timestamptz`, real partial indexes, real `for update`, real SQLSTATE
codes. No container, no port, no network. 454 tests in about 20 seconds, with every SQL statement
actually executed by Postgres.

**Production behaviour is still covered.** `PgDatabase` speaks the wire protocol with a pool, which is
what production runs and what the in-process engine cannot exercise: pooling, cross-connection
concurrency, and the protocol itself. CI runs the *same contract suite* against it.

**The in-memory adapters cannot drift.** `MemoryKeyValue` and `RedisKeyValue` face one suite, so the
in-memory one cannot quietly be more permissive. Two cases where it would be easy to be wrong and the
contract catches it:

- `setIfAbsent` must treat an expired key as absent, because Redis expires lazily.
- `incrementInWindow` must fix the expiry at the *first* increment. Re-stamping it on every call
  produces a limiter that never resets under sustained load.

A backend that is not reachable **skips with a printed reason**, and CI fails if anything skipped while
the service containers were up. A suite that silently ran nothing is worse than a red one.

## Module map

### Server

| Module | Owns | Notes |
| --- | --- | --- |
| `config.ts` | env parsing, cross-field rules | Refuses to boot on a bad combination |
| `clock.ts` | time as a dependency | Nothing else calls `Date.now()` |
| `ids.ts` | prefixed, time-sortable, opaque ids | ULID layout without the dependency |
| `errors.ts` | one error taxonomy | Mapped once per transport |
| `ports/` | `Database`, `KeyValue`, `Broker` | Thin; no query builder |
| `adapters/` | pglite, pg, memory, redis | One contract suite each |
| `db/schema.sql` | constraints as constraints | Several guarantees live here, not in code |
| `auth/password.ts` | scrypt, parameters in the hash | Rehash-on-login |
| `auth/tokens.ts` | JWT, rotation, reuse detection | All in one transaction |
| `authz/policy.ts` | the 88-cell matrix + resource rules | The only authorization logic |
| `domain/accounts.ts` | register, login, password change | No-enumeration login |
| `domain/workspaces.ts` | workspaces, membership, audit | Role resolved per request |
| `domain/work.ts` | boards, items, comments | Optimistic concurrency |
| `domain/events.ts` | event shapes, `EventBuffer` | Published after commit |
| `http/app.ts` | the pipeline, error mapping, health | One instance, both surfaces |
| `http/rest.ts` | routes, zod validation, idempotency | Handlers are thin |
| `http/ratelimit.ts` | limiter + idempotency store | Both in the key-value store |
| `graphql/schema.ts` | schema and resolvers | Resolvers hold no authz |
| `realtime/hub.ts` | sockets, subscriptions, fan-out | Re-checks access on delivery |
| `container.ts` | adapter selection, wiring | One place, logged at startup |
| `bench/loadtest.ts` | a re-runnable load test | Fails on any 5xx |

### Web

| Module | Owns |
| --- | --- |
| `lib/api.ts` | fetch, single-flight refresh, one retry, typed errors |
| `lib/realtime.ts` | connect, authenticate, subscribe, backoff with jitter, replay |
| `lib/runtime-config.ts` | runtime config injection, so one image serves every environment |
| `lib/permissions.ts` | UI gating from the server's permission list |
| `components/` | sign-in, workspace shell, board, connection badge |

## Four decisions worth the words

### Optimistic concurrency is enforced by the database

`items.version` starts at 1; every update runs `where id = $n and version = $expected` and increments.
Zero rows affected means somebody wrote first, and the caller gets 409 **with the current version** so
it can rebase rather than guess.

A read-then-write in application code cannot do this: two requests both read version 3, both decide
they are fine, and the second silently overwrites the first. There is a test that fires two concurrent
updates at the same version and asserts the statuses are exactly `[200, 409]`.

`expectedVersion` is **required** on both surfaces. An optional version would make the blind write the
easy path, and the two surfaces would then disagree about whether concurrency is checked at all.

### Events are published after the commit, and only on success

The buffer is filled by handlers and drained by the `onResponse` hook, which publishes only when the
status is below 400.

- Publishing *inside* the transaction would announce a change a rollback then undoes, and subscribers
  cannot take it back.
- Publishing before the status is known would announce changes a later error means did not happen.

The trade-off runs the other way: a crash between commit and publish loses the notification. That is
the right direction — a missed live update is a stale screen until the next fetch, while a phantom
update is a client showing data that never existed. A broker outage is logged and the request still
returns its 2xx, for the same reason.

### Realtime fan-out goes through the broker

Iterating this process's own socket list works perfectly on one replica and silently breaks on two: a
client connected to pod A never sees a change made on pod B. The failure is invisible in development,
because there is only ever one process.

So the hub publishes to a per-workspace channel and subscribes per socket. The channel is also the
authorization boundary: a socket that is not subscribed cannot receive another workspace's events at
all, rather than receiving them and being filtered — one missing filter would leak another tenant's
data.

Access is re-checked **on delivery** for membership-changing events, so a member removed mid-session
stops receiving events immediately rather than at their next reconnect. Only those events trigger the
check: re-checking on every event would mean a database query per event per socket, turning one busy
board into a query storm.

`tests/realtime.test.ts` asserts the multi-replica property with two hubs sharing one broker — the same
topology as two pods sharing one Redis.

### Idempotent writes claim their slot atomically

`Idempotency-Key` on a POST claims a slot with `SET key value NX PX ttl` — one command, atomic. A `GET`
followed by a `SET` is not, and the gap is exactly where two concurrent retries both decide they are
first. The request fingerprint is stored alongside, so reusing one key with a *different* body is
rejected rather than silently answered with the wrong resource.

A failed request releases the claim, so a client can genuinely retry; leaving it would answer every
retry with "still in progress" until the TTL expired.

## The HTTP pipeline, in order

1. **CORS** — the origin is echoed only when it is on the allow list, and
   `Access-Control-Allow-Credentials` only ever accompanies a concrete origin. `*` with credentials is
   rejected by every browser, and sending both is the most common CORS misconfiguration there is.
2. **Rate limit (per IP)** — bucketed by the *registered route pattern*, so varying a path parameter
   cannot defeat it. Unmatched routes share one bucket, so inventing URLs does not hand out fresh
   budgets.
3. **Authentication** — a bad token is an error even on a public route: silently ignoring it would make
   "expired session" indistinguishable from "logged out", and the client would never know to refresh.
   An unmatched route skips the *requirement*, so a mistyped URL is a 404 rather than a misleading 401.
4. **Rate limit (per user)** — on top of the per-IP one. Per-IP alone punishes shared networks; per-user
   alone leaves anonymous traffic unbounded.
5. **Handler** — validate, call the service, choose a status.
6. **Events** — published after a successful response.
7. **Errors** — one taxonomy mapped to HTTP status or `extensions.code`, with a request id in every
   body. A 500's message is replaced: the original may contain a connection string, a query or a stack
   path.

## Testing strategy

| Suite | Tests | Covers |
| --- | --- | --- |
| `policy.test.ts` | 146 | all 88 matrix cells against an independent table, plus every resource rule |
| `adapters.test.ts` | 45 (+3 in CI) | one contract suite per port, per adapter; schema constraints |
| `auth.test.ts` | 33 | scrypt, rotation, reuse detection, denylist, pruning |
| `api.test.ts` | 75 | REST through real routing, concurrency, idempotency, rate limits, headers |
| `graphql.test.ts` | 24 | every query and mutation, error mapping |
| `parity.test.ts` | 44 | REST vs GraphQL decisions and data |
| `realtime.test.ts` | 33 | hub logic, fan-out across hubs, revocation mid-session |
| `e2e-ws.test.ts` | 10 | a real socket over a real upgrade, on one shared port |
| `config.test.ts` | 27 | boot-time validation, production cross-field rules |
| `primitives.test.ts` | 23 | ids, errors, clock |
| `web/*` | 73 | single-flight refresh, backoff, conflict recovery, permission gating |

Nothing is mocked. The only substitutions are the ones that make tests deterministic rather than
easier to pass: the in-memory key-value store (held to the Redis contract), a controllable clock, and
lowered scrypt parameters — with the real OWASP parameters verified once in their own test.
