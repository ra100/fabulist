#!/usr/bin/env bash
# Forced-command entry point for the release deploy key. Install this file
# root-owned outside the deploy user's writable tree, then reference that copy
# from authorized_keys. SSH_ORIGINAL_COMMAND is data: it is matched here and
# never evaluated by a shell.
set -euo pipefail

deploy_path="${1:-}"
original_command="${SSH_ORIGINAL_COMMAND:-}"
minimum_release="v0.8.10"
repository="ra100/fabulist"
staging=""

if [[ "$deploy_path" != /* || "$deploy_path" == *$'\n'* ]]; then
  echo "fabulist deploy: forced command requires an absolute deploy path" >&2
  exit 1
fi

sync_release() {
  local release="$1"
  local current lowest

  if [[ ! "$release" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "fabulist deploy: invalid release tag" >&2
    exit 1
  fi

  lowest="$(printf '%s\n' "$minimum_release" "$release" | sort -V | head -n 1)"
  if [[ "$lowest" != "$minimum_release" ]]; then
    echo "fabulist deploy: releases older than $minimum_release are not allowed" >&2
    exit 1
  fi

  if [[ -f "$deploy_path/.deployed-release" ]]; then
    current="$(<"$deploy_path/.deployed-release")"
    lowest="$(printf '%s\n' "$current" "$release" | sort -V | head -n 1)"
    if [[ "$lowest" != "$current" ]]; then
      echo "fabulist deploy: refusing downgrade from $current to $release" >&2
      exit 1
    fi
  fi

  staging="$(mktemp -d "$deploy_path/.deploy-sync.XXXXXX")"
  trap 'rm -rf -- "$staging"' EXIT

  curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 \
    "https://raw.githubusercontent.com/$repository/$release/deploy/deploy.sh" \
    --output "$staging/deploy.sh"
  curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 \
    "https://raw.githubusercontent.com/$repository/$release/deploy/docker-compose.yml" \
    --output "$staging/docker-compose.yml"

  bash -n "$staging/deploy.sh"
  docker compose -f "$staging/docker-compose.yml" config --quiet
  chmod 0755 "$staging/deploy.sh"
  chmod 0644 "$staging/docker-compose.yml"
  mv -f "$staging/deploy.sh" "$deploy_path/deploy.sh"
  mv -f "$staging/docker-compose.yml" "$deploy_path/docker-compose.yml"
  printf '%s\n' "$release" > "$staging/deployed-release"
  mv -f "$staging/deployed-release" "$deploy_path/.deployed-release"

  echo "fabulist deploy: synced repository release $release"
}

case "$original_command" in
  "upload-env")
    exec "$deploy_path/deploy.sh" upload-env
    ;;
  "deploy")
    exec "$deploy_path/deploy.sh" deploy
    ;;
  "sync "*)
    release="${original_command#sync }"
    if [[ "$release" == *" "* ]]; then
      echo "fabulist deploy: invalid sync command" >&2
      exit 1
    fi
    sync_release "$release"
    ;;
  *)
    echo "fabulist deploy: command not allowed" >&2
    exit 1
    ;;
esac
