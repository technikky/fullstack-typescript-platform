/**
 * The process entrypoint: configuration, wiring, listening, and shutting down cleanly.
 *
 * Nothing here is business logic. It exists because the boring parts of running a service are
 * where outages come from:
 *
 * **Configuration is validated before anything opens.** A missing `JWT_SECRET` stops the process
 * with a message naming the variable, instead of surfacing as a signing failure on the first
 * login after the deploy looked green.
 *
 * **Shutdown drains rather than drops.** On SIGTERM, Fastify stops accepting connections and
 * finishes the requests already in flight, then sockets and pools close. A process that exits
 * immediately returns 502s to requests that were already committed. The timeout is the backstop:
 * a handler stuck forever must not stop the pod from terminating, because Kubernetes will
 * SIGKILL it anyway and that is strictly worse.
 *
 * **The WebSocket upgrade shares the HTTP server.** One port, one certificate, one ingress rule.
 */

import { WebSocketServer } from "ws";

import { ConfigError, loadConfig } from "./config.js";
import { buildContainer } from "./container.js";
import { buildApp } from "./http/app.js";
import { asSocket } from "./realtime/hub.js";

const SHUTDOWN_TIMEOUT_MILLIS = 15_000;

const main = async (): Promise<void> => {
  let config;
  try {
    config = loadConfig();
  } catch (thrown) {
    if (thrown instanceof ConfigError) {
      process.stderr.write(`${thrown.message}\n`);
      process.exit(78); // EX_CONFIG, so an orchestrator can tell this from a crash.
    }
    throw thrown;
  }

  const container = await buildContainer({ config });
  const app = await buildApp({ container });
  await app.ready();

  // Fastify's own server is reused rather than a second one created, so HTTP and WebSocket
  // share a port. `noServer` means `ws` does not bind anything itself; the upgrade is routed
  // here.
  const httpServer = app.server;
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== "/ws") {
      // An upgrade to an unknown path gets a clean HTTP response, not a dangling socket.
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (socket_) => {
      // The token arrives in the first message, not the query string: a URL with a credential in
      // it ends up in access logs, proxy logs and browser history.
      container.hub.accept(asSocket(socket_));
    });
  });

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { adapters: container.adapters, nodeEnv: config.nodeEnv },
    "platform listening; websocket upgrade on /ws",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");

    const timer = setTimeout(() => {
      app.log.error("shutdown timed out; exiting anyway");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MILLIS);
    timer.unref();

    try {
      // Order matters: stop taking new work, then close what is open, then release resources.
      await app.close();
      wss.close();
      await container.close();
      clearTimeout(timer);
      process.exit(0);
    } catch (thrown) {
      app.log.error({ err: thrown }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // An unhandled rejection has left some invariant unverified; continuing on a process in an
  // unknown state is worse than restarting. Logged first so the reason survives.
  process.on("unhandledRejection", (reason) => {
    app.log.fatal({ err: reason }, "unhandled rejection");
    void shutdown("unhandledRejection");
  });
  process.on("uncaughtException", (error) => {
    app.log.fatal({ err: error }, "uncaught exception");
    void shutdown("uncaughtException");
  });
};

void main();
