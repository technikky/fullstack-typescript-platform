import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Sequential files. Several suites boot an in-process PostgreSQL instance, and
    // running a dozen of those in parallel on a laptop is slower than running them
    // one at a time, not faster.
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // main.ts is the process entrypoint: it reads the environment, opens sockets
      // and installs signal handlers. Exercising it in-process would mean starting
      // and stopping a server per test for no coverage of anything but wiring that
      // `buildApp` already covers.
      exclude: ["src/main.ts", "src/bench/**"],
      reporter: ["text", "json-summary"],
    },
  },
});
