# Deploying fabulist to the VPS

Scope of this deployment (see the conversation that produced it): the app has
**zero built-in request authentication** on its REST routes (`src/server/api.ts`'s
~60 routes all trust whoever can reach them). `/mcp` is different — it has its
own bearer-token check (`src/mcp/auth.ts`, OAuth via WorkOS AuthKit) and is not
mounted at all unless that's configured. **Reverse proxy / TLS / access
control on the VPS is configured directly by the operator, outside this repo**
— `nginx/fabulist.conf` here is a reference copy, not necessarily what's
currently live; nothing in this repo or its CI touches the VPS's nginx/openresty
config.

**Reverse proxy: openresty**, already running on the VPS for other sites.

**TLS: a `*.rast.io` wildcard cert via DNS-01** (HTTP-01 cannot issue
wildcards at all — an ACME/CA-level rule). Issued with `certbot-dns-websupport`
against Websupport's DNS API, in a dedicated venv at `/opt/certbot-venv` kept
separate from the box's apt certbot (2.9.0 — too old for this plugin, and
mixing pip into the apt install breaks). Renews unattended via its own
`/etc/cron.d/certbot` entry.

## What's here

| File | Purpose |
|---|---|
| `docker-compose.yml` | The one service, pinned to `ra100/fabulist:latest`, `/data` as a bind mount to an ordinary directory on the VPS's own disk (`scp`/`rsync`/`ls` work on it directly, no `docker cp` needed) — defaults to `./fabulist-data` next to this file, override with `FABULIST_DATA_DIR` if you want it elsewhere; deliberately relative so this repo never discloses the operator's real host layout — `app.env` as an optional (`required: false`) env file |
| `nginx/fabulist.conf` | Reference openresty/nginx server block — **not necessarily the live config**; the operator manages that directly |
| `vps-setup.sh` | One-time: installs Docker, copies the compose file + `deploy.sh`, starts the app. Does **not** touch openresty or certbot |
| `deploy.sh` | Runs on the VPS, invoked over SSH with a real argument (`deploy/deploy.sh upload-env` / `deploy/deploy.sh deploy`) — **not** an `authorized_keys` forced command (see "Known gaps" below for why, and the security tradeoff that follows from it) |

## Already done (as of this doc)

- [x] `*.rast.io` wildcard cert, renewing unattended.
- [x] SSH deploy key generated; `SSH_PRIVATE_KEY` secret and
      `SSH_DOMAIN`/`SSH_PORT`/`SSH_USER` repo variables set.
