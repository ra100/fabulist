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
| `docker-compose.yml` | The one service, pinned to `ra100/fabulist:latest`, `/data` as a bind mount to an ordinary directory on the VPS's own disk (`scp`/`rsync`/`ls` work on it directly, no `docker cp` needed) — defaults to `./fabulist-data` next to this file, override with `FABULIST_DATA_DIR` if you want it elsewhere; deliberately relative so this repo never discloses the operator's real host layout — `app.env` as an optional (`required: false`) env file |
| `nginx/fabulist.conf` | Reference openresty/nginx server block — **not necessarily the live config**; the operator manages that directly |
| `vps-setup.sh` | One-time: installs Docker, copies the compose file + `deploy.sh`, starts the app. Does **not** touch openresty or certbot |
| `deploy.sh` | Runs on the VPS, invoked over SSH with a real argument (`deploy/deploy.sh upload-env` / `deploy/deploy.sh deploy`) — **not** an `authorized_keys` forced command (see "Known gaps" below for why, and the security tradeoff that follows from it) |

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

Nothing for a fresh box — `git tag vX.Y.Z && git push --tags` builds+pushes the
Docker image, uploads the rendered `app.env`, and redeploys, end to end.

**One-time, manual, on the existing VPS only**: this deployment originally used a
named Docker volume (`fabulist-data`) instead of the bind mount above. If that
volume already has real world data in it, moving to the bind mount needs one
manual copy before the next `docker compose up -d`, done once, with the container
stopped so nothing is mid-write. Run this from `$DEPLOY_PATH` (wherever
`docker-compose.yml` actually lives on that box), substituting your own
`FABULIST_DATA_DIR` if you set one:

```bash
ssh -p 25 <your-user>@<your-host>
cd <deploy-path>   # wherever this compose file's copy actually lives
docker compose down
target="${FABULIST_DATA_DIR:-./fabulist-data}"
mkdir -p "$target"
docker run --rm \
  -v fabulist-data:/from \
  -v "$(realpath "$target")":/to \
  alpine sh -c 'cp -a /from/. /to/.'
docker compose up -d
# once "$target" looks right (worlds/, fabulist.config.json):
docker volume rm fabulist-data
```

A fresh VPS that has never run the old compose file needs none of this — the
bind-mount directory is created automatically on first `docker compose up -d`.

## Known gaps, called out on purpose

- **The deploy key has no `authorized_keys` restriction.** The original design
  had `deploy.sh` read `$SSH_ORIGINAL_COMMAND` under a forced
  `command="/path/deploy.sh"` entry, so a leaked key could only ever run one
  of two fixed actions. That restriction was never actually added to the
  key's `authorized_keys` line (confirmed directly: `v0.2.0`'s deploy run
  failed with `fish: Unknown command: upload-env` — sshd was running the
  account's own login shell, `fish`, on the raw command string, because
  there was no forced command overriding it). Rather than block the whole
  pipeline on fixing that immediately, `deploy.sh` now takes its action as a
  real `$1` (`deploy/deploy.sh upload-env`), which works under any login
  shell with no `authorized_keys` change required — at the cost that this
  key can currently run *any* SSH command on the box, not just these two.
  To close this gap: add
  `command="/home/ra100/Development/fabulist/deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty`
  before the `ssh-ed25519 ...` on this key's line in `~/.ssh/authorized_keys`,
  then switch `deploy.sh` back to reading `$SSH_ORIGINAL_COMMAND` (git
  history has the exact prior version) and the workflow back to sending bare
  `upload-env`/`deploy` instead of the full path.
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

## Continuous deployment from GitHub Actions

`release.yml`'s `deploy` job, after `docker` publishes a new image:

1. Renders `MCP_OAUTH_ISSUER`/`MCP_OAUTH_AUDIENCE`/`MCP_RESOURCE_URL` from
   repo variables into an `app.env`-shaped stream (skipping any that are
   unset, rather than writing an empty value that `buildMcpAuth()` would
   misread as "configured").
2. Pipes that over SSH, running `<DEPLOY_PATH>/deploy.sh upload-env` on the
   VPS, which writes it to `<DEPLOY_PATH>/app.env` atomically.
   `DEPLOY_PATH` is a repo variable, falling back to
   `/home/ra100/Development/fabulist` if unset.
3. SSHes again to run `<DEPLOY_PATH>/deploy.sh deploy`, which does
   `docker compose pull && up -d`. Compose recreates the container
   automatically because `app.env`'s *contents* changed (confirmed
   directly — this needs no explicit restart step), so the new env vars
   take effect on this same deploy, not the next one.

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

