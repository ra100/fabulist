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
    # racing this, can never observe a half-written file. Content only —
    # never executed, never echoed back (it carries no secrets today, but
    # treating it as opaque now means this path stays safe if it ever does).
    umask 077
    cat > app.env.tmp
    mv app.env.tmp app.env
    echo "app.env updated ($(wc -l < app.env) lines)"
    ;;
  deploy)
    docker compose pull
    docker compose up -d
    # Drops now-unreferenced image layers from the previous release. Volumes
    # (world data) are never touched by `image prune` — only images.
    docker image prune -f
    ;;
  *)
    echo "deploy.sh: unknown action '$action' (expected 'upload-env' or 'deploy')" >&2
    exit 1
    ;;
esac