- [x] `MCP_OAUTH_ISSUER`, `MCP_OAUTH_AUDIENCE`, `MCP_RESOURCE_URL` set as repo
      variables (`https://fastidious-attic-52.authkit.app`,
      `client_01M1YFPQ054SZ2DD5HFTB22MK1`, `https://fabulist.rast.io/mcp` —
      the same values verified end-to-end in `.design/MCP-CONNECTOR.md`).
      `WORKOS_API_KEY` stays a secret and is **not** part of this pipeline —
      the running server never needs it, only the three values above
      (`src/mcp/auth.ts`'s OAuth mode verifies tokens against the issuer's
      published JWKS; it never calls WorkOS's management API).
- [x] `release.yml`'s `deploy` job now renders those three as `app.env` and
      runs `upload-env` before `deploy` on every tag push — see
      "Continuous deployment" below.

## What's left to actually make it run

Nothing for a fresh box — `git tag vX.Y.Z && git push --tags` builds+pushes the
Docker image, uploads the rendered `app.env`, and redeploys, end to end.

**One-time, manual, on the existing VPS only**: this deployment originally used a
named Docker volume (`fabulist-data`) instead of the bind mount above. If that
volume already has real world data in it, moving to the bind mount needs one
manual copy before the next `docker compose up -d`, done once, with the container
stopped so nothing is mid-write. Run this from `$DEPLOY_PATH` (wherever
`docker-compose.yml` actually lives on that box), substituting your own
`FABULIST_DATA_DIR` if you set one:

```bash
ssh -p 25 <your-user>@<your-host>
cd <deploy-path>   # wherever this compose file's copy actually lives
docker compose down
target="${FABULIST_DATA_DIR:-./fabulist-data}"
mkdir -p "$target"
docker run --rm \
  -v fabulist-data:/from \
  -v "$(realpath "$target")":/to \
  alpine sh -c 'cp -a /from/. /to/.'
docker compose up -d
# once "$target" looks right (worlds/, fabulist.config.json):
docker volume rm fabulist-data
```

A fresh VPS that has never run the old compose file needs none of this — the
bind-mount directory is created automatically on first `docker compose up -d`.

## Postgres

The engine runs on one Postgres database rather than a SQLite file per world.
`pnpm serve` starts it; `pnpm serve-sqlite` is the previous path, kept for one
release.

    FABULIST_PG=postgres://user:pass@host:5432/fabulist pnpm serve

`DATABASE_URL` works too. `deploy/pg-dev.sh` runs a local server for development
(`pnpm pg:start`, port 5433) with `max_connections=300`.

### Which Postgres

Two modes, one compose file:

    docker compose up -d                     # your own Postgres, via FABULIST_PG
    docker compose --profile bundled up -d   # a Postgres container, created for you

**Nothing needs configuring.** `deploy.sh` prepares the database itself, so a release
lands without anyone touching the box:

- **No `FABULIST_PG`** → runs the bundled Postgres, generating a password on first
  deploy and keeping it in `.env` (never uploaded, so CI's `app.env` rewrite cannot
  destroy it). This is the default because it is the shape that works with no
  decisions made.
- **`FABULIST_PG` set** → uses that Postgres and leaves the bundled service off.

It also creates the bind-mount directories and reports how many SQLite worlds the app
will import on this boot. Verified end to end on a fresh directory carrying a real
`world.db`: password generated, Postgres started, `imported saint-verrow: 22 canon
entities, 37 edges, 1 story`, serving — one command, no preparation. A second deploy
re-imports nothing and rotates nothing.

Setting `POSTGRES_PASSWORD` in `app.env` before the *first* deploy uses that value
instead of a generated one. Setting it afterwards is deliberately **ignored, with an
explanation**: it cannot change an existing database (see the warning below), so
applying it would only lock the app out.

Bundled is a reasonable deployment choice, not only a convenience: 20 MB idle, ~32 MB
with the app's pools open, and the database's lifecycle stays tied to the app's.

`deploy.sh` sets `COMPOSE_PROFILES=bundled` on its own when `FABULIST_PG` is unset, so
this is only worth knowing if you set it by hand. It has to reach the *client's*
environment, not just the container's:
`env_file:` is read by the container at start, while profile selection and `${...}`
substitution are done by the `docker compose` client from its own environment and
`.env`. `deploy.sh` therefore sources `app.env` before invoking compose, so one file
stays the single place to configure. Without that the profile selects nothing, the
database never starts, and the app reports it cannot reach one — quiet rather than
loud, which is why `deploy.sh` now prints the active profiles.

⚠️ **`POSTGRES_PASSWORD` only applies when the data directory is first created.**
Changing it later leaves the database on the old password and the app on the new one,
which surfaces as a bare `password authentication failed`. `serve-pg` detects that
case and prints the fix; it is:

    docker compose exec postgres psql -U fabulist -c "ALTER USER fabulist PASSWORD '…'"

**Your data is on the host disk, not in a Docker volume.** Both `/data` and the
database directory are bind mounts (`./fabulist-data` and `./fabulist-pg` next to the
compose file, overridable with `FABULIST_DATA_DIR`/`FABULIST_PG_DIR`). That is what
makes `docker compose down -v` survivable: `-v` removes named volumes, and a bind
mount is not one. Verified directly — 48 MB of real data, then `down -v`, then
`docker rm -f` of the container, and the prose was still there. `docker volume ls`
shows nothing for this stack, so `volume prune` has nothing to take either.

Back it up with `pg_dump`, not by copying the directory while the server runs:

    docker compose exec -T postgres pg_dump -U fabulist fabulist | gzip > fabulist-$(date +%F).sql.gz

### Using a Postgres you already run

Create the role and database once, then set `FABULIST_PG`
as a repo secret — CI passes it through to `app.env` verbatim rather than assembling
it, because a workflow cannot know your host, port, role or database:

```sql
CREATE USER fabulist WITH PASSWORD 'pick-something';
CREATE DATABASE fabulist OWNER fabulist;
\c fabulist
GRANT ALL ON SCHEMA public TO fabulist;
```

The app creates every table, index and role itself on first boot, so there is no
migration to run — and no `psql` needed after those four lines.

⚠️ **A container cannot reach the host at `localhost`** — that is the container's own
network namespace. `docker-compose.yml` maps `host.docker.internal` to
`host-gateway`, so the connection string is:

    FABULIST_PG=postgres://fabulist:pw@host.docker.internal:5432/fabulist

Two things on the host side have to allow it, both one-time edits:

- `postgresql.conf`: `listen_addresses` must cover the Docker bridge, not just
  `localhost` — `listen_addresses = '*'` with the `pg_hba.conf` rule below, or the
  bridge address specifically.
- `pg_hba.conf`: a line for the Docker subnet, e.g.
  `host fabulist fabulist 172.16.0.0/12 scram-sha-256`. Reload with
  `SELECT pg_reload_conf();` or `systemctl reload postgresql`.

  Docker's default bridge is usually in `172.17.0.0/16`, but Compose creates its own
  networks and the exact subnet can change when they are recreated — hence the wider
  `/12`, which is the whole of Docker's default private range and still not routable
  from outside the host.

**On macOS, `host.docker.internal` does not reach the Mac.** Docker Desktop and
Rancher Desktop run the engine inside a Linux VM, so `host-gateway` is that VM's
gateway (`172.17.0.1`) — the VM, not your machine. Verified directly: a container
resolves the name and connects to `172.17.0.1:5432` (the VM's own Postgres, if any)
while a Postgres on the Mac at 5433 is refused. Rancher exposes the Mac at
`192.168.5.2` instead, so a local container-to-Mac-Postgres URL is:

    FABULIST_PG=postgres://fabulist:pw@192.168.5.2:5433/fabulist

That address is Rancher-specific and not worth relying on — on macOS prefer
`--profile bundled`, or run the app outside Docker with `pnpm serve`. **The VPS is
Linux, where `host.docker.internal:host-gateway` is exactly right**, which is the
case this deployment actually targets.

**`--profile bundled` needs none of that.** It runs `postgres:18-alpine`, creates the
`fabulist` role and database from an empty volume, publishes no ports (reachable only
on the compose network), and defaults its password — which is why it is for local runs
and not the deployment. `POSTGRES_PASSWORD` in `app.env` overrides it.

**Boot is automatic and idempotent.** On start it checks capacity, applies the
schema (`CREATE TABLE IF NOT EXISTS` throughout, so it is also the upgrade path),
imports any SQLite worlds it finds under `$DATA_ROOT/worlds/*/world.db`, and
serves. A world that imports successfully has its file renamed to `*.pre-pg`, so a
restart finds nothing to do. Nothing needs running by hand:

    found 3 SQLite world(s) to import: mass-effect-wiki, saint-verrow, star-trek-alpha-beta
      saint-verrow:          22 canon entities,     37 edges, 1 story in 0.1s
      mass-effect-wiki:  11,680 canon entities,  73,854 edges, 1 story in 3.1s
      star-trek-alpha-beta: 33,332 canon entities, 152,456 edges, 1 story in 7.8s
    import finished in 11.0s

**A failed import does not stop the server.** This is deliberate, and the reason is
in this repo's history: a deployed instance already crash-looped at boot once under
`restart: unless-stopped`. An importer that refused to start because one world of
five would not convert reproduces exactly that. So a failure is reported loudly,
recorded, and skipped — the unconverted `world.db` is left untouched and a restart
does **not** retry it. Only an explicit `pnpm import-pg --reimport=<slug>` does.
`--skip-import` starts without attempting any import at all.

`max_connections` matters. The default of 100 **aborts** at 100 players plus one
ingest (`FATAL: sorry, too many clients already`), so boot warns when the server
cannot supply what the pools want. Raise it to at least 300 on a shared instance.

Two roles enforce the user/system split (`src/db/schema-pg-roles.sql`):
`fabulist_play` may write stories but only *read* canon, and `fabulist_ingest` may
write both. That is why creating a world is an ingest operation, and why a bug in a
play route cannot corrupt source material.

Verified at target scale — 20 worlds, 40,020 canon entities, 79,860 canon edges,
100 users with stories (some crossovers), driven through the real stores and frame
builders rather than hand-written SQL:

| operation | throughput | p50 | p99 |
| --- | --- | --- | --- |
| resolve story + world | 16,000/s | 0.5 ms | 16.9 ms |
| full narrator frame | 1,732/s | 10.3 ms | 28.0 ms |
| turn commit | 1,389/s | 4.2 ms | 73.0 ms |

And the case SQLite could not serve at all — players taking turns *while* a wiki
ingest writes canon (64,500 entities during a 5s window):

| | frames | commit p50 | commit p99 |
| --- | --- | --- | --- |
| idle database | 2,378/s | 2.3 ms | 5.2 ms |
| ingest running | 1,951/s | 2.8 ms | 6.6 ms |

Under SQLite the same contention starved turn writes by **6×** (to ~40 ms), because
one writer lock covered the whole file. Here readers and writers touch different
tables under MVCC, so an ingest costs about 18% of read throughput and essentially
nothing in write latency. `pnpm integrity-pg` checked 167,216 rows clean in 0.1s
afterwards.

### Multi-user isolation

Several people can read different worlds and write different books at the same time
without seeing or blocking each other. Measured on the real code path, not asserted:

| scenario | throughput | p50 | p95 |
| --- | --- | --- | --- |
| 20 users, 2 shared worlds | 3,333 turns/s | 4.7 ms | 13.0 ms |
| same, with an ingest writing 6,000 canon rows | 3,659 turns/s | 4.5 ms | 7.7 ms |

A live ingest does not degrade play — MVCC means readers never wait for the writer, and
the second row is faster only because the cache is warm by then. Zero cross-user
contamination in every run.

What actually holds it together:

- **"Which book am I in" is per user**, resolved on every request from the session, with
  no server-wide current-story state. The SQLite ancestor could not do this: one process
  held one world file open, so switching worlds moved every reader at once.
- **`?storyId=` pins a tab to a book**, kept in `sessionStorage` rather than
  `localStorage` so a new tab lands on "my most recently played" instead of inheriting
  whatever an old tab left selected. That is what lets one person keep two worlds open
  side by side.
- **A story id from the client cannot reach another user's book.** It is checked against
  `owner_user_id` on every resolution, so a guessed id is refused rather than honoured.
- **Canon is shared and read-only to players**, enforced by the `fabulist_play` grants in
  the database rather than by application code, so one player cannot corrupt a world
  another is reading.

`test/pg-access.test.ts` pins all four.

### Resource footprint

Measured on this schema, not estimated. An idle bundled Postgres container is
**20 MB**; with the app's default pools open it is about **32 MB**, on a 425 MB image.
The Node process is ~80 MB RSS, which it was before this migration too.

The lever that matters is **pool size, not `max_connections`**: every open connection
is a Postgres *process* costing ~1.8 MB. The defaults are 4 play + 2 ingest — about
11 MB — chosen for one person on one server rather than for the load ceiling. An
earlier default of 20 + 3 spent ~41 MB serving concurrency a single-user instance
never has.

Four is enough because a turn holds a connection only while it *queries*. The seconds
it spends waiting on a model are spent with the connection returned to the pool.
Measured with 8 concurrent players deliberately oversubscribing a pool of 4:

| pool | turns/s | p50 | p99 |
| --- | --- | --- | --- |
| 4 | 990 | 6.8 ms | 21.2 ms |
| 20 | 1,500 | 4.4 ms | 17.4 ms |

A third less throughput, and 2.4 ms more latency on a turn that takes seconds — not
a tradeoff a player can perceive. Raise `FABULIST_PG_POOL` (and `max_connections`,
and `shared_buffers`) for an instance with genuine concurrent load; the 100-user load
test used 20 against `max_connections=300`.

**To save the most, don't run a second Postgres.** `docker compose up -d` uses the
one already on the server, so the marginal cost of this migration is the app's own
pools — about 11 MB — rather than another database. `--profile bundled` is for a
laptop, where its 20-32 MB does not matter.

### If Postgres restarts every 5 minutes

Symptom: the database log ends at `checkpoint starting: time` with no
`checkpoint complete`, no shutdown message and no error, roughly 300s
(`checkpoint_timeout`) after each start, and the container shows
`Restarting (1)`.

Cause: a container memory limit. There was a `256M` limit on the postgres service here,
set from measurements taken against an *empty* database; the first timed checkpoint on a
real dataset exceeded it and the kernel killed the process mid-writeback, which leaves no
message at all. The limit is gone. If you add one back, size it against a loaded
database, not an idle one.

`docker inspect fabulist-postgres --format '{{.State.ExitCode}} {{.State.OOMKilled}}'` is
the question that settles it: `137`/`true` is a memory kill, `1`/`false` is Postgres
refusing to start. `deploy.sh` now prints this for both containers whenever one is
unhealthy.

### If worlds disappear after a database problem

The importer renames `world.db` to `world.db.pre-pg` once a world is in Postgres, so
losing the database strands those files — nothing looks for `.pre-pg`. `deploy.sh`
restores them automatically when the database has no `sqlite_import_log` row for that
slug, then restarts the app so its boot importer runs. Nothing is lost as long as the
`.pre-pg` files are on disk; they are the original SQLite saves, untouched.

### If the bundled Postgres will not start

Symptom: the app logs `getaddrinfo ENOTFOUND postgres` or
`waiting for the database to accept connections…` forever, and the database logs
`mkdir: can't create directory '/var/lib/postgresql/18/': Permission denied` in a
restart loop.

Cause: the bind-mounted database directory contains a partial `18/` from an earlier
failed initialisation, which the entrypoint cannot write past. `deploy.sh` clears such
a directory automatically — but only when it holds *no cluster*, checked via
`PG_VERSION`, so a real database is never touched. If it reports
`note: could not clear …`, the deploy user lacks Docker access to fix it and the
directory needs removing by hand:

    sudo rm -rf <deploy-path>/fabulist-pg

That is safe **only** while no import has succeeded. Once there is a cluster, use
`pg_dump` (above) — never delete the directory.

This took five releases to find, and the reason is worth recording: Docker on macOS
does not enforce bind-mount ownership, so every local reproduction passed while
production kept failing. When a deploy fails on a Linux host in a way that cannot be
reproduced on a Mac, add diagnostics to the deploy before attempting another fix —
`deploy.sh` now prints container status, both logs, and mount diagnostics on failure,
which is what finally identified this.

## Known gaps, called out on purpose

- **The deploy key has no `authorized_keys` restriction.** The original design
  had `deploy.sh` read `$SSH_ORIGINAL_COMMAND` under a forced
  `command="/path/deploy.sh"` entry, so a leaked key could only ever run one
  of two fixed actions. That restriction was never actually added to the
  key's `authorized_keys` line (confirmed directly: `v0.2.0`'s deploy run
  failed with `fish: Unknown command: upload-env` — sshd was running the
  account's own login shell, `fish`, on the raw command string, because
  there was no forced command overriding it). Rather than block the whole
  pipeline on fixing that immediately, `deploy.sh` now takes its action as a
  real `$1` (`deploy/deploy.sh upload-env`), which works under any login
  shell with no `authorized_keys` change required — at the cost that this
  key can currently run *any* SSH command on the box, not just these two.
  To close this gap: add
  `command="/home/ra100/Development/fabulist/deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty`
  before the `ssh-ed25519 ...` on this key's line in `~/.ssh/authorized_keys`,
  then switch `deploy.sh` back to reading `$SSH_ORIGINAL_COMMAND` (git
  history has the exact prior version) and the workflow back to sending bare
  `upload-env`/`deploy` instead of the full path.
- **Provider auth**: the deployed instance boots with no `fabulist.config.json`
  in the fresh volume, so `loadConfig()` defaults to `profile: "mock"` —
  offline, deterministic, no credentials needed. This deployment
  deliberately does **not** wire up a real LLM provider (no AWS profile, no
  API key) for the REST/web-UI path — that's expected to come from whoever
  calls `/mcp` supplying their own model (`.design/MCP-CONNECTOR.md` §3). If
  someone drives the plain web UI/REST API against this deployment expecting
  real prose, it will narrate only with the mock provider until someone SSHes
  in and edits `/data/fabulist.config.json` by hand (or uses the Settings UI,
  which persists to the same file).
- **`/mcp`'s own exposure**: `MCP_RESOURCE_URL` being set makes `/mcp` mount
  and enforce its own OAuth check, but whether that path is actually
  *reachable* from the public internet (as a remote MCP connector needs) is
  entirely a function of the operator's own nginx/openresty config, which
  this repo does not manage.

## Continuous deployment from GitHub Actions

`release.yml`'s `deploy` job, after `docker` publishes a new image:

1. Renders `MCP_OAUTH_ISSUER`/`MCP_OAUTH_AUDIENCE`/`MCP_RESOURCE_URL` from
   repo variables into an `app.env`-shaped stream (skipping any that are
   unset, rather than writing an empty value that `buildMcpAuth()` would
   misread as "configured").
2. Pipes that over SSH, running `<DEPLOY_PATH>/deploy.sh upload-env` on the
   VPS, which writes it to `<DEPLOY_PATH>/app.env` atomically.
   `DEPLOY_PATH` is a repo variable, falling back to
   `/home/ra100/Development/fabulist` if unset.
3. SSHes again to run `<DEPLOY_PATH>/deploy.sh deploy`, which does
   `docker compose pull && up -d`. Compose recreates the container
   automatically because `app.env`'s *contents* changed (confirmed
   directly — this needs no explicit restart step), so the new env vars
   take effect on this same deploy, not the next one.

Add or change a repo variable (`gh variable set NAME --repo ra100/fabulist
--body "value"`) any time; it takes effect on the next tag push, no code
change needed.

## Cutting a release

```bash
git tag vX.Y.Z && git push --tags
```

Watch it with `gh run watch --repo ra100/fabulist` or
`gh run list --repo ra100/fabulist`.

## Verifying after a deploy

The single most useful check, and it needs no login:

    curl -s https://<your-host>/api/health

`{"ok":true,"database":"reachable","ms":9}` with HTTP 200 means the process is up *and*
Postgres is answering. HTTP 503 names the reason instead. Prefer this over `/api/meta`,
which renders its route table from memory and answers 200 throughout a database
outage — it reported "healthy" for the whole of a Postgres restart loop, which is why
the container healthcheck no longer uses it.



```bash
ssh -p 25 ra100@omnius.rast.io 'cd Development/fabulist && docker compose ps && docker compose logs --tail 20'
curl -s https://fabulist.rast.io/api/meta
```

