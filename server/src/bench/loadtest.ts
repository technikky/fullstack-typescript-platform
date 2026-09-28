/**
 * A load test that measures this application, on this machine.
 *
 * **What this is not.** It is not a capacity claim. It runs the server, the database and the load
 * generator on one machine, with no network between them and, by default, with PostgreSQL compiled
 * to WebAssembly in the same process. "N requests per second" from that arrangement says something
 * about the code path and nothing about what a deployment would sustain -- the generator is
 * competing with the server for the same cores, and the database is not where a real one would be.
 *
 * **What it is for.** Three things it does measure honestly:
 *
 * - The *shape* of the latency distribution. p99 far above p50 points at lock contention or a
 *   missing index, and that shows up here.
 * - Regressions. Run it before and after a change; the numbers are comparable to each other
 *   because everything else is identical.
 * - Correctness under concurrency. Every response is checked, so a request that fails under load --
 *   a version conflict, a rate limit, a deadlock -- is counted rather than silently ignored. A load
 *   test that only reports latency will happily report excellent numbers for a server returning
 *   500s.
 *
 * Point `DATABASE_URL` and `REDIS_URL` at real servers for a more meaningful run, and run the
 * generator from a different machine for a number worth quoting. The README reports what this
 * produced locally and says so.
 *
 *   npx tsx src/bench/loadtest.ts --concurrency 32 --duration 10
 */

import { performance } from "node:perf_hooks";

import { loadConfig } from "../config.js";
import { buildContainer } from "../container.js";
import { buildApp } from "../http/app.js";
import { EventBuffer } from "../domain/events.js";
import { hashPassword } from "../auth/password.js";
import { newId } from "../ids.js";

interface Options {
  readonly concurrency: number;
  readonly durationSeconds: number;
  readonly warmupSeconds: number;
  readonly users: number;
}

