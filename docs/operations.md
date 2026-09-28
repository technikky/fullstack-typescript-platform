# Operations

Running it, configuring it, and what is missing before it should carry real accounts.

## Running locally

Two modes, and the first needs nothing installed.

### Nothing installed

```bash
cd server && npm ci
JWT_SECRET="$(openssl rand -base64 48)" npm run dev
```

With no `DATABASE_URL`, the server runs PostgreSQL 17 compiled to WebAssembly in-process and an
in-memory key-value store. Real SQL, real schema, no container. The startup log names the adapters it
chose, and `/health` reports them — an accident is visible rather than silent.

```bash
cd web && npm ci && npm run dev   # http://localhost:3000
```

### The real stack

```bash
cp .env.example .env
# set JWT_SECRET; generate with: openssl rand -base64 48
docker compose up --build
```

Postgres 17, Redis 7, the API and the client. This is the configuration that exercises the `pg`
adapter over the wire protocol with a connection pool, and the `ioredis` adapter with its Lua
rate-limit script — the paths the offline suite cannot reach.

### Running the contract suites against real servers

The same suites that run against the in-process database and in-memory store also run against real
ones when pointed at them:

```bash
docker compose up -d postgres redis
cd server
TEST_DATABASE_URL=postgres://platform:platform-local-only@localhost:5432/platform \
TEST_REDIS_URL=redis://localhost:6379 \
npm test
```

Without those variables the `pg` and `redis` suites **skip with a printed reason** rather than passing
quietly. CI sets both, so those suites always run there — and if a service container failed to come up,
they fail on connection rather than skipping, because a suite that silently covered less than it
appears to is worse than a red one.

## Configuration

Everything is validated at startup by `loadConfig`. A misconfigured process exits **78** (`EX_CONFIG`)
with every problem listed, so an orchestrator can distinguish it from a crash.

| Variable | Default | Notes |
| --- | --- | --- |
| `JWT_SECRET` | **none** | ≥ 32 chars. Deliberately no default — see below |
| `NODE_ENV` | `development` | `production` turns on the cross-field rules |
| `PORT` / `HOST` | `4000` / `0.0.0.0` | |
| `DATABASE_URL` | in-process | **required in production** |
| `REDIS_URL` | in-memory | **required in production** |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `fullstack-typescript-platform` / `platform-api` | |
| `ACCESS_TOKEN_TTL_SECONDS` | `600` | must be shorter than the refresh TTL |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` | 30 days |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | |
| `RATE_LIMIT_MAX_REQUESTS` | `300` | per IP and per user |
| `AUTH_RATE_LIMIT_MAX_REQUESTS` | `10` | the credential-stuffing surface |
| `CORS_ORIGINS` | `http://localhost:3000` | comma-separated; no wildcard default |
| `ALLOW_LOCALHOST_CORS` | `false` | permits a localhost origin while `NODE_ENV=production` |
| `BODY_LIMIT_BYTES` | `262144` | |
| `LOG_LEVEL` | `info` | |

### Why `JWT_SECRET` has no default

A development fallback secret is the single most common way a production service ends up signing
tokens with a value that is in a public repository — and once one deployment has it, rotating is a
coordinated outage. The process refuses to start without one.

### The production cross-field rules

Each describes a combination that is individually valid and jointly wrong:

- **`DATABASE_URL` is required.** The in-process database is not durable. Discovering that from a
  support ticket after a restart is not acceptable.
- **`REDIS_URL` is required.** The in-memory store is per-process. With three replicas: rate limits
  become three times as permissive as configured, a logout revokes the access token on one replica and
  leaves it working on the other two, and WebSocket events do not cross pods.
- **`CORS_ORIGINS` must not contain localhost**, unless `ALLOW_LOCALHOST_CORS=true`. A development
  allow list that reaches production is a real hole -- but "production mode" and "reachable from the
  internet" are not the same thing, and the process cannot tell them apart. The `docker compose`
  stack runs the production build for a browser on the host and sets the flag for exactly that
  reason. Setting it is a visible choice in a diff; forgetting to change a default is not.

