# Deploying fabulist to the VPS

Scope of this deployment (see the conversation that produced it): the app has
**zero built-in request authentication** on its REST routes (`src/server/api.ts`'s
~60 routes all trust whoever can reach them). `/mcp` is different — it has its
own bearer-token check (`src/mcp/auth.ts`, OAuth via WorkOS AuthKit) and is not
mounted at all unless that's configured. **Reverse proxy / TLS / access
control on the VPS is configured directly by the operator, outside this repo**
— `nginx/fabulist.conf` here is a reference copy, not necessarily what's
currently live; nothing in this repo or its CI touches the VPS's nginx/openresty
config.

**Reverse proxy: openresty**, already running on the VPS for other sites.

**TLS: a `*.rast.io` wildcard cert via DNS-01** (HTTP-01 cannot issue
wildcards at all — an ACME/CA-level rule). Issued with `certbot-dns-websupport`
against Websupport's DNS API, in a dedicated venv at `/opt/certbot-venv` kept
separate from the box's apt certbot (2.9.0 — too old for this plugin, and
mixing pip into the apt install breaks). Renews unattended via its own
`/etc/cron.d/certbot` entry.

## What's here

| File | Purpose |
|---|---|
| `docker-compose.yml` | The one service, pinned to `ra100/fabulist:latest`, `/data` as a named volume, `app.env` as an optional (`required: false`) env file |
| `nginx/fabulist.conf` | Reference openresty/nginx server block — **not necessarily the live config**; the operator manages that directly |
| `vps-setup.sh` | One-time: installs Docker, copies the compose file + `deploy.sh`, starts the app. Does **not** touch openresty or certbot |
| `deploy.sh` | Runs on the VPS as the CI deploy key's forced `command=`. Dispatches on `$SSH_ORIGINAL_COMMAND` between exactly two actions — `upload-env` (writes `app.env` from stdin) and `deploy` (`docker compose pull && up -d`) — a leaked key can reach only those two, nothing else |

## Already done (as of this doc)

- [x] `*.rast.io` wildcard cert, renewing unattended.
- [x] SSH deploy key generated; `SSH_PRIVATE_KEY` secret and
      `SSH_DOMAIN`/`SSH_PORT`/`SSH_USER` repo variables set.
