# Fabulist — single-process Node app, SQLite files under /data.
#
# No native deps, no build step for the backend (Node 24 runs .ts directly —
# see PLAN.md's stack decisions), so the only real build work is the web UI.
# Pinned to the exact Node major this project develops against (README's
# Providers section and package.json's engines both assume 24) rather than
# `-alpine`, because `node:sqlite` and native TLS behaviour are exactly the
# kind of thing worth not second-guessing against a smaller libc.

FROM node:24-slim AS build
WORKDIR /app

# Install first, from the lockfile alone, so an app-code-only change doesn't
# invalidate this layer.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build:web

# ---------------------------------------------------------------------------

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --prod: the web UI is already built to static files in the stage above, so
# vite/react/the dev toolchain have no reason to exist in the shipped image.
RUN pnpm install --frozen-lockfile --prod

COPY src ./src
COPY tsconfig.json ./
COPY --from=build /app/web/dist ./web/dist
COPY fabulist.config.json ./

# Data lives here: generated images, and any SQLite world still awaiting import.
# Never `cp` it while a container is running — WAL mode splits an open database
# across .db/-wal/-shm (see the README's "Copying a save" section).
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Runs unprivileged.
#
# The image had no `USER`, so it ran as root — Docker's default for the node
# images, and unnecessary here: the process needs to write `/data` (images, and
# the `*.pre-pg` renames the importer performs) and bind one port, neither of
# which requires root. `node` is uid 1000, already present in the base image.
#
# A bind-mounted `/data` from an older release is owned by root, and this user
# cannot write it — so `deploy.sh` chowns that directory to 1000:1000 when it
# finds it root-owned. Without that step an upgrade would silently fail to save
# images and fail to rename imported worlds, which is why the two changes ship
# together.
USER node

EXPOSE 4317
ENV PORT=4317

# 0.0.0.0, not the app's own 127.0.0.1 default: serve.ts binds loopback-only
# for the local, single-user case that's right on a laptop and wrong inside a
# container, where "loopback" is the container's own network namespace and
# nothing outside it — including Docker's own port mapping — can reach it.
# The flag below overrides the bind host without touching serve.ts's default
# for the non-Docker path.
# --data-root=/data alongside --config=/data/fabulist.config.json: both must
# point inside the mounted volume. Canon and stories live in Postgres now, but
# `--data-root` still matters for two things that stay on disk — generated image
# bytes, and any SQLite `world.db` waiting to be imported on first boot. Both
# would vanish the moment `docker compose up -d` recreates the container if this
# pointed at the writable layer (see serve-pg.ts's own comment).
#
# `serve-pg.ts`, not `serve.ts`: Postgres is the default now. `FABULIST_PG` (or
# `DATABASE_URL`) must be set — see deploy/docker-compose.yml.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/cli/serve-pg.ts", "--host=0.0.0.0", "--config=/data/fabulist.config.json", "--data-root=/data"]
