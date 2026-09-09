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
    if [ -n "${COMPOSE_PROFILES:-}" ]; then
      echo "profiles: $COMPOSE_PROFILES"
    else
      echo "profiles: none (expecting FABULIST_PG to name an external Postgres)"
    fi
    docker compose pull
    docker compose up -d
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