const parseArgs = (argv: readonly string[]): Options => {
  const value = (flag: string, fallback: number): number => {
    const index = argv.indexOf(flag);
    if (index < 0) return fallback;
    const parsed = Number(argv[index + 1]);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${flag} needs a positive number`);
    }
    return parsed;
  };
  return {
    concurrency: Math.trunc(value("--concurrency", 16)),
    durationSeconds: value("--duration", 10),
    warmupSeconds: value("--warmup", 2),
    users: Math.trunc(value("--users", 8)),
  };
};

interface Sample {
  readonly operation: string;
  readonly millis: number;
  readonly status: number;
}

const percentile = (sorted: readonly number[], fraction: number): number => {
  if (sorted.length === 0) return 0;
  // Nearest-rank on a sorted array. Interpolating would invent a latency nobody observed.
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank]!;
};

const summarise = (label: string, samples: readonly Sample[]): string => {
  if (samples.length === 0) return `${label.padEnd(22)} no samples`;
  const sorted = samples.map((sample) => sample.millis).sort((left, right) => left - right);
  // 409 is reported separately from `err`. On the contended update path it is the *correct*
  // answer -- two clients raced and one was told to rebase -- so counting it as a failure would
  // make a working optimistic-concurrency implementation look broken.
  const conflicts = samples.filter((sample) => sample.status === 409).length;
  const errors = samples.filter((sample) => sample.status >= 400 && sample.status !== 409).length;
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  return [
    label.padEnd(22),
    `n=${String(samples.length).padStart(6)}`,
    `409=${String(conflicts).padStart(4)}`,
    `err=${String(errors).padStart(4)}`,
    `mean=${mean.toFixed(2).padStart(7)}ms`,
    `p50=${percentile(sorted, 0.5).toFixed(2).padStart(7)}ms`,
    `p95=${percentile(sorted, 0.95).toFixed(2).padStart(7)}ms`,
    `p99=${percentile(sorted, 0.99).toFixed(2).padStart(7)}ms`,
    `max=${(sorted[sorted.length - 1] ?? 0).toFixed(2).padStart(7)}ms`,
  ].join("  ");
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));

  // A load test must not be shaped by the rate limiter, which would otherwise be what is being
  // measured. The limiter has its own tests.
  const config = loadConfig({
    ...process.env,
    JWT_SECRET: process.env["JWT_SECRET"] ?? "a-load-test-secret-that-is-long-enough-here",
    // The configured ceilings, not an arbitrary large number: the schema caps these, and it
    // caught the first attempt at this line.
    RATE_LIMIT_MAX_REQUESTS: "100000",
    AUTH_RATE_LIMIT_MAX_REQUESTS: "10000",
    LOG_LEVEL: "silent",
    NODE_ENV: "development",
  });

  const container = await buildContainer({ config });
  const app = await buildApp({ container, logger: false });
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });

  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no port bound");
  const base = `http://127.0.0.1:${address.port}`;

  process.stdout.write(
    [
      "load test",
      `  adapters      : ${JSON.stringify(container.adapters)}`,
      `  concurrency   : ${options.concurrency}`,
      `  duration      : ${options.durationSeconds}s (after ${options.warmupSeconds}s warmup)`,
      `  users         : ${options.users}`,
      "",
      "  Server, database and generator all on this machine. These numbers characterise the",
      "  code path, not a deployment's capacity.",
      "",
    ].join("\n"),
  );

  // --- fixtures ---------------------------------------------------------------------

  // Created directly rather than through the API: the point is to measure the read and write paths
  // under load, not the cost of registering users at full scrypt cost.
  const password = await hashPassword("a-load-test-password-value", { N: 1024, r: 8, p: 1, keylen: 32 });
  const actors: Array<{ token: string; boardId: string; itemId: string; version: number }> = [];

  for (let index = 0; index < options.users; index += 1) {
    const userId = newId("user");
    await container.database.query(
      `insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)`,
      [userId, `load-${index}-${userId}@example.test`, `Load ${index}`, password],
    );
    const view = await container.workspaces.create(userId, `Load workspace ${index}`);
    const events = new EventBuffer();
    const board = await container.work.createBoard(view.workspace.id, userId, "Board", events);
    // Some existing items, so reads are not all against an empty table.
    for (let seed = 0; seed < 20; seed += 1) {
      await container.work.createItem(board.id, userId, { title: `Seed ${seed}` }, events);
    }
    events.drain();
    const item = await container.work.createItem(board.id, userId, { title: "Hot item" }, new EventBuffer());
    const tokens = await container.tokens.issue(userId);
    actors.push({ token: tokens.accessToken, boardId: board.id, itemId: item.id, version: item.version });
  }

  // --- workload ---------------------------------------------------------------------

  const samples: Sample[] = [];
  let recording = false;
  let stop = false;

  const timed = async (
    operation: string,
    run: () => Promise<Response>,
  ): Promise<Response> => {
    const started = performance.now();
    const response = await run();
    // Bodies are read even when discarded: leaving them unread lets the client return before the
    // server has finished writing, which measures the wrong thing.
    await response.arrayBuffer();
    if (recording) {
      samples.push({ operation, millis: performance.now() - started, status: response.status });
    }
    return response;
  };

  /**
   * One virtual client, looping until told to stop.
   *
   * The mix is roughly what a board UI produces: mostly reads, a steady trickle of writes, and one
   * contended update path where several clients fight over the same row -- which is the case worth
   * measuring, because it is where the version check and the row lock actually bite.
   */
  const client = async (index: number): Promise<void> => {
    const actor = actors[index % actors.length]!;
    const auth = { authorization: `Bearer ${actor.token}`, "content-type": "application/json" };
    let localVersion = actor.version;

    while (!stop) {
      const roll = Math.random();

      if (roll < 0.45) {
        await timed("GET /boards/:id/items", () =>
          fetch(`${base}/api/boards/${actor.boardId}/items?limit=20`, { headers: auth }),
        );
      } else if (roll < 0.6) {
        await timed("GET /items/:id", () =>
          fetch(`${base}/api/items/${actor.itemId}`, { headers: auth }),
        );
      } else if (roll < 0.7) {
        await timed("POST /graphql", () =>
          fetch(`${base}/graphql`, {
            method: "POST",
            headers: auth,
            body: JSON.stringify({
              query: "query ($b: String!) { items(boardId: $b, limit: 20) { items { id title } } }",
              variables: { b: actor.boardId },
            }),
          }),
        );
      } else if (roll < 0.85) {
        await timed("POST /boards/:id/items", () =>
          fetch(`${base}/api/boards/${actor.boardId}/items`, {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ title: `Created ${Date.now()}` }),
          }),
        );
      } else {
        // The contended path. A 409 here is the correct answer, not a failure of the server, so it
        // is counted separately below.
        const response = await timed("PATCH /items/:id", () =>
          fetch(`${base}/api/items/${actor.itemId}`, {
            method: "PATCH",
            headers: auth,
            body: JSON.stringify({ expectedVersion: localVersion, title: `Updated ${Date.now()}` }),
          }),
        );
        if (response.status === 409) {
          // Rebase, exactly as a real client would.
          const current = await fetch(`${base}/api/items/${actor.itemId}`, { headers: auth });
          const body = (await current.json()) as { item?: { version?: number } };
          localVersion = body.item?.version ?? localVersion + 1;
        } else {
          localVersion += 1;
        }
      }
    }
  };

  const clients = Array.from({ length: options.concurrency }, (_value, index) => client(index));

  // Warm up before recording: the first request through each path pays for JIT, connection setup
  // and query planning, and including that would put a spike in every percentile.
  await new Promise((resolve) => setTimeout(resolve, options.warmupSeconds * 1000));
  recording = true;
  const startedAt = performance.now();
  await new Promise((resolve) => setTimeout(resolve, options.durationSeconds * 1000));
  recording = false;
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  stop = true;
  await Promise.all(clients);

  // --- report -----------------------------------------------------------------------

  const byOperation = new Map<string, Sample[]>();
  for (const sample of samples) {
    const bucket = byOperation.get(sample.operation) ?? [];
    bucket.push(sample);
    byOperation.set(sample.operation, bucket);
  }

  process.stdout.write(`${summarise("ALL", samples)}\n`);
  for (const operation of [...byOperation.keys()].sort()) {
    process.stdout.write(`${summarise(operation, byOperation.get(operation)!)}\n`);
  }

  const versionConflicts = samples.filter((sample) => sample.status === 409).length;
  const serverErrors = samples.filter((sample) => sample.status >= 500).length;
  const otherFailures = samples.filter(
    (sample) => sample.status >= 400 && sample.status !== 409 && sample.status < 500,
  ).length;

  process.stdout.write(
    [
      "",
      `requests          : ${samples.length}`,
      `throughput        : ${(samples.length / elapsedSeconds).toFixed(1)} req/s over ${elapsedSeconds.toFixed(1)}s`,
      `version conflicts : ${versionConflicts} (expected: concurrent clients contend for one row)`,
      `4xx (other)       : ${otherFailures}`,
      `5xx               : ${serverErrors}`,
      "",
    ].join("\n"),
  );

  await app.close();
  await container.close();

  // A 5xx under load is a defect, so the process exits non-zero and CI notices.
  if (serverErrors > 0) {
    process.stderr.write(`FAILED: ${serverErrors} server errors under load\n`);
    process.exitCode = 1;
  }
  if (otherFailures > 0) {
    process.stderr.write(`FAILED: ${otherFailures} unexpected 4xx responses under load\n`);
    process.exitCode = 1;
  }
};

void main();
