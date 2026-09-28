# fullstack-typescript-platform

Auth, RBAC, REST **and** GraphQL, and WebSockets over one domain layer — in TypeScript, with the
authorization enforced in exactly one place and a test that proves both surfaces agree.

[![CI](https://github.com/technikky/fullstack-typescript-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/technikky/fullstack-typescript-platform/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-20%20%7C%2022-blue)](https://github.com/technikky/fullstack-typescript-platform)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## Why this exists

A platform with two API surfaces over one domain has one interesting failure mode, and it is not a
performance problem: **a REST route checks a permission, the resolver over the same data does not, and
the GraphQL endpoint becomes a documented way around the permission system.** It is easy to write, hard
to notice, and both surfaces work perfectly while it is true.

So this repository is organised around making that impossible rather than unlikely:

- Authorization lives in **one layer**. Handlers and resolvers validate shapes and choose status
  codes; neither contains a permission check.
- The permission matrix is **data** — 4 roles × 22 actions, 88 booleans, every one written out — and it
  is asserted cell by cell against a table written independently of it.
- A **parity test** runs 6 operations × 5 actors through both transports and asserts the *decisions*
  match, normalising away the transport conventions. A resolver that starts doing its own checks fails
  the suite.

The second organising idea is that the whole thing runs with **nothing installed**. The tests execute
PostgreSQL 17 compiled to WebAssembly in-process, so 454 server tests run real SQL in about 20 seconds
with no container and no network — and the `pg` and `ioredis` adapters face the *same contract suites*
against real servers in CI, so the offline convenience cannot become a lie.

---

## Quickstart

```bash
cd server && npm ci
JWT_SECRET="$(openssl rand -base64 48)" npm run dev   # :4000
```

No Postgres, no Redis, no Docker. With no `DATABASE_URL` the server runs PostgreSQL in-process and an
in-memory key-value store, and says so in its startup log and on `/health`.

```bash
cd web && npm ci && npm run dev                        # :3000
```

The real stack:

```bash
cp .env.example .env    # set JWT_SECRET
docker compose up --build
```

---

## What it does

Workspaces contain boards; boards contain items; items have comments and a status. Members hold one of
four roles per workspace. Everything is live over a WebSocket.

That domain is deliberately ordinary — it exists so the engineering underneath it has something honest
to be about.

| Surface | |
| --- | --- |
| REST | 30 routes, zod-validated, opt-in idempotency on writes |
| GraphQL | 10 queries, 13 mutations, depth-limited, introspection off in production |
| WebSocket | one port with HTTP, per-workspace channels, Redis fan-out |
| Client | Next.js 16 / React 19, single-flight token refresh, conflict recovery, RBAC-aware UI |

---

## The things worth reading

### Authorization is one table and one function

```ts
export const PERMISSIONS: Record<Role, Record<Action, boolean>> = { … };  // 88 explicit cells
export const authorize = (actor, action, resource) => Decision;
```

A new `Action` is a compile error in all four role rows until it is answered. There is no default,
because every default is wrong: deny silently breaks a feature, allow silently opens a hole. And role
inheritance is deliberately absent — "admin gets everything member gets, plus…" reads better and hides
a permission added to `member` that silently appears on `owner` too.

Role alone is not the decision. These live in `authorize` and each has its own test:

- **`:own` vs `:any`** — a member edits their own item, not someone else's. The caller names either
  form and gets the same resolution, because a caller that has to choose can choose wrong. A missing
  `ownerId` **denies**: that is a programming error, and failing closed has caught a call site twice.
- **The last owner** cannot be demoted or removed, by anyone including themselves — a workspace with no
  owner can never be administered again. The count is read inside the transaction with `for update`,
  because reading it outside makes it a race.
- **Rank between peers** — an admin may not remove another admin except themselves, and nobody may act
  on an owner except an owner. That last one closes the most common RBAC escalation there is.
- **Leaving is not being removed** — no role below admin holds `member:remove`, so routing "leave"
  through it would trap every member in every workspace they ever joined.

**Roles are not in the access token.** A role in a token cannot be revoked until the token expires, so
demoting an admin would leave them admin for ten minutes. Authorization reads membership per request
instead — one indexed lookup — and that makes this test possible:

```
it("a demotion takes effect on the very next request", …)
```

Same token, no refresh, no re-login: rename succeeds, demote to viewer, rename returns 403.

**Non-members get 404, not 403.** "Forbidden" confirms the resource exists, which is an enumeration
oracle. A test asserts "does not exist" and "not yours" are byte-identical.

→ [docs/authorization.md](docs/authorization.md)

### Ports exist so the test suite can be both hermetic and honest

The seam is at the **connection**, not the dialect — both database adapters are PostgreSQL and the SQL
text is identical.

| Adapter | Locally | In CI |
| --- | --- | --- |
| `PgliteDatabase` — PostgreSQL 17 in WebAssembly, in-process | ✅ always | ✅ |
| `PgDatabase` — wire protocol, connection pool | ⛔ needs a server | ✅ `postgres:17` service |
| `MemoryKeyValue` / `MemoryBroker` | ✅ always | ✅ |
| `RedisKeyValue` / `RedisBroker` | ⛔ needs a server | ✅ `redis:7` service |

**One contract suite per port, run against every implementation.** Without it, an in-memory adapter
drifts toward whatever makes the tests pass and becomes a fake — and then a green local run says
nothing about the Redis production talks to. Two cases the contract catches:

- `setIfAbsent` must treat an **expired** key as absent, because Redis expires lazily. A Map that only
  checks `has()` would refuse a write real Redis allows.
- `incrementInWindow` must fix the expiry at the **first** increment. Re-stamping it on every call
  produces a limiter that never resets under sustained load — so a client that trips it once stays
  locked out for as long as it keeps trying.

An unreachable backend **skips with a printed reason**, and CI fails the build if anything skipped
while the service containers were up. A suite that silently ran nothing is worse than a red one.

### Optimistic concurrency, enforced by the database

Every update carries the version the client saw and runs `where id = $n and version = $expected`. Zero
rows means somebody wrote first, and the caller gets **409 with the current version** so it can rebase
rather than guess.

```
it("only one of two concurrent updates at the same version wins", …)
   → statuses are exactly [200, 409], final version is 2
```

A read-then-write in application code cannot do this: both requests read version 3, both decide they
are fine, the second silently overwrites the first. `expectedVersion` is **required** on both surfaces
— optional would make the blind write the easy path, and then the two surfaces would disagree about
whether concurrency is checked at all.

The client closes the loop: on 409 it refetches and says *"Somebody else changed this item first, so it
was reloaded"*, rather than showing a raw error over stale data.

### Idempotent writes claim their slot atomically

`Idempotency-Key` claims a slot with `SET key value NX PX ttl` — one command. A `GET` then `SET` is not
atomic, and the gap is exactly where two concurrent retries both decide they are first. The request
fingerprint is stored alongside, so the same key with a *different* body is rejected rather than
answered with the wrong resource. A failed request releases the claim, so a retry can genuinely run.

### Realtime that survives a second replica

The hub publishes to a per-workspace channel and never iterates its own socket list. Iterating locals
works perfectly on one replica and silently breaks on two — and the failure is invisible in
development, because there is only ever one process.

```
it("an event published on one hub reaches a subscriber on another", …)
   → two hubs, one broker: the same topology as two pods, one Redis
```

The channel is also the authorization boundary: a socket not subscribed cannot receive another tenant's
events at all, rather than receiving them and being filtered. And access is **re-checked on delivery**
for membership events, so a removed member is cut off mid-session:

```
it("a removed member stops receiving events immediately", …)
```

Only membership events trigger the check — re-checking on every event would be a query per event per
socket. A *demotion* keeps the subscription, because it narrows what you may do, not what you may see.

Events publish **after the commit and only on a 2xx**. Publishing inside the transaction would announce
a change a rollback undoes; publishing before the status is known would announce one an error means
never happened. The trade-off runs the other way on purpose: a crash between commit and publish loses
the notification, because a stale screen is better than a client showing data that never existed.

→ [docs/realtime.md](docs/realtime.md)

### Auth, including what is wrong with it

scrypt at OWASP's parameters, with the parameters stored in the hash so they can be raised later and
upgraded at login when the plaintext is briefly available. Login gives one message for a wrong password
and an unknown address — **and hashes anyway when the address is unknown**, because identical wording
with different timing still answers the question.

Refresh tokens are opaque, stored as SHA-256, and rotated on every use. Reuse revokes the whole family,
which turns a stolen refresh token from indefinite access into one extra request.

**That was a bug before it was a feature.** The first implementation validated the token in one
transaction and marked it used in a second, so the `for update` lock was released at the first commit
and two concurrent refreshes both succeeded — precisely the case reuse detection exists to catch. The
test that found it:

```
it("only one of two simultaneous refreshes of the same token succeeds", …)
```

Logout is immediate: the refresh family is revoked *and* the access token's `jti` goes on a Redis
denylist with a TTL of its remaining life, so the denylist is bounded by logouts per token lifetime
rather than by total sessions.

**The honest weakness:** the refresh token is in `localStorage`, readable by any script on the origin.
The right answer is an httpOnly cookie, which needs the API and client on the same site or a
cookie-issuing proxy — a deployment decision, and this repository deliberately puts them on separate
hostnames so an XSS in the client does not inherit the API's origin. Stated rather than hidden;
[docs/auth.md](docs/auth.md) has the reasoning and the migration.

---

## Bugs my own tests found

Worth listing, because they are the argument for writing the tests this way.

1. **Refresh-token reuse detection did not work.** Check and mark were in separate transactions, so
   the row lock was released in between. Two concurrent refreshes both succeeded. Fixed by doing
   validation, marking used and inserting the successor in one transaction.
2. **A GraphQL field error wiped the entire response.** Top-level query fields were non-null, and
   GraphQL propagates an error to the nearest nullable ancestor — so `{ me { id } workspace(id: …) }`
   from a non-member returned `data: null`, discarding `me`, which had resolved fine. Query fields are
   now nullable; mutations stay non-null, because a mutation has no partial success to preserve.
3. **The runtime-config script could be closed early.** `JSON.stringify` twice escapes quotes but not
   `</script>` — an HTML parser does not understand JavaScript strings. A configuration value could
   terminate the tag and open a new one. Fixed by escaping `<` as `<` (plus U+2028/U+2029, which
   are legal in JSON and illegal in JavaScript).
4. **An unknown route answered 401 instead of 404.** The auth hook ran before routing, so every
   mistyped URL reported a rejected token. Unmatched routes now skip the requirement — while a *bad*
   token still fails, so a broken session stays distinguishable from a wrong URL. They also share one
   rate-limit bucket, so inventing URLs cannot hand out fresh budgets.
5. **Testing Library was not cleaning up.** `globals: false` meant no auto-registered `afterEach`, so
   every component test rendered on top of the previous one's DOM: 19 tests failed together and each
   passed alone.
6. **The load test's own config was rejected at startup.** It tried to set the rate limit to
   10,000,000, which exceeds the schema's cap — the boot-time validation caught its author.

---

## Measured locally

### Tests

| | Tests | Coverage (statements) |
| --- | --- | --- |
| `server` | **454** passing, 3 skipped | **88.5%** — **92.1%** excluding the two adapters that need a server |
| `web` | **96** passing | **91.6%** |

The 3 skipped are the `pg` and `redis` contract suites, which have no server to talk to on this
machine. They run in CI; **until that workflow has gone green, nothing about them is claimed here.**

Nothing is mocked. The only substitutions are the ones that make tests deterministic rather than easier
to pass: the in-memory key-value store (held to the Redis contract), a controllable clock, and lowered
scrypt parameters — with the real OWASP parameters verified once in their own test.

### Load test

```bash
npm run loadtest -- --concurrency 16 --duration 8
```

| | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| all operations | 15.24 ms | 17.93 ms | 22.83 ms | 27.47 ms |
| `GET /boards/:id/items` | 15.23 | 17.91 | 24.08 | 27.47 |
| `GET /items/:id` | 14.83 | 17.32 | 21.14 | 26.41 |
| `POST /boards/:id/items` | 15.27 | 18.14 | 25.44 | 27.47 |
| `POST /graphql` | 15.47 | 18.29 | 24.22 | 26.49 |
| `PATCH /items/:id` (contended) | 15.42 | 18.01 | 21.23 | 26.31 |

7,900 requests, **987 req/s**, 371 version conflicts on the contended path (correct — clients raced and
one was told to rebase), **0 unexpected 4xx, 0 5xx**.

**This is not a capacity claim.** Server, database and load generator all share one machine, with
PostgreSQL in-process, so the generator competes with the server for the same cores. What the numbers
do show is the *shape*: p50 ≈ mean ≈ 15 ms and p99 only 1.5× p50 — a distribution that flat, with 16
clients at ~990 req/s, says the single in-process database connection is serialising everything
(16 ÷ 0.0154 s ≈ 1,040 req/s, which is what was observed). **That bottleneck is the in-process engine,
not the application**, and it is exactly why the `pg` adapter with a connection pool exists.

The load test's real job is the last line of its output: it **exits non-zero on any 5xx or unexpected
4xx**, so it catches a deadlock, a pool exhaustion or a lock-ordering bug that appears only under
concurrency and that no unit test reaches. CI runs it against real Postgres and Redis for that reason,
not for the milliseconds.

---

## Layout

```
server/
  src/
    config.ts        env parsing with cross-field rules; exits 78 on a bad combination
    clock.ts         time as a dependency — nothing else calls Date.now()
    ids.ts           prefixed, time-sortable, opaque ids (ULID layout, no dependency)
    errors.ts        one taxonomy, mapped once per transport
    ports/           Database, KeyValue, Broker — thin, no query builder
    adapters/        pglite · pg · memory · redis
    db/schema.sql    constraints as constraints, not as code
    auth/            scrypt with stored parameters; JWT + rotation + reuse detection
    authz/policy.ts  the 88-cell matrix and the resource rules — the only authz logic
    domain/          accounts · workspaces · work · events
    http/            the pipeline, REST routes, GraphQL endpoint, rate limit, idempotency
    graphql/         schema and resolvers (which hold no authz)
    realtime/hub.ts  sockets, subscriptions, broker fan-out, delivery-time re-check
    bench/           a re-runnable load test that fails on any 5xx
web/
  src/lib/           api client · realtime client · runtime config · UI permissions
  src/components/    sign-in · workspace shell · board · connection badge
deploy/k8s/          manifests, with the reasoning in comments
docs/                architecture · authorization · auth · realtime · operations
```

- [docs/architecture.md](docs/architecture.md) — the shape, the ports, the four decisions worth the
  words, the pipeline in order.
- [docs/authorization.md](docs/authorization.md) — the full matrix, the resource rules, what the model
  does not do.
- [docs/auth.md](docs/auth.md) — scrypt vs argon2id, rotation, the `localStorage` trade-off.
- [docs/realtime.md](docs/realtime.md) — protocol, fan-out, reconnection with jitter.
- [docs/operations.md](docs/operations.md) — configuration, health endpoints, shutdown, the migration
  gap.

---

## Tests and checks

```bash
cd server && npm run typecheck && npm test      # 454 tests, ~20s
cd web    && npm run typecheck && npm test      # 96 tests, ~4s
cd web    && npm run build                      # next build type-checks the app router too
npm run loadtest
```

TypeScript is `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `noUnusedLocals` and
`noUnusedParameters`, in both packages. `exactOptionalPropertyTypes` in particular is load-bearing
here: it makes "set this to nothing" and "leave it alone" different types, which is the distinction a
PATCH handler must not blur.

CI runs both packages on Node 20 and 22, the contract suites against real Postgres and Redis, the load
test under concurrency, `kubeconform --strict` on the manifests, gitleaks, and a `docker compose up`
that registers a user and drives the whole write path — including asserting that the same idempotency
key twice creates one item, which only means something against real Redis.

---

## Limitations

Stated plainly, because they bound what this is.

- **Never deployed.** The Kubernetes manifests have not been applied to a cluster — no Kubernetes,
  `kubectl` or `kubeconform` was available here. Locally they are only checked to be valid YAML
  parsing into the kinds they claim; CI schema-validates them. `deploy/k8s/README.md` says so.
- **Docker not verified locally.** Docker is not installed on this machine. The Dockerfiles and
  compose file are exercised by CI only.
- **Migrations create, they do not alter.** `schema.sql` is idempotent and applied at startup, which
  is enough for one version and for local development. A second deployed version needs ordered,
  recorded migrations run as a job before the rollout — named as a gap in
  [docs/operations.md](docs/operations.md) rather than dressed up as a system.
- **No metrics or tracing.** Structured logs with request ids, no Prometheus endpoint, no
  OpenTelemetry.
- **The refresh token is in `localStorage`.** See above.
- **No MFA, no password reset, no email verification, no OAuth or SSO.** SAML and OIDC are explicitly
  not covered here.
- **No field-level permissions, no custom roles, no per-item sharing, no org tier above workspaces.**
  Each is a different shape, not a bigger matrix.
- **At-most-once event delivery, no history.** A disconnected client misses events and refetches.
- **Single writer, single region.** No read replicas, no multi-region story.
- **Postgres and Redis in `deploy/k8s` are evaluation setups** — single replica, no backups, no
  failover. Production means a managed service and two connection strings.

---

## License

MIT. See [LICENSE](LICENSE).
