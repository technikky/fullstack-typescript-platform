# The API server.
#
# Three stages, each earning its place:
#
#   deps   — `npm ci` against the lockfile only. This layer is invalidated by a dependency change
#            and by nothing else, so editing source code does not reinstall node_modules.
#   build  — TypeScript to JavaScript, then a production-only install so the runtime stage carries
#            no compiler and no test framework.
#   runtime— distroless-style: a slim base, a non-root user, and only what the process needs.
#
# `npm ci` rather than `npm install`: it fails when the lockfile and the manifest disagree, which is
# exactly what you want in a build. `npm install` would quietly resolve a different tree than the one
# that was tested.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci


FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig*.json ./
COPY src ./src
RUN npm run build

# A second, production-only tree. `--omit=dev` here rather than pruning the existing one, because
# pruning leaves the dev packages' files behind in the layer even after they are removed.
RUN npm ci --omit=dev


FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    # Fastify binds this by default; stated explicitly so it is visible in `docker inspect`.
    HOST=0.0.0.0 \
    PORT=4000

# `--gid node` reuses the base image's existing unprivileged group rather than creating a second
# one. Running as root in a container is not isolation: a container escape starts as root on the
# host's kernel namespace.
#
# `--gid`, not `--ingroup`: the latter is Debian `adduser`'s option and `useradd` rejects it with
# exit 2 and a usage dump. Both images failed to build on that until CI ran them, because Docker
# is not installed on the machine this was written on.
RUN useradd --uid 10001 --gid node --create-home --shell /usr/sbin/nologin platform

WORKDIR /app
COPY --from=build --chown=platform:node /app/node_modules ./node_modules
COPY --from=build --chown=platform:node /app/dist ./dist
COPY --chown=platform:node package.json ./
# The schema is read at runtime, so it has to be in the image. It lives beside the compiled
# `migrate.js`, which resolves it relative to its own location.
COPY --from=build --chown=platform:node /app/src/db/schema.sql ./dist/db/schema.sql

USER platform
EXPOSE 4000

# Readiness, not liveness: Docker's healthcheck decides whether to route traffic, and `/ready`
# checks the database and key-value store. Pointing it at `/health` would report healthy while the
# database was unreachable.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `node` directly, not `npm start`. npm forwards signals poorly, so SIGTERM would not reach the
# process and every deploy would wait out the grace period before being killed -- dropping the
# in-flight requests the graceful shutdown exists to drain.
CMD ["node", "dist/main.js"]