- [x] `MCP_OAUTH_ISSUER`, `MCP_OAUTH_AUDIENCE`, `MCP_RESOURCE_URL` set as repo
      variables (`https://fastidious-attic-52.authkit.app`,
      `client_01M1YFPQ054SZ2DD5HFTB22MK1`, `https://fabulist.rast.io/mcp` —
      the same values verified end-to-end in `.design/MCP-CONNECTOR.md`).
      `WORKOS_API_KEY` stays a secret and is **not** part of this pipeline —
      the running server never needs it, only the three values above
      (`src/mcp/auth.ts`'s OAuth mode verifies tokens against the issuer's
      published JWKS; it never calls WorkOS's management API).
- [x] `release.yml`'s `deploy` job now renders those three as `app.env` and
      runs `upload-env` before `deploy` on every tag push — see
      "Continuous deployment" below.

## What's left to actually make it run

1. **Restrict the deploy key on the VPS**, if not already done — the public
   half of the generated key in `~/.ssh/authorized_keys` for the `ra100` user:

   ```bash
   echo 'command="/home/ra100/Development/fabulist/deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA...your-pubkey... fabulist-deploy@github-actions' >> ~/.ssh/authorized_keys
   ```

   The path in `command=` must match exactly where `deploy.sh` lives —
   `/home/ra100/Development/fabulist/deploy.sh`.

2. **Re-copy `deploy.sh` and `docker-compose.yml` to the VPS.** If you ran
   `vps-setup.sh` before this doc's update, the VPS still has the *old*
   single-purpose `deploy.sh` (no `upload-env` action) and the *old*
   `docker-compose.yml` (no `app.env` reference) — `vps-setup.sh` only copies
   these once, on first setup, and does not re-sync them on its own:

   ```bash
   scp -P 25 deploy/deploy.sh deploy/docker-compose.yml ra100@omnius.rast.io:~/Development/fabulist/
   ssh -p 25 ra100@omnius.rast.io 'chmod +x ~/Development/fabulist/deploy.sh'
   ```

   (First-ever setup, instead: run `vps-setup.sh` per its own header comment.)

3. **Confirm `/mcp` mounts**, from an allowlisted vantage point (whatever the
   operator's own nginx/openresty config permits):

   ```bash
   curl -s https://fabulist.rast.io/api/meta   # confirms the server itself is up
   ```

   `docker compose logs` on the VPS should show `/mcp mounted at
   https://fabulist.rast.io/mcp` on the next boot after `app.env` lands — see
   `src/cli/serve.ts`'s boot log for the exact line.

4. **Test the restricted deploy key's two actions work and nothing else
   does**, from your Mac, using the private key file (not through GitHub
   Actions yet):

   ```bash
   echo "MCP_RESOURCE_URL=https://fabulist.rast.io/mcp" | \
     ssh -i fabulist_deploy_key -p 25 ra100@omnius.rast.io "upload-env"
   ssh -i fabulist_deploy_key -p 25 ra100@omnius.rast.io "deploy fabulist test"
   ssh -i fabulist_deploy_key -p 25 ra100@omnius.rast.io "whoami; ls /"
   ```

   The first two should succeed (`app.env updated (...)`, then a normal
   `docker compose pull/up` run); the third should refuse — printing
   `deploy.sh: unknown action 'whoami'`, never actually running `whoami`/`ls`.
   If it *does* run them, the `command=` restriction in step 1 isn't taking
   effect and needs a look before trusting it with a real secret.

Once these are done, the pipeline is live end-to-end: `git tag vX.Y.Z && git
push --tags` builds+pushes the Docker image, uploads the rendered `app.env`,
and redeploys.

## Continuous deployment from GitHub Actions

`release.yml`'s `deploy` job, after `docker` publishes a new image:

1. Renders `MCP_OAUTH_ISSUER`/`MCP_OAUTH_AUDIENCE`/`MCP_RESOURCE_URL` from
   repo variables into an `app.env`-shaped stream (skipping any that are
   unset, rather than writing an empty value that `buildMcpAuth()` would
   misread as "configured").
2. Pipes that over SSH to `upload-env`, which writes it to
   `/home/ra100/Development/fabulist/app.env` atomically.
3. SSHes again to run `deploy`, which does `docker compose pull && up -d`.
   Compose recreates the container automatically because `app.env`'s
   *contents* changed (confirmed directly — this needs no explicit restart
   step), so the new env vars take effect on this same deploy, not the next
   one.

Add or change a repo variable (`gh variable set NAME --repo ra100/fabulist
--body "value"`) any time; it takes effect on the next tag push, no code
change needed.

## Cutting a release

```bash
git tag vX.Y.Z && git push --tags
```

Watch it with `gh run watch --repo ra100/fabulist` or
`gh run list --repo ra100/fabulist`.

## Verifying after a deploy

```bash
ssh -p 25 ra100@omnius.rast.io 'cd Development/fabulist && docker compose ps && docker compose logs --tail 20'
curl -s https://fabulist.rast.io/api/meta
```

## Known gaps, called out on purpose

- **Provider auth**: the deployed instance boots with no `fabulist.config.json`
  in the fresh volume, so `loadConfig()` defaults to `profile: "mock"` —
  offline, deterministic, no credentials needed. This deployment
  deliberately does **not** wire up a real LLM provider (no AWS profile, no
  API key) for the REST/web-UI path — that's expected to come from whoever
  calls `/mcp` supplying their own model (`.design/MCP-CONNECTOR.md` §3). If
  someone drives the plain web UI/REST API against this deployment expecting
  real prose, it will narrate only with the mock provider until someone SSHes
  in and edits `/data/fabulist.config.json` by hand (or uses the Settings UI,
  which persists to the same file).
- **`/mcp`'s own exposure**: `MCP_RESOURCE_URL` being set makes `/mcp` mount
  and enforce its own OAuth check, but whether that path is actually
  *reachable* from the public internet (as a remote MCP connector needs) is
  entirely a function of the operator's own nginx/openresty config, which
  this repo does not manage.

