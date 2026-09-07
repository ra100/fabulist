# Deploying fabulist to the VPS

Scope of this deployment (see the conversation that produced it): the app has
**zero built-in request authentication** (`src/server/api.ts`'s ~60 routes all
trust whoever can reach them) and the MCP+OAuth front door described in
`.design/MCP-CONNECTOR.md` doesn't exist yet. This is therefore a **private**
deployment — public DNS and TLS, but the reverse proxy restricts entry to an
IP allowlist. Revisit exposure once MCP+OAuth (or some other real auth layer)
lands.

**Reverse proxy: openresty, not a separate nginx.** The VPS already runs
openresty for other sites (visible in the existing `/etc/cron.d/certbot`
entries that stop/start it around certificate renewal), so this deployment
reuses it rather than installing a second, competing nginx that would fight
it for ports 80/443.

**TLS: a `*.rast.io` wildcard cert via DNS-01**, not a per-domain HTTP-01 cert
(HTTP-01 cannot issue wildcards at all — an ACME/CA-level rule, not a certbot
limitation). Issued with the `certbot-dns-websupport` plugin, which talks to
Websupport's DNS API to satisfy the challenge automatically — no manual DNS
step, and it renews unattended forever after. That plugin needs
`certbot>=3.2.0`; this box's apt certbot is 2.9.0, and mixing pip into an
apt-managed certbot install breaks (dependency conflict, confirmed while
setting this up) — so it lives in its own virtualenv at `/opt/certbot-venv`,
completely separate from the apt certbot, which keeps renewing whatever it
already managed (e.g. `fabulist.rast.io`'s old per-domain cert, if you don't
retire it) with zero interaction between the two.

## What's here

| File | Purpose |
|---|---|
| `docker-compose.yml` | The one service, pinned to `ra100/fabulist:latest`, `/data` as a named volume |
| `nginx/fabulist.conf` | openresty/nginx server block: IP allowlist, SSE-safe proxy settings, TLS pointed at the wildcard cert, HTTP→HTTPS redirect |
| `vps-setup.sh` | One-time: installs Docker, copies the compose file + `deploy.sh`, starts the app. Does **not** touch openresty or certbot — those are managed separately (below) |
| `deploy.sh` | The repeatable step: `docker compose pull && up -d`. This is the *only* command the CI deploy key can run (see below) |

## Already done (as of this doc)

- [x] `*.rast.io` wildcard cert issued via `certbot-dns-websupport` in
      `/opt/certbot-venv`, reusing the existing Let's Encrypt account.
- [x] Renewal cron entry added to `/etc/cron.d/certbot`:
      `/usr/local/bin/certbot renew --cert-name rast.io --post-hook "systemctl reload openresty"`
      (`/usr/local/bin/certbot` symlinked to the venv's certbot — separate
      from `/usr/bin/certbot`, the apt one, so the existing cron lines that
      reference `/usr/bin/certbot` / `--standalone` keep managing their own
      lineages untouched).
- [x] SSH deploy key generated, `SSH_PRIVATE_KEY` secret and
      `SSH_DOMAIN`/`SSH_PORT`/`SSH_USER` variables set on the GitHub repo.

## What's left to actually make it run

1. **Restrict the deploy key on the VPS.** The public half of the key you
   generated needs to land in `~/.ssh/authorized_keys` for the `ra100` user,
   forced to only ever run `deploy.sh`:

   ```bash
   echo 'command="/home/ra100/Development/fabulist/deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA...your-pubkey... fabulist-deploy@github-actions' >> ~/.ssh/authorized_keys
   ```

   The path in `command=` must match exactly where `deploy.sh` ends up in
   step 2 — `/home/ra100/Development/fabulist/deploy.sh`.

2. **Run the app-side one-time setup**, from your Mac:

   ```bash
   scp -P 25 deploy/vps-setup.sh deploy/docker-compose.yml deploy/deploy.sh ra100@omnius.rast.io:~/
   ssh -p 25 ra100@omnius.rast.io
   chmod +x vps-setup.sh
   DEPLOY_PATH=/home/ra100/Development/fabulist ./vps-setup.sh
   ```

   This installs Docker if missing, copies `docker-compose.yml` and
   `deploy.sh` into place, and starts the container listening on
   `127.0.0.1:4317`.

3. **Install the openresty server block.** Copy `deploy/nginx/fabulist.conf`
   to wherever your openresty config includes server blocks from (check the
   `include` directives in openresty's main `nginx.conf` — commonly a
   `conf.d/` or `sites-enabled/`-style directory, whatever this box's other
   sites already use), then edit both `CHANGE-ME-YOUR-IP-*` lines to your
   real allowed source IPs (`curl -4 ifconfig.me` from each network you'll
   play from). Then:

   ```bash
   sudo openresty -t && sudo systemctl reload openresty
   ```

4. **Verify end-to-end**, from an allowlisted IP:

   ```bash
   curl -s https://fabulist.rast.io/api/meta
   ```

5. **Test the restricted deploy key actually works and actually is
   restricted**, from your Mac, using the private key file (not through
   GitHub Actions yet):

   ```bash
   ssh -i fabulist_deploy_key -p 25 ra100@omnius.rast.io "whoami; ls /"
   ```

   This should run `deploy.sh` regardless of the command you typed — if you
   see `whoami`/`ls` output instead, the `command=` restriction in step 1
   isn't taking effect and needs a look before trusting it with a real
   secret.

Once all five are done, the pipeline is live: `git tag vX.Y.Z && git push
--tags` builds+pushes the Docker image and redeploys automatically.

## Cutting a release

```bash
git tag vX.Y.Z && git push --tags
```

Watch it with `gh run watch --repo ra100/fabulist` or
`gh run list --repo ra100/fabulist`.

## Verifying after a deploy

```bash
ssh -p 25 ra100@omnius.rast.io 'cd Development/fabulist && docker compose ps && docker compose logs --tail 20'
curl -s https://fabulist.rast.io/api/meta   # from an allowlisted IP
```

## Known gap, called out on purpose

Provider auth: the deployed instance boots with no `fabulist.config.json`
in the fresh volume, so `loadConfig()` defaults to `profile: "mock"` —
offline, deterministic, no credentials needed. Per the scoping conversation,
this deployment intentionally does **not** wire up a real LLM provider (no
AWS profile, no API key) — that's expected to come from the MCP+OAuth
front-door work in `.design/MCP-CONNECTOR.md` §3, where the *caller's* chat
client supplies the model. Until that lands, this deployment is reachable
and inspectable but narrates only with the mock provider unless you SSH in
and edit `/data/fabulist.config.json` by hand (or wait for the settings UI,
which already supports live profile switching per the README's Providers
section).