## Health endpoints

Two, because Kubernetes asks two different questions.

| Endpoint | Question | On failure |
| --- | --- | --- |
| `/health` | Is the process alive? | Restart the pod |
| `/ready` | Can it serve traffic? | Take it out of the load balancer |

`/ready` checks the database and the key-value store. **Do not point liveness at it.** A brief
database blip would then restart every replica at once — turning a recoverable dependency outage into
a total one, and restarting pods that were not broken.

`/health` also reports which adapters are in use, which is how a fallback that should not have
happened becomes visible.

## Graceful shutdown

On `SIGTERM`: Fastify stops accepting connections and finishes in-flight requests, then sockets and
pools close. A 15-second backstop exits anyway, because a handler stuck forever must not prevent the
pod from terminating — the orchestrator will SIGKILL it, which is strictly worse.

Two pieces have to agree for a deploy to drop zero requests:

1. `terminationGracePeriodSeconds: 30` in the manifest, longer than the application's own backstop
   plus the pre-stop delay.
2. A `preStop` sleep of 5 seconds. Endpoint removal propagates to kube-proxy and the ingress
   asynchronously, so a pod can still receive connections for a moment after it starts terminating.
   Sleeping *before* the process sees SIGTERM is what closes that window.

## Load testing

```bash
npm run loadtest -- --concurrency 24 --duration 15
```

Reports per-operation p50/p95/p99, throughput, and — separately — expected version conflicts versus
real errors. It **exits non-zero on any 5xx or unexpected 4xx**, which is the part worth having in CI:
it catches a deadlock, a pool exhaustion or a lock-ordering bug that only appears under concurrency and
that no unit test reaches.

It is not a capacity benchmark. Server, database and generator share one machine, so the number
characterises the code path, not a deployment. See the README for what it measured locally and the
bottleneck that measurement revealed.

## Kubernetes

`deploy/k8s/` holds plain manifests, applied with `kubectl apply -k deploy/k8s`.

**They have never been applied to a cluster.** No Kubernetes tooling was available on the development
machine. Locally they are only checked to be valid YAML parsing into the kinds they claim;
`kubeconform --strict` validates them against the upstream schemas in CI. `deploy/k8s/README.md` states
this plainly, and `kubectl apply --dry-run=server` is the step that has not happened.

Postgres and Redis there are single-replica evaluation setups with no backups and no failover. For
production, use a managed Postgres and a managed Redis and point the two connection strings at them —
those are the only coupling the application has.

## Schema migrations: the honest gap

`schema.sql` is written with `if not exists` throughout and applied on startup, so the same file serves
a fresh database and an existing one. That is enough at this stage and it has a clear limit: **it
creates, it does not alter.** There is no version table, no ordering, no down path.

Before a second deployed version, this needs a real migration tool. What that means concretely:

- Ordered, recorded migrations with a version table.
- Expand-then-contract for anything destructive, because a rolling deploy runs two application
  versions against one schema.
- Migrations run as a job before the rollout, not from the application's startup path — otherwise N
  replicas race to apply the same DDL.

The startup application is fine for one version and for local development. It is named here as a gap
rather than presented as a migration system.

## Operational gaps

Stated because they bound what "production-ready" would mean.

- **No metrics or tracing.** No Prometheus endpoint, no OpenTelemetry. Structured logs with request
  ids exist; a dashboard does not.
- **No migration tooling.** Above.
- **No backups.** Managed Postgres would provide them; the manifests here do not.
- **No secret rotation.** Rotating `JWT_SECRET` currently invalidates every session, because
  verification accepts one key. Accepting a previous key during a rotation window is the fix.
- **No log redaction.** Request bodies are not logged, but nothing enforces that a future handler
  cannot log one.
- **No CSRF defence beyond the token model.** Sufficient while the token is in a header; moving to
  cookie sessions requires adding it.
- **Single region, single writer.** No read replicas and no multi-region story.
