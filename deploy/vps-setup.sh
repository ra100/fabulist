#!/usr/bin/env bash
# One-time *bootstrap* for fabulist on this VPS — installs Docker and starts
# the container for the first time. Not the ongoing sync mechanism: every
# tag push re-syncs deploy.sh/docker-compose.yml itself via scp from
# release.yml's deploy job, so this script's own copy step only matters
# before that pipeline has run even once.
#
# Assumes the reverse proxy (openresty) and the *.rast.io wildcard TLS cert
# already exist and are managed outside this script — this box terminates
# TLS for other sites already, so re-installing a second nginx/certbot here
# would just fight the existing setup. This script only does the
# fabulist-specific part: Docker + the app container.
#
# Run this yourself, once, on the VPS (as a sudo-capable user, e.g. ra100):
#   scp -P 25 deploy/vps-setup.sh deploy/docker-compose.yml deploy/deploy.sh ra100@omnius.rast.io:~/
#   ssh -p 25 ra100@omnius.rast.io
#   chmod +x vps-setup.sh && ./vps-setup.sh
#
# It is idempotent — safe to re-run if a step fails partway through.
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/home/ra100/Development/fabulist}"

echo "== 1/3: Docker Engine + Compose plugin =="
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "Added $USER to the docker group — log out and back in (or 'newgrp docker') for this shell to see it."
else
  echo "docker already installed: $(docker --version)"
fi

echo "== 2/3: deploy directory + compose file =="
mkdir -p "$DEPLOY_PATH"
cp "$(dirname "$0")/docker-compose.yml" "$DEPLOY_PATH/docker-compose.yml"
cp "$(dirname "$0")/deploy.sh" "$DEPLOY_PATH/deploy.sh"
chmod +x "$DEPLOY_PATH/deploy.sh"
echo "Copied docker-compose.yml and deploy.sh to $DEPLOY_PATH"

echo "== 3/3: pull and start the app =="
cd "$DEPLOY_PATH"
docker compose pull
docker compose up -d
echo "fabulist is now listening on 127.0.0.1:4317."
echo
echo "Remaining, outside this script (see deploy/README.md):"
echo "  - drop deploy/nginx/fabulist.conf into wherever openresty includes"
echo "    server blocks from, with the CHANGE-ME-YOUR-IP-* lines filled in"
echo "  - confirm the *.rast.io cert + its renewal cron entry are in place"
echo "  - reload openresty and curl https://fabulist.rast.io/api/meta from"
echo "    an allowlisted IP"
echo
echo "Check 'docker compose ps' and 'docker compose logs -f' in $DEPLOY_PATH."
