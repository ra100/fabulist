# Deploying fabulist to the VPS

Scope of this deployment (see the conversation that produced it): the app has
**zero built-in request authentication** (`src/server/api.ts`'s ~60 routes all
trust whoever can reach them) and the MCP+OAuth front door described in
`.design/MCP-CONNECTOR.md` doesn't exist yet. This is therefore a **private**
deployment — public DNS and TLS, but nginx restricts entry to an IP
allowlist. Revisit exposure once MCP+OAuth (or some other real auth layer)
lands.

## What's here

| File | Purpose |
|---|---|
| `docker-compose.yml` | The one service, pinned to `ra100/fabulist:latest`, `/data` as a named volume |
| `nginx/fabulist.conf` | Reverse proxy + IP allowlist + SSE-safe proxy settings, for `fabulist.rast.io` |
| `vps-setup.sh` | One-time: installs Docker/nginx/certbot, copies the compose file, starts the app, installs the nginx site |
| `deploy.sh` | The repeatable step: `docker compose pull && up -d`. This is the *only* command the CI deploy key can run (see below) |

## One-time VPS setup

```bash
scp -P 25 deploy/vps-setup.sh deploy/docker-compose.yml -r deploy/nginx ra100@omnius.rast.io:~/
ssh -p 25 ra100@omnius.rast.io
chmod +x vps-setup.sh
DEPLOY_PATH=/home/ra100/Development/fabulist DOMAIN=fabulist.rast.io ./vps-setup.sh
```

It stops partway to tell you to edit the IP allowlist in the installed nginx
config (`/etc/nginx/sites-available/fabulist.rast.io`) before reloading —
replace both `CHANGE-ME-YOUR-IP-*` lines with real addresses (`curl -4
ifconfig.me` from each network you'll play from), then:

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d fabulist.rast.io
```

Also copy `deploy/deploy.sh` to the deploy path — `vps-setup.sh` doesn't do
this automatically since it's meant to be re-fetched by CI on every release,
not baked in once:

```bash
cp deploy.sh /home/ra100/Development/fabulist/deploy.sh
chmod +x /home/ra100/Development/fabulist/deploy.sh
```

## Continuous deployment from GitHub Actions

`release.yml`'s `deploy` job runs after `docker` publishes a new image, and
SSHes in to run `deploy.sh`. It needs one secret and three repo variables —
you said you'd set these yourself; here's exactly what each one is and how to
set it with `gh` if you'd rather not click through the UI.

**Generate a dedicated deploy key** (don't reuse your personal key — this one
should be restricted to doing nothing but this one command):

```bash
ssh-keygen -t ed25519 -C "fabulist-deploy@github-actions" -f fabulist_deploy_key -N ""
```

**Restrict what that key can do**, on the VPS, in `~/.ssh/authorized_keys`
(as the `ra100` user — append a line, don't replace existing entries):

```
command="/home/ra100/Development/fabulist/deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA...rest-of-fabulist_deploy_key.pub... fabulist-deploy@github-actions
```

The `command=` forces sshd to run `deploy.sh` no matter what the client asks
for — this is what makes "the CI key leaked" a non-event: it can pull+restart
this one compose project and touch nothing else on the box, not even a shell.

**Set the GitHub secret and variables** (repo: `ra100/fabulist`):

```bash
gh secret set SSH_PRIVATE_KEY --repo ra100/fabulist < fabulist_deploy_key
gh variable set SSH_DOMAIN --repo ra100/fabulist --body "omnius.rast.io"
gh variable set SSH_PORT   --repo ra100/fabulist --body "25"
gh variable set SSH_USER   --repo ra100/fabulist --body "ra100"
```

Then delete the local private key file (`fabulist_deploy_key`) — it only
needs to exist long enough to be pasted into the two places above.

## Cutting a release (unchanged from before this doc)

```bash
git tag vX.Y.Z && git push --tags
```

This builds+pushes the Docker image (as it already did) and now also
deploys it. Watch it with `gh run watch --repo ra100/fabulist` or
`gh run list --repo ra100/fabulist`.

## Verifying after deploy

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
