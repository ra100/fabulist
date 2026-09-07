#!/usr/bin/env bash
# One-time setup for fabulist on a fresh Ubuntu VPS.
#
# Run this yourself, once, on the VPS (as a sudo-capable user, e.g. ra100):
#   scp deploy/vps-setup.sh omnius.rast.io:~ -P 25
#   ssh -p 25 omnius.rast.io
#   chmod +x vps-setup.sh && ./vps-setup.sh
#
# It is idempotent — safe to re-run if a step fails partway through.
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/home/ra100/Development/fabulist}"
DOMAIN="${DOMAIN:-fabulist.rast.io}"

echo "== 1/5: Docker Engine + Compose plugin =="
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "Added $USER to the docker group — log out and back in (or 'newgrp docker') for this shell to see it."
else
  echo "docker already installed: $(docker --version)"
fi

echo "== 2/5: nginx + certbot =="
sudo apt-get update -qq
sudo apt-get install -y nginx certbot python3-certbot-nginx

echo "== 3/5: deploy directory + compose file =="
mkdir -p "$DEPLOY_PATH"
cp "$(dirname "$0")/docker-compose.yml" "$DEPLOY_PATH/docker-compose.yml"
echo "Copied docker-compose.yml to $DEPLOY_PATH"

echo "== 4/5: pull and start the app (private, no public listener yet) =="
cd "$DEPLOY_PATH"
docker compose pull
docker compose up -d
echo "fabulist is now listening on 127.0.0.1:4317 (not yet public)."

echo "== 5/5: nginx site + TLS =="
NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}"
sudo cp "$(dirname "$0")/nginx/fabulist.conf" "$NGINX_CONF"
sudo sed -i "s/fabulist.rast.io/${DOMAIN}/g" "$NGINX_CONF"
sudo ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/${DOMAIN}"
echo
echo "!!! BEFORE reloading nginx: edit $NGINX_CONF and replace both"
echo "    CHANGE-ME-YOUR-IP-* lines with your real allowed source IPs."
echo "    Then run:"
echo "      sudo nginx -t && sudo systemctl reload nginx"
echo "      sudo certbot --nginx -d ${DOMAIN}"
echo
echo "Setup script done. Check 'docker compose ps' and 'docker compose logs -f' in $DEPLOY_PATH."
