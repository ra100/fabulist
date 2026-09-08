#!/usr/bin/env bash
# Runs on the VPS. This is the *only* command the CI deploy key is allowed to
# execute (enforced by a `command=` restriction in authorized_keys — see
# deploy/README.md) — a leaked CI key can only ever reach the two actions
# below, and nothing else on the box.
#
# sshd's `command=` restriction replaces whatever the client asked to run,
# but still exposes the client's *original* request via
# $SSH_ORIGINAL_COMMAND (this script's own $1/$2/etc. are always empty —
# sshd invokes the forced command with no arguments of its own). This script
# reads that variable to pick one of exactly two fixed actions; anything
# else is rejected outright rather than guessed at.
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC2086 # deliberately unquoted: splits "upload-env foo"
# into ($action $rest) the same way $1/$2 would from real argv; there is no
# array/glob here for word-splitting to misbehave on.
read -r action rest <<< "${SSH_ORIGINAL_COMMAND:-}"

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
