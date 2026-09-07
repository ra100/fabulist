#!/usr/bin/env bash
# Runs on the VPS. This is the *only* command the CI deploy key is allowed to
# execute (enforced by a `command=` restriction in authorized_keys — see
# deploy/README.md) — a leaked CI key can pull+restart this one compose
# project and nothing else on the box.
set -euo pipefail
cd "$(dirname "$0")"
docker compose pull
docker compose up -d
# Drops now-unreferenced image layers from the previous release. Volumes
# (world data) are never touched by `image prune` — only images.
docker image prune -f
