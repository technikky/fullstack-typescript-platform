# Kubernetes manifests

Plain YAML, applied with `kubectl apply -k .`. No Helm chart, because a chart's value is
parameterising one deployment across many environments and there is one deployment here —
templating it would add indirection without removing any.

**These manifests have not been applied to a cluster.** No Kubernetes, `kubectl`, `kustomize` or
`kubeconform` was available on the machine this was developed on. Locally they have been checked for
one thing only: that every file is valid YAML and parses into the documents and kinds it claims to.
That is not schema validation, and it is certainly not an applied deployment.
`kubeconform --strict` runs in CI against the upstream Kubernetes JSON schemas, so once the workflow
has gone green the manifests are known to match the API shape. Until then, treat them as reviewed
intent: the manifests I would write, with the reasoning for each decision in the comments.
`kubectl apply --dry-run=server` against a real cluster remains the step that has not happened.

## What is here

| File | What it does |
| --- | --- |
| `kustomization.yaml` | Ties the rest together and sets a common label set. |
| `namespace.yaml` | One namespace, so a `kubectl delete namespace` is a complete teardown. |
| `configmap.yaml` | Non-secret configuration. |
| `secret.example.yaml` | The shape of the secret. **Not a real secret** — see below. |
| `postgres.yaml` | A single-replica StatefulSet, for evaluation only. |
| `redis.yaml` | A single-replica Deployment, for evaluation only. |
| `api.yaml` | The API: 3 replicas, probes, resources, a PodDisruptionBudget, an HPA. |
| `web.yaml` | The client: 2 replicas, probes, resources. |
| `ingress.yaml` | TLS termination and host routing. |
| `networkpolicy.yaml` | Default-deny, then only the flows that are needed. |

## Secrets

`secret.example.yaml` contains placeholder values and is committed so the *shape* is reviewable. The
real secret is never committed, in any form — base64 in a `Secret` is encoding, not encryption, and
`kubectl get secret -o yaml` prints it back in one command.

Create it out of band:

```bash
kubectl -n platform create secret generic platform-secrets \
  --from-literal=JWT_SECRET="$(openssl rand -base64 48)" \
  --from-literal=DATABASE_URL='postgres://platform:...@postgres:5432/platform' \
  --from-literal=POSTGRES_PASSWORD='...'
```

For anything beyond evaluation, use External Secrets Operator or Sealed Secrets so the source of
truth is a secret manager rather than a cluster object someone has to remember to rotate.

## Postgres and Redis are not production-ready here

They are single-replica, with no backups, no failover, no connection pooler and no tuning. That is
deliberate: running stateful infrastructure well on Kubernetes is its own discipline, and a
StatefulSet with one replica and a PVC is honest about being an evaluation setup rather than
pretending to be a database platform.

For production, use a managed Postgres (RDS, Cloud SQL, Neon) and a managed Redis (ElastiCache,
Memorystore, Upstash), and point `DATABASE_URL` and `REDIS_URL` at them. The application needs no
change: those are the only two connection strings it reads.

## Why the API needs Redis, not just a database

With more than one replica, the in-memory key-value adapter would give each pod its own state:

- **Rate limits** would be per pod, so three replicas make every limit three times as permissive as
  configured.
- **Token revocation** would be per pod, so logging out would revoke the access token on whichever
  pod served the request and leave it working on the other two.
- **WebSocket fan-out** would not cross pods, so a client connected to pod A would never see a
  change made on pod B.

`loadConfig` refuses to start in production without `REDIS_URL` for exactly these reasons.

## Reading order

Start with `api.yaml`. It carries the decisions worth reviewing: probe selection, the
`terminationGracePeriodSeconds` chosen to match the application's shutdown timeout, resource
requests set from the load test rather than guessed, and why the HPA targets CPU rather than
request rate.
