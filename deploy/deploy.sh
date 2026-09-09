#!/usr/bin/env bash
# Runs on the VPS, invoked by GitHub Actions over SSH with a real argument:
#   ssh ... "/home/ra100/Development/fabulist/deploy.sh upload-env"
#   ssh ... "/home/ra100/Development/fabulist/deploy.sh deploy"
#
# Uses a real $1, not $SSH_ORIGINAL_COMMAND — this account's login shell is
# fish (confirmed directly: an earlier version of this script relied on an
# authorized_keys `command=` restriction that turned out to never actually
# be in place, so sshd ran the *login shell* on the client's raw command
# string instead of this script, and fish has no `upload-env` builtin,
# which is exactly the error that surfaced). Passing the full invocation —
# interpreter, path, and argument — as one explicit command works under any
# login shell, fish included, because it's a plain external-command
# invocation with a real argv, not shell syntax fish has to understand.
#
# SECURITY NOTE, stated plainly rather than glossed over: without an
# authorized_keys `command=` restriction, this SSH key can run *anything* on
# the box, not just these two actions — this script restricts nothing on its
# own once invoked with an arbitrary command instead of this fixed one.
# Add `command="/home/ra100/Development/fabulist/deploy.sh"` (plus
# no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty) to this
# key's authorized_keys line when there's time to also switch the workflow
# back to reading $SSH_ORIGINAL_COMMAND — deploy/README.md has the exact
# line. Tracked as a known gap, not silently dropped.
set -euo pipefail
cd "$(dirname "$0")"

action="${1:-}"

