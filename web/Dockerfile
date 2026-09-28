# The Next.js client.
#
# Built with `output: "standalone"`, so the runtime stage needs no `node_modules` install at all:
# Next traces the modules the build actually reaches and copies just those into `.next/standalone`.
# The image is a fraction of the size of one carrying a full dependency tree.
#
# **No build-time API URL.** The usual pattern passes `NEXT_PUBLIC_API_URL` as a build argument,
# which inlines it into the bundle -- and then staging and production need separate builds of
# identical code, so the artefact promoted to production is not the one that was tested. Here the
# URL is read at runtime from `PLATFORM_API_URL` and injected by the layout, so one image runs
# everywhere.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci


FROM node:22-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json next.config.mjs ./
COPY src ./src
RUN npm run build


FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN useradd --uid 10001 --ingroup node --create-home --shell /usr/sbin/nologin web
WORKDIR /app

# `.next/standalone` carries its own minimal server and the traced dependencies. `static` and
# `public` are not traced -- they are served rather than imported -- so they are copied separately.
COPY --from=build --chown=web:node /app/.next/standalone ./
COPY --from=build --chown=web:node /app/.next/static ./.next/static

USER web
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