case "$action" in
  upload-env)
    # Receives the rendered app.env over stdin and writes it atomically (via
    # a temp file + rename) so a mid-write failure, or a `docker compose up`
    # racing this, can never observe a half-written file. `umask 077` before
    # the write, not after, so the temp file is never briefly
    # world/group-readable — this carries real secrets now (WORKOS_API_KEY,
    # WORKOS_COOKIE_PASSWORD), not just public config. Content only — never
    # executed, never echoed back.
    umask 077
    cat > app.env.tmp
    mv app.env.tmp app.env
    echo "app.env updated ($(wc -l < app.env) lines)"
    ;;
  deploy)
    # `COMPOSE_PROFILES` has to be in *this shell's* environment, not just in
    # app.env.
    #
    # `env_file:` is read by the container at start; `${...}` substitution and
    # profile selection are done by the `docker compose` client, which looks only at
    # its own environment and `.env`. So a `COMPOSE_PROFILES=bundled` sitting in
    # app.env selects nothing — verified directly: `docker compose config --services`
    # listed only `fabulist`, the database never started, and the app then reported it
    # could not reach one. Exported here so one file stays the single place an
    # operator configures.
    if [ -f app.env ]; then
      set -a
      # shellcheck disable=SC1091
      . ./app.env
      set +a
    fi

    # ---------------------------------------------------------------- database
    #
    # Prepares the database on its own, so a release needs no manual step on the
    # box. Two shapes, and the *absence* of configuration picks the safe one:
    #
    #   FABULIST_PG set        -> an external Postgres the operator manages. Nothing
    #                             to prepare; the bundled service stays off.
    #   FABULIST_PG unset      -> run the bundled Postgres and generate a password
    #                             for it. This is the default because it is the one
    #                             that works with no decisions made.
    #
    # Defaulting to bundled rather than erroring is the whole point of this block:
    # an instance that has never been configured should come up working, and an
    # operator who wants their own database says so by setting one variable.
    if [ -z "${FABULIST_PG:-}" ]; then
      : "${COMPOSE_PROFILES:=bundled}"
      export COMPOSE_PROFILES

      # The generated password lives in `.env`, not `app.env`, and that separation is
      # deliberate: CI overwrites `app.env` wholesale on every release, so a secret
      # written there by this script would be destroyed by the next deploy — and
      # because `POSTGRES_PASSWORD` only takes effect when the data directory is
      # first created, the database would then be permanently unreachable with the
      # new value. `.env` is never uploaded, so it survives.
      #
      # `.env` is also exactly where the compose *client* looks for `${...}`
      # substitution, which is what both `POSTGRES_PASSWORD` and the `FABULIST_PG`
      # default in docker-compose.yml are.
      # Has the database already been initialised? This is the question that decides
      # everything below, and keying on `.env` instead — which is what this did at
      # first — is a guaranteed lockout: `POSTGRES_PASSWORD` is applied *only* when
      # the image creates an empty data directory, so writing a fresh password beside
      # an existing database leaves the two permanently disagreeing. Reproduced
      # exactly that while testing (`password authentication failed`, restart loop),
      # which is why the check is on the data directory itself.
      pg_dir="${FABULIST_PG_DIR:-./fabulist-pg}"
      pg_initialised=false
      # `-maxdepth 3`, because `PG_VERSION` is not unique: the cluster has one at
      # `<dir>/18/docker/PG_VERSION` and *another inside every database subdirectory*
      # (`base/1/PG_VERSION`, `base/16384/…`). An unbounded `find` matches those too,
      # so it reports "initialised" for a directory that only contains debris — and
      # would then refuse to start a genuinely empty one. Found while chasing a
      # failure that turned out to be a stale directory my own test had not cleaned.
      if [ -n "$(find "$pg_dir" -maxdepth 3 -name PG_VERSION -print -quit 2>/dev/null)" ]; then
        pg_initialised=true
      fi

      if [ -f .env ] && grep -q '^POSTGRES_PASSWORD=' .env; then
        # Whatever the database was initialised with. An `app.env` value is
        # deliberately *not* allowed to override this: it would not change the
        # database, only break the app's ability to reach it.
        if [ -n "${POSTGRES_PASSWORD:-}" ] && ! grep -qxF "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" .env; then
          echo "database: bundled, keeping the password the database was created with" >&2
          echo "  (POSTGRES_PASSWORD in app.env differs and is being ignored: changing it here cannot" >&2
          echo "   change an existing database. To rotate it: docker compose exec postgres psql -U fabulist" >&2
          echo "   -c \"ALTER USER fabulist PASSWORD '…'\" and then update .env to match.)" >&2
        else
          echo "database: bundled, reusing the existing password"
        fi
      elif [ "$pg_initialised" = true ]; then
        # A database exists but no password is recorded — `.env` was lost, or this box
        # predates it. Guessing would lock the app out, so this stops with the two
        # ways forward rather than starting something that cannot connect.
        echo "deploy.sh: $pg_dir holds an initialised database but .env has no POSTGRES_PASSWORD." >&2
        echo "  Recover by putting the original password in .env as POSTGRES_PASSWORD=…, or reset it:" >&2
        echo "    docker compose exec postgres psql -U fabulist -c \"ALTER USER fabulist PASSWORD 'new'\"" >&2
        echo "  then write that same value into .env. Nothing was started." >&2
        exit 1
      elif [ -n "${POSTGRES_PASSWORD:-}" ]; then
        # First init, operator-supplied password. Mirrored into .env because that is
        # where the compose *client* reads `${...}` substitution from, and because
        # CI overwrites app.env on every release while .env is never uploaded.
        umask 077
        printf 'POSTGRES_PASSWORD=%s\n' "$POSTGRES_PASSWORD" > .env.tmp
        mv .env.tmp .env
        echo "database: bundled, initialising with the password from app.env"
      else
        # First init, nothing supplied: generate one. 32 hex characters from the
        # kernel CSPRNG — `openssl` is not assumed, but /dev/urandom and od are on
        # any Linux that can run Docker.
        generated="$(od -vAn -N16 -tx1 /dev/urandom | tr -d ' \n')"
        umask 077
        printf 'POSTGRES_PASSWORD=%s\n' "$generated" > .env.tmp
        mv .env.tmp .env
        echo "database: bundled, generated a password (kept in .env, never uploaded)"
      fi
      # Sourced back so the echo below and any later command see it.
      set -a
      # shellcheck disable=SC1091
      . ./.env
      set +a
    fi

    # The bind mounts, created before compose so Docker does not have to — a fresh
    # box and an upgraded one then take the same path, and it is visible where the
    # data will land before anything writes to it.
    mkdir -p "${FABULIST_DATA_DIR:-./fabulist-data}" "${FABULIST_PG_DIR:-./fabulist-pg}"

    # Clear a database directory that holds no cluster.
    #
    # This is what the diagnostics finally showed: the directory was mode 0700 owned by
    # 999 *containing a stale root-owned `18/`* from an earlier failed init, and the
    # entrypoint's `mkdir` kept failing against it no matter who ran it. Debris from a
    # failed initialisation is worthless by definition — `pg_initialised` is false, so
    # there is no cluster and nothing anyone wrote — and leaving it in place is what
    # made three consecutive fixes appear to do nothing.
    #
    # Guarded on `pg_initialised` so this can never touch a real database: the moment a
    # cluster exists, this branch does not run. Done from a root container because the
    # debris is root-owned and the deploy user is not root.
    if [ "${pg_initialised:-false}" != true ] && [ -n "$(ls -A "${FABULIST_PG_DIR:-./fabulist-pg}" 2>/dev/null || echo probe)" ]; then
      pg_parent="$(cd "$(dirname "${FABULIST_PG_DIR:-./fabulist-pg}")" && pwd)"
      pg_leaf="$(basename "${FABULIST_PG_DIR:-./fabulist-pg}")"
      if docker run --rm -v "$pg_parent:/parent" --user 0 alpine sh -c \
        "rm -rf '/parent/$pg_leaf' && mkdir -p '/parent/$pg_leaf'"; then
        echo "cleared an uninitialised database directory (failed-init debris, no cluster present)"
      else
        echo "note: could not clear ${FABULIST_PG_DIR:-./fabulist-pg}; Postgres may fail to initialise" >&2
      fi
    fi

    # Ownership of the database directory is deliberately *not* handled here.
    #
    # Four releases were spent trying: chowning the bind mount to 999:999 before
    # compose, first only when empty (skipped, because failed inits had left debris),
    # then recursively. Every attempt passed locally and failed in production, because
    # Docker Desktop / Rancher on macOS does not enforce bind-mount ownership at all —
    # a `chown` there is a no-op and uid 999 can write regardless, so no local test
    # could reproduce or validate the fix.
    #
    # The postgres service now runs as root (`user: "0:0"` in docker-compose.yml) and
    # its own entrypoint chowns the data directory before dropping to the postgres
    # user, which is how the pre-18 images behaved and what the official image
    # supports for bind mounts. That removes the host-ownership dependency entirely
    # rather than trying to guess it right from a machine that cannot observe it.

    if [ -n "${COMPOSE_PROFILES:-}" ]; then
      echo "profiles: $COMPOSE_PROFILES"
    else
      echo "profiles: none (using the external Postgres named by FABULIST_PG)"
    fi

    # Any SQLite worlds still on disk are imported by the app at boot, once, and
    # their files are renamed `*.pre-pg` afterwards so a restart does not repeat it.
    # Reported here because it is the one part of a deploy that can take minutes and
    # is otherwise invisible until someone reads the container log.
    if [ -d "${FABULIST_DATA_DIR:-./fabulist-data}/worlds" ]; then
      pending="$(find "${FABULIST_DATA_DIR:-./fabulist-data}/worlds" -maxdepth 2 -name world.db 2>/dev/null | wc -l | tr -d ' ')"
      if [ "$pending" != "0" ]; then
        echo "sqlite worlds to import on this boot: $pending (the app does it automatically; watch \`docker compose logs -f fabulist\`)"
      fi
    fi

    docker compose pull
    docker compose up -d

    # Report what actually happened, in the deploy output.
    #
    # Added after v0.7.0 and v0.7.1 both deployed "successfully" and then 502'd: the
    # job log showed compose starting containers and nothing else, so diagnosing meant
    # SSH access that CI does not have and I could not reach. A deploy that cannot say
    # why it is broken costs a release per guess.
    #
    # `|| true` throughout: this is diagnostics, and a failure to *report* must never
    # fail a deploy that otherwise worked.
    echo "--- waiting for the app to answer (up to 180s) ---"
    for _ in $(seq 1 60); do
      if docker compose exec -T fabulist node -e \
        "require('http').get('http://127.0.0.1:4317/api/meta',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))" \
        >/dev/null 2>&1; then
        echo "app is answering"
        break
      fi
      sleep 3
    done
    echo "--- container status ---"
    docker compose ps --format '{{.Name}}\t{{.Status}}' || true
    # Why each container last exited, which `docker compose ps` does not say and a
    # restarting container's own logs eventually roll away.
    #
    # Added after a Postgres restart loop that had to be diagnosed by asking the
    # operator to run `docker inspect` by hand: exit 137 with OOMKilled=true is the
    # memory limit, exit 1 is a Postgres-level refusal, and the two need completely
    # different fixes. Guessing between them cost several releases.
    for c in fabulist fabulist-postgres; do
      docker inspect "$c" --format \
        "exit: {{.Name}} code={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}} {{.State.Error}}" \
        2>/dev/null || true
    done
    echo "--- app log (last 40) ---"
    docker compose logs --tail 40 --no-log-prefix fabulist 2>&1 || true
    echo "--- database log (last 15) ---"
    docker compose logs --tail 15 --no-log-prefix postgres 2>&1 || true
    # Mount diagnostics, printed only when the database is not healthy.
    #
    # Added because the `Permission denied` on `/var/lib/postgresql/18/` survived both
    # a recursive host chown *and* running the container as root — and root cannot be
    # denied by ownership, so the cause is something else: an SELinux label on the bind
    # mount (needs `:Z`), a read-only mount, or a filesystem that refuses it. Each
    # leaves a different fingerprint, and guessing between them from a Mac has already
    # cost several releases.
    if ! docker compose ps --format '{{.Name}} {{.Status}}' 2>/dev/null | grep -q "fabulist-postgres.*healthy"; then
      echo "--- mount diagnostics ---"
      echo "host selinux: $(getenforce 2>/dev/null || echo 'not present')"
      echo "host dir:     $(ls -ldn "${FABULIST_PG_DIR:-./fabulist-pg}" 2>/dev/null)"
      echo "filesystem:   $(df -T "${FABULIST_PG_DIR:-./fabulist-pg}" 2>/dev/null | tail -1)"
      # Mounted via the *parent* directory: the previous version did
      # `cd "$pg_dir" && pwd` to get an absolute path, which fails with
      # `Permission denied` when the directory is mode 0700 and owned by someone else —
      # so the probe that was meant to explain the failure was itself defeated by it,
      # and then passed an empty path to `docker run`.
      echo "as seen inside a root container:"
      docker run --rm -v "$(cd "$(dirname "${FABULIST_PG_DIR:-./fabulist-pg}")" && pwd):/parent" --user 0 alpine sh -c \
        "d=/parent/$(basename "${FABULIST_PG_DIR:-./fabulist-pg}"); ls -ldn \"\$d\"; ls -an \"\$d\" | head -5; touch \"\$d/.probe\" 2>&1 && echo 'root CAN write the mount' && rm -f \"\$d/.probe\" || echo 'root CANNOT write the mount'" 2>&1 || true
    fi
    echo "--- end ---"
    # Drops now-unreferenced image layers from the previous release. Neither the
    # app's /data nor the database directory is touched by `image prune` — both are
    # bind mounts on the host disk, not volumes, and `image prune` only removes
    # images regardless.
    docker image prune -f
    ;;
  *)
    echo "deploy.sh: unknown action '$action' (expected 'upload-env' or 'deploy')" >&2
    exit 1
    ;;
esac
