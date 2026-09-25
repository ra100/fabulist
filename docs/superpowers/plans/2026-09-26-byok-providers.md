# Per-user BYOK Providers (Postgres) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user store their own model-provider API key (encrypted, under a trust mode they choose), have every text-provider call for their requests run on it, and see the tokens spent on their behalf.

**Architecture:** A `ProviderResolver` (Postgres only) turns `(user, storyId)` into a `Registry` per request: the user's usable key, else the shared server registry (if `shareServerProvider` or admin), else mock (so the MCP agent keeps the world, per plan A's `upkeepFor`). Every registry it hands out is wrapped in one metering `Provider` wrapper that writes `usage_events` and scrubs key-shaped strings from errors. `Engine`, `Compactor`, `SetupService` and Pass B take that registry per call; HTTP resolves it in the dispatcher, MCP in `McpToolContext`.

**Tech Stack:** TypeScript on Node >= 26 (type stripping, `erasableSyntaxOnly`), `node --test`, Postgres (`pg`), zod 3, node:crypto AES-256-GCM, browser Web Crypto, React + TanStack Query.

**Spec:** `docs/superpowers/specs/2026-09-26-agent-upkeep-and-byok-design.md` — section B (B1–B6) and its B testing items. Depends on plan A (`docs/superpowers/plans/2026-09-26-agent-upkeep.md`) having landed, specifically `upkeepFor(registry)` in the MCP layer.

## Global Constraints

- Backend: "B = Postgres only". Touch only `*-pg.ts`, Postgres SQL, shared providers/crypto modules and the web client. Non-goal: "BYOK on SQLite".
- Non-goals (verbatim): "Dollar costing; per-field change audit logs; BYOK for image providers; BYOK on SQLite; custom base URLs for non-admins." "Images stay on the server image registry."
- "Plaintext is never stored or returned." "Keys never logged; provider error bodies scrubbed of key-shaped strings before surfacing."
- unlock mode: "the browser wraps the key under the user's master key with the same AES-GCM wrap as story DEKs", AAD `fabulist:user:{uid}:provider:{keyId}:v1`; the in-memory grant lasts "4 h, zeroed on lock/expiry/delete".
- sealed mode: "AES-256-GCM under env `FABULIST_SECRETS_KEY` (32 bytes, base64), AAD bound to user and key id." "If the env var is unset, the mode is disabled in UI and API."
- Endpoints: curated `BYOK_ENDPOINTS` "`{ id, label, kind, baseUrl }` with fixed https base URLs". "Not allowed for non-admins: `aws-profile`, gcloud ADC, Copilot OAuth, local servers, custom base URLs". All except Anthropic use the existing `openai-compat` adapter.
- Resolution order: own usable key → server registry "if config `shareServerProvider` (default `true`, preserves today) or user is admin" → mock-only.
- "Delete removes row and any grant; lock zeroes grants." "Test and save rate-limited per user."
- "Existing `TurnMeta.providerCalls` stays."
- `tsconfig.json` has `erasableSyntaxOnly: true`: no constructor parameter properties, enums or namespaces.
- Code comments: one line, a non-obvious *why* only.
- Commits: Conventional Commits (`AGENTS.md`), one logical change each, only the files the task touched. Branch `feature/agent-upkeep-byok` (already checked out).
- Commands (from `package.json`): single test file `node --disable-warning=ExperimentalWarning --test test/<name>.test.ts`; full suite `pnpm test`; `pnpm typecheck`; `pnpm lint`; `pnpm build:web`.
- Postgres tests: `pnpm pg:start` prints `FABULIST_TEST_PG=...`; export it. Prefix pg test runs with `env FABULIST_REQUIRE_TEST_PG=1` so a missing DB fails instead of silently skipping (`test/pg-harness.ts:48-54`). CI sets `FABULIST_TEST_PG` (`.github/workflows/ci.yml:31`).

## Review Focus

1. **Lock or grant expiry mid-turn** — a registry resolved while unlocked must not send the key after `lock`; the next provider call rejects with `ProviderKeyLockedError` (HTTP 423), nothing further reaches the provider, nothing is committed, and the next request falls back. Pinned in Task 7 (`an unlock-mode key is usable only while its grant is live`) and Task 9 (423 mapping).
2. **Another user's key id** — handing off, reading, deleting, replacing or decrypting with someone else's key id is refused (403 / `null` / `false` / 409 / decrypt failure) and leaves their key intact. Pinned in Task 5, Task 7 (`a user can neither see, unlock, use nor delete another user's key`) and Task 10.
3. **Key-shaped strings in provider errors** — a 401 body echoing `sk-…`, `Bearer …`, `AIza…` or the user's exact key is scrubbed before it reaches HTTP, MCP, logs or the Test result. Pinned in Task 3, Task 6 and Task 7 (`test`).
4. **`FABULIST_SECRETS_KEY` missing or wrong length** — unset disables sealed mode (API 400, `sealedAvailable: false`, existing sealed keys fall back with status `unavailable`); set-but-malformed or not 32 bytes stops boot with a clear error. Pinned in Task 2 and Task 7.
5. **Cache staleness after key delete/replace** — the next request stops using a deleted or replaced key, in-flight registries built from it refuse to send it, and a delete racing a cache fill does not leave the old row cached. Pinned in Task 7 (`deleting or replacing a key…`, `a delete that lands while a cache fill is reading…`).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/db/schema-pg.sql` | modify | DDL for `user_provider_keys`, `usage_events` (fresh installs) |
| `src/db/migrations-pg/010-byok-provider-keys.sql` | create | Same DDL + role grants for existing databases |
| `src/db/schema-pg-roles.sql` | modify | Add both tables to `user_tables` |
| `src/crypto/provider-secret.ts` | create | `FABULIST_SECRETS_KEY` parsing; sealed AES-256-GCM seal/open |
| `src/providers/http.ts` | modify | Export `caps` |
| `src/providers/byok.ts` | create | `BYOK_ENDPOINTS`, per-call-key provider, `scrubSecrets`, `listModels`, `ProviderKeyLockedError` |
| `src/auth/ephemeral-provider-keys.ts` | create | In-memory 4 h grants for unlock-mode keys |
| `web/src/crypto/keys.ts` | modify | `wrapProviderKey`, `providerKeyHandoff` |
| `src/auth/provider-keys-pg.ts` | create | Owner-scoped CRUD for `user_provider_keys` |
| `src/store/usage-pg.ts` | create | `recordUsage`, `usageForUser`, `usageByUser` |
| `src/providers/metered.ts` | create | `MeteredRegistry` wrapper: records usage, scrubs errors |
| `src/providers/resolver-pg.ts` | create | `ProviderResolver`: resolution, cache, grants, save/remove/unlock, test/models, rate limit |
| `src/loop/engine-pg.ts` | modify | Per-call `providers`, `Compactor` per call, `registryFor` |
| `src/loop/history-pg.ts` | modify | Pass `providers` through prose regeneration |
| `src/application/play-pg.ts` | modify | Pass `providers` into `takeTurn` |
| `src/setup/service-pg.ts` | modify | Per-call registry for planner, custom world, Pass B |
| `src/server/http.ts` | modify | `ProviderKeyLockedError` → 423 |
| `src/server/api-pg.ts` | modify | `providerResolver` option, per-request `providers`, key/usage routes, unlock/lock extension |
| `src/server/contracts.ts` | modify | Provider-key body schemas; unlock schema accepts `providerKeys` |
| `src/mcp/tools-pg.ts` | modify | `McpToolContext.providers`, `requestRegistry`, per-call registry at every model-reaching tool, `get_state` usage |
| `src/config/config.ts`, `src/config/service.ts` | modify | `shareServerProvider` config + admin patch |
| `src/cli/serve-pg.ts` | modify | Build the resolver at boot |
| `deploy/deploy.sh`, `.github/workflows/release.yml`, `README.md` | modify | Pass `FABULIST_SECRETS_KEY` through deploy |
| `web/src/api.ts`, `web/src/queries.ts` | modify | Client + hooks for provider key and usage |
| `web/src/my-provider.ts` | create | Pure status/trust copy helpers (node-testable) |
| `web/src/views/MyProviderPanel.tsx` | create | My provider panel, my usage, admin usage |
| `web/src/App.tsx`, `web/src/views/ConfigPanels.tsx` | modify | Unlock handoff, panel wiring, admin toggle |

Tests created: `test/pg-provider-keys.test.ts`, `test/provider-secret.test.ts`, `test/byok.test.ts`, `test/ephemeral-provider-keys.test.ts`, `test/metered.test.ts`, `test/pg-usage.test.ts`, `test/pg-provider-resolver.test.ts`, `test/pg-provider-injection.test.ts`, `test/pg-provider-routing.test.ts`, `test/pg-provider-key-routes.test.ts`, `test/my-provider-presentation.test.ts`. Modified: `test/encryption-keys.test.ts`, `test/config.test.ts`.

---

### Task 1: Schema for provider keys and usage events

**Files:**
- Modify: `src/db/schema-pg.sql` — insert after the `encrypted_story_values` table (ends at line 374), before the `-- Which canon worlds a story reads` comment (line 376)
- Create: `src/db/migrations-pg/010-byok-provider-keys.sql`
- Modify: `src/db/schema-pg-roles.sql:115-121` (the `user_tables` array)
- Test: `test/pg-provider-keys.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: tables `user_provider_keys(id text pk, user_id text unique, label, endpoint_id, models jsonb, trust 'unlock'|'sealed', nonce bytea(12), ciphertext bytea(>16), key_hint text(≤4), created_at, last_used_at)` and `usage_events(id bigserial pk, user_id, story_id text null, role, provider_id, model, key_source 'own'|'server', tokens_in int ≥0, tokens_out int ≥0, at)`, both writable by `fabulist_play`.

Migration number: plan A adds `009-checkpoint-origin.sql`. Use `010` regardless of whether A has merged yet — `applyMigrations` (`src/db/pg.ts:280-320`) iterates files in order, so a gap is harmless.

- [ ] **Step 1: Write the failing test**

Create `test/pg-provider-keys.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPg } from './pg-harness.ts';

const ID1 = '00000000-0000-4000-8000-000000000001';
const ID2 = '00000000-0000-4000-8000-000000000002';

const insertKey = `INSERT INTO user_provider_keys (id, user_id, endpoint_id, models, trust, nonce, ciphertext, key_hint)
                   VALUES ($1, $2, 'openai', '{"narrate":"gpt-test"}', $3, $4, $5, 'abcd')`;

test('provider keys and usage events are writable by the play role and constrained per column', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    await roles.play.query(insertKey, [ID1, 'user:alice', 'sealed', Buffer.alloc(12, 1), Buffer.alloc(40, 2)]);
    await roles.play.query(
      `INSERT INTO usage_events (user_id, story_id, role, provider_id, model, key_source, tokens_in, tokens_out)
       VALUES ('user:alice', NULL, 'narrate', 'openai', 'gpt-test', 'own', 10, 2)`,
    );

    await assert.rejects(
      roles.play.query(insertKey, [ID2, 'user:bob', 'plain', Buffer.alloc(12, 1), Buffer.alloc(40, 2)]),
      /violates check constraint/,
    );
    await assert.rejects(
      roles.play.query(insertKey, [ID2, 'user:alice', 'sealed', Buffer.alloc(12, 1), Buffer.alloc(40, 2)]),
      /duplicate key value/,
      'one key per user',
    );
    await assert.rejects(
      roles.play.query(insertKey, [ID2, 'user:bob', 'sealed', Buffer.alloc(11, 1), Buffer.alloc(40, 2)]),
      /violates check constraint/,
      'a GCM nonce is 12 bytes',
    );
    await assert.rejects(
      roles.play.query(
        `INSERT INTO usage_events (user_id, role, provider_id, model, key_source, tokens_in, tokens_out)
         VALUES ('user:alice', 'narrate', 'openai', 'gpt-test', 'free', 1, 1)`,
      ),
      /violates check constraint/,
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('migration 010 is recorded and grants the play role both tables and the usage sequence', async (t) => {
  const ran = await withPg(async (db) => {
    const { rows } = await db.query<{ name: string }>(`SELECT name FROM migrations WHERE version = 10`);
    assert.deepEqual(rows.map((r) => r.name), ['010-byok-provider-keys.sql']);
    const grants = await db.query<{ ok: boolean }>(
      `SELECT has_table_privilege('fabulist_play', 'user_provider_keys', 'INSERT')
          AND has_table_privilege('fabulist_play', 'usage_events', 'INSERT')
          AND has_sequence_privilege('fabulist_play', 'usage_events_id_seq', 'USAGE') AS ok`,
    );
    assert.equal(grants.rows[0]?.ok, true);
  });
  if (!ran) t.skip('no Postgres configured');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/pg-provider-keys.test.ts`
Expected: FAIL with `relation "user_provider_keys" does not exist`.

- [ ] **Step 3: Write the DDL, migration and grants**

In `src/db/schema-pg.sql`, insert after line 374 (`);` closing `encrypted_story_values`):

```sql

-- A user's own model-provider key. Plaintext never lands here: `unlock` rows hold
-- a browser wrap under the user's master key, `sealed` rows a server wrap under
-- FABULIST_SECRETS_KEY. One key per user; a save replaces the row with a new id.
CREATE TABLE IF NOT EXISTS user_provider_keys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL DEFAULT '',
  endpoint_id   TEXT NOT NULL,
  models        JSONB NOT NULL,
  trust         TEXT NOT NULL CHECK (trust IN ('unlock', 'sealed')),
  nonce         BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext    BYTEA NOT NULL CHECK (octet_length(ciphertext) > 16),
  key_hint      TEXT NOT NULL CHECK (char_length(key_hint) <= 4),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

-- One row per provider call made for a signed-in user. `story_id` has no FK on
-- purpose: spent tokens stay spent when a story is deleted or rolled back.
CREATE TABLE IF NOT EXISTS usage_events (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  story_id     TEXT,
  role         TEXT NOT NULL,
  provider_id  TEXT NOT NULL,
  model        TEXT NOT NULL,
  key_source   TEXT NOT NULL CHECK (key_source IN ('own', 'server')),
  tokens_in    INTEGER NOT NULL CHECK (tokens_in >= 0),
  tokens_out   INTEGER NOT NULL CHECK (tokens_out >= 0),
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_at ON usage_events (user_id, at);
```

Create `src/db/migrations-pg/010-byok-provider-keys.sql`:

```sql
-- Per-user provider keys and the usage they meter. Mirrors schema-pg.sql; the
-- grant block is here because production may never re-run schema-pg-roles.sql.
CREATE TABLE IF NOT EXISTS user_provider_keys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL DEFAULT '',
  endpoint_id   TEXT NOT NULL,
  models        JSONB NOT NULL,
  trust         TEXT NOT NULL CHECK (trust IN ('unlock', 'sealed')),
  nonce         BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext    BYTEA NOT NULL CHECK (octet_length(ciphertext) > 16),
  key_hint      TEXT NOT NULL CHECK (char_length(key_hint) <= 4),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS usage_events (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  story_id     TEXT,
  role         TEXT NOT NULL,
  provider_id  TEXT NOT NULL,
  model        TEXT NOT NULL,
  key_source   TEXT NOT NULL CHECK (key_source IN ('own', 'server')),
  tokens_in    INTEGER NOT NULL CHECK (tokens_in >= 0),
  tokens_out   INTEGER NOT NULL CHECK (tokens_out >= 0),
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_at ON usage_events (user_id, at);

DO $$
DECLARE
  sch TEXT := current_schema();
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['fabulist_play', 'fabulist_ingest'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.user_provider_keys, %I.usage_events TO %I',
        sch, sch, role_name
      );
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I.usage_events_id_seq TO %I', sch, role_name);
    END IF;
  END LOOP;
END
$$;
```

In `src/db/schema-pg-roles.sql`, change the tail of the `user_tables` array (lines 118-121) from:

```sql
    'user_encryption_keys', 'story_encryption_keys',
    'encrypted_story_values', 'chron_entity_blind_indexes',
    'user_private_story_migrations', 'story_private_story_migrations'];
```

to:

```sql
    'user_encryption_keys', 'story_encryption_keys',
    'encrypted_story_values', 'chron_entity_blind_indexes',
    'user_private_story_migrations', 'story_private_story_migrations',
    -- Per-user BYOK keys (ciphertext only) and the usage they meter.
    'user_provider_keys', 'usage_events'];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `env FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/pg-provider-keys.test.ts test/pg-roles.test.ts test/db-migrations.test.ts`
Expected: PASS (`pg-roles.test.ts` asserts every non-system table is play-writable, so it fails if the roles edit is missing).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema-pg.sql src/db/migrations-pg/010-byok-provider-keys.sql src/db/schema-pg-roles.sql test/pg-provider-keys.test.ts
git commit -m "feat(db): add user_provider_keys and usage_events tables"
```

---

### Task 2: Sealed-mode crypto and `FABULIST_SECRETS_KEY`

**Files:**
- Create: `src/crypto/provider-secret.ts`
- Test: `test/provider-secret.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface SealedSecret { nonce: Buffer; ciphertext: Buffer }`
  - `secretsKeyFromEnv(env?: Record<string, string | undefined>): Buffer | null` — `null` when unset/blank, throws when set but not base64 or not 32 bytes
  - `sealProviderKey(secretsKey: Buffer, userId: string, keyId: string, apiKey: string): SealedSecret`
  - `openProviderKey(secretsKey: Buffer, userId: string, keyId: string, sealed: SealedSecret): string` — throws `'sealed provider key cannot be decrypted'`

- [ ] **Step 1: Write the failing test**

Create `test/provider-secret.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { openProviderKey, sealProviderKey, secretsKeyFromEnv } from '../src/crypto/provider-secret.ts';

const secret = Buffer.alloc(32, 7);
const apiKey = 'sk-test-0123456789abcdefghij';

test('a sealed provider key round-trips without its plaintext in the ciphertext', () => {
  const sealed = sealProviderKey(secret, 'user:alice', 'key-1', apiKey);
  assert.equal(sealed.nonce.length, 12);
  assert.equal(sealed.ciphertext.includes(Buffer.from(apiKey)), false);
  assert.equal(openProviderKey(secret, 'user:alice', 'key-1', sealed), apiKey);
});

test('a sealed key is bound to its user, key id and server secret', () => {
  const sealed = sealProviderKey(secret, 'user:alice', 'key-1', apiKey);
  for (const [s, user, id] of [
    [Buffer.alloc(32, 8), 'user:alice', 'key-1'],
    [secret, 'user:bob', 'key-1'],
    [secret, 'user:alice', 'key-2'],
  ] as const) {
    assert.throws(() => openProviderKey(s, user, id, sealed), /sealed provider key cannot be decrypted/);
  }
});

test('FABULIST_SECRETS_KEY unset disables sealing; malformed or wrong length fails loudly', () => {
  assert.equal(secretsKeyFromEnv({}), null);
  assert.equal(secretsKeyFromEnv({ FABULIST_SECRETS_KEY: '  ' }), null);
  assert.deepEqual(secretsKeyFromEnv({ FABULIST_SECRETS_KEY: secret.toString('base64') }), secret);
  assert.throws(
    () => secretsKeyFromEnv({ FABULIST_SECRETS_KEY: Buffer.alloc(16, 1).toString('base64') }),
    /must decode to 32 bytes, got 16/,
  );
  assert.throws(() => secretsKeyFromEnv({ FABULIST_SECRETS_KEY: 'not base64!' }), /must be base64/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test test/provider-secret.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/crypto/provider-secret.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/crypto/provider-secret.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedSecret {
  nonce: Buffer;
  ciphertext: Buffer;
}

/** `null` when unset; throws when set but unusable so a typo cannot silently disable sealed keys. */
export function secretsKeyFromEnv(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.FABULIST_SECRETS_KEY?.trim();
  if (!raw) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error('FABULIST_SECRETS_KEY must be base64');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`FABULIST_SECRETS_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

function aad(userId: string, keyId: string): Buffer {
  return Buffer.from(`fabulist:sealed:user:${userId}:provider:${keyId}:v1`, 'utf8');
}

function assertKey(secretsKey: Buffer): void {
  if (secretsKey.length !== KEY_BYTES) throw new Error('invalid secrets key');
}

export function sealProviderKey(secretsKey: Buffer, userId: string, keyId: string, apiKey: string): SealedSecret {
  assertKey(secretsKey);
  if (!userId || !keyId || !apiKey) throw new Error('incomplete provider key');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', secretsKey, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(userId, keyId));
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { nonce, ciphertext };
}

export function openProviderKey(secretsKey: Buffer, userId: string, keyId: string, sealed: SealedSecret): string {
  assertKey(secretsKey);
  if (sealed.nonce.length !== NONCE_BYTES || sealed.ciphertext.length <= TAG_BYTES) {
    throw new Error('invalid sealed provider key');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', secretsKey, sealed.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(userId, keyId));
    decipher.setAuthTag(sealed.ciphertext.subarray(-TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, -TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('sealed provider key cannot be decrypted');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --test test/provider-secret.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/crypto/provider-secret.ts test/provider-secret.test.ts
git commit -m "feat(crypto): seal provider keys under FABULIST_SECRETS_KEY"
```

---

### Task 3: BYOK endpoint allowlist, per-call-key provider, error scrubbing

**Files:**
- Modify: `src/providers/http.ts:416` — `function caps(` → `export function caps(`
- Create: `src/providers/byok.ts`
- Test: `test/byok.test.ts` (create)

**Interfaces:**
- Consumes: `AnthropicProvider`, `OpenAICompatProvider`, `caps` from `src/providers/http.ts`; `Provider`, `CompletionRequest`, `CompletionResult` from `src/providers/provider.ts`.
- Produces:
  - `interface ByokEndpoint { id: string; label: string; kind: 'openai-compat' | 'anthropic'; baseUrl: string }`
  - `const BYOK_ENDPOINTS: readonly ByokEndpoint[]`; `byokEndpoint(id: string): ByokEndpoint | undefined`
  - `class ProviderKeyLockedError extends Error` (`constructor(message?: string)`)
  - `scrubSecrets(text: string, known?: readonly string[]): string`
  - `byokProvider(endpoint: ByokEndpoint, model: string, secret: () => string, fetcher?: typeof fetch): Provider` — reads `secret()` on every `complete`
  - `listModels(endpoint: ByokEndpoint, apiKey: string, fetcher?: typeof fetch): Promise<string[]>` — `[]` on any failure (UI falls back to free text)

Endpoint base URLs (verified 2026-09-26 against the linked official docs; DeepSeek's docs site was blocked by the planning network):

| id | label | kind | baseUrl | Verified from | Status |
|---|---|---|---|---|---|
| `openai` | OpenAI | openai-compat | `https://api.openai.com/v1` | https://platform.openai.com/docs/api-reference/models/list | verified |
| `anthropic` | Anthropic | anthropic | `https://api.anthropic.com` (adapter appends `/v1/messages`) | https://docs.anthropic.com/en/api/messages , https://docs.anthropic.com/en/api/models-list | verified |
| `gemini` | Google Gemini | openai-compat | `https://generativelanguage.googleapis.com/v1beta/openai` | https://ai.google.dev/gemini-api/docs/openai | verified |
| `mistral` | Mistral | openai-compat | `https://api.mistral.ai/v1` | https://docs.mistral.ai/api/ | verified |
| `deepseek` | DeepSeek | openai-compat | `https://api.deepseek.com/v1` | https://api-docs.deepseek.com/ | VERIFY (matches existing `PRESETS['deepseek:chat']`, `src/providers/http.ts`) |
| `xai` | xAI | openai-compat | `https://api.x.ai/v1` | https://docs.x.ai/docs/quickstart | verified |
| `groq` | Groq | openai-compat | `https://api.groq.com/openai/v1` | https://console.groq.com/docs/openai | verified |
| `cerebras` | Cerebras | openai-compat | `https://api.cerebras.ai/v1` | https://inference-docs.cerebras.ai/api-reference/chat-completions | verified |
| `together` | Together | openai-compat | `https://api.together.ai/v1` | https://docs.together.ai/reference/chat-completions | verified |
| `fireworks` | Fireworks | openai-compat | `https://api.fireworks.ai/inference/v1` | https://docs.fireworks.ai/api-reference/post-chatcompletions | verified |
| `openrouter` | OpenRouter | openai-compat | `https://openrouter.ai/api/v1` | https://openrouter.ai/docs/models | verified |
| `kilo` | Kilo Code | openai-compat | `https://api.kilo.ai/api/gateway` | https://kilo.ai/docs/gateway | verified |

- [ ] **Step 1: Re-check the endpoint table**

Open each "Verified from" URL above and confirm the base URL (the prefix before `/chat/completions`, or `/v1/messages` for Anthropic) is unchanged. Resolve the DeepSeek `VERIFY` row from https://api-docs.deepseek.com/ (its "Your First API Call" page names the base URL; `/v1` is documented as an accepted alias). If any URL differs, use the documented one in Step 4 and in this table. No code yet.

- [ ] **Step 2: Write the failing test**

Create `test/byok.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BYOK_ENDPOINTS,
  ProviderKeyLockedError,
  byokEndpoint,
  byokProvider,
  listModels,
  scrubSecrets,
} from '../src/providers/byok.ts';
import type { CompletionRequest } from '../src/providers/provider.ts';

const ask: CompletionRequest = { role: 'narrate', messages: [{ role: 'user', content: 'hello' }] };

function spyFetch(status: number, body: unknown, text = '') {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    seen.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string> });
    return { ok: status < 400, status, json: async () => body, text: async () => text } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

test('the allowlist is exactly the spec providers, all fixed https bases, only Anthropic native', () => {
  assert.deepEqual(
    BYOK_ENDPOINTS.map((e) => e.id),
    ['openai', 'anthropic', 'gemini', 'mistral', 'deepseek', 'xai', 'groq', 'cerebras', 'together', 'fireworks', 'openrouter', 'kilo'],
  );
  for (const e of BYOK_ENDPOINTS) {
    assert.match(e.baseUrl, /^https:\/\/[a-z0-9.-]+\.[a-z]+(\/[\w./-]*)?$/, e.id);
    assert.equal(e.baseUrl.endsWith('/'), false, e.id);
    assert.equal(e.kind, e.id === 'anthropic' ? 'anthropic' : 'openai-compat', e.id);
  }
  assert.equal(byokEndpoint('localhost'), undefined);
});

test('an openai-compatible key is read per call and sent as a bearer token to the fixed base', async () => {
  const { fetcher, seen } = spyFetch(200, { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
  let key = 'sk-first-0123456789abcdef';
  const provider = byokProvider(byokEndpoint('groq')!, 'llama-test', () => key, fetcher);
  const result = await provider.complete(ask);
  key = 'sk-second-0123456789abcdef';
  await provider.complete(ask);
  assert.equal(provider.id, 'groq');
  assert.equal(result.tokensIn, 3);
  assert.equal(seen[0]?.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(seen[0]?.headers.authorization, 'Bearer sk-first-0123456789abcdef');
  assert.equal(seen[1]?.headers.authorization, 'Bearer sk-second-0123456789abcdef');
});

test('an Anthropic key goes in x-api-key to the Messages API', async () => {
  const { fetcher, seen } = spyFetch(200, { content: [{ text: 'hi' }], usage: { input_tokens: 4, output_tokens: 2 } });
  const provider = byokProvider(byokEndpoint('anthropic')!, 'claude-test', () => 'sk-ant-0123456789abcdef', fetcher);
  assert.equal((await provider.complete(ask)).tokensOut, 2);
  assert.equal(seen[0]?.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0]?.headers['x-api-key'], 'sk-ant-0123456789abcdef');
});

test('a provider error body echoing the key is scrubbed before it surfaces', async () => {
  const key = 'zz-custom-secret-value-42';
  const { fetcher } = spyFetch(401, {}, `{"error":"invalid key ${key}","hint":"Bearer ${key}","other":"sk-proj-abcdefghijklmnop1234"}`);
  const provider = byokProvider(byokEndpoint('openai')!, 'gpt-test', () => key, fetcher);
  await assert.rejects(provider.complete(ask), (err: Error) => {
    assert.doesNotMatch(err.message, /zz-custom-secret-value-42|sk-proj-/);
    assert.match(err.message, /returned 401/);
    return true;
  });
});

test('a locked key never reaches the network and keeps its error type', async () => {
  const { fetcher, seen } = spyFetch(200, {});
  const provider = byokProvider(byokEndpoint('openai')!, 'gpt-test', () => {
    throw new ProviderKeyLockedError();
  }, fetcher);
  await assert.rejects(provider.complete(ask), ProviderKeyLockedError);
  assert.equal(seen.length, 0);
});

test('scrubbing keeps ordinary text and removes exact and key-shaped secrets', () => {
  assert.equal(scrubSecrets('model gpt-4o-mini not found'), 'model gpt-4o-mini not found');
  const out = scrubSecrets(
    'bad my-weird-custom-secret-1 AIzaSyA1234567890abcdefghijklmnopq xai-abcdefghijklmnopqrstu',
    ['my-weird-custom-secret-1'],
  );
  assert.doesNotMatch(out, /my-weird-custom-secret-1|AIza|xai-abc/);
});

test('model listing returns sorted ids and degrades to an empty list', async () => {
  const ok = spyFetch(200, { data: [{ id: 'm-b' }, { id: 'm-a' }, { id: 7 }] });
  assert.deepEqual(await listModels(byokEndpoint('openrouter')!, 'sk-or-0123456789abcdef', ok.fetcher), ['m-a', 'm-b']);
  assert.equal(ok.seen[0]?.url, 'https://openrouter.ai/api/v1/models');
  const anthropic = spyFetch(200, { data: [{ id: 'claude-x' }] });
  await listModels(byokEndpoint('anthropic')!, 'sk-ant-0123456789abcdef', anthropic.fetcher);
  assert.equal(anthropic.seen[0]?.url, 'https://api.anthropic.com/v1/models');
  assert.deepEqual(await listModels(byokEndpoint('openai')!, 'bad', spyFetch(401, {}).fetcher), []);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test test/byok.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/providers/byok.ts`.

- [ ] **Step 4: Write minimal implementation**

In `src/providers/http.ts:416` change `function caps(over: Partial<ProviderCapabilities> = {}): ProviderCapabilities {` to `export function caps(over: Partial<ProviderCapabilities> = {}): ProviderCapabilities {`.

Create `src/providers/byok.ts`:

```ts
import { AnthropicProvider, OpenAICompatProvider, caps } from './http.ts';
import type { CompletionRequest, CompletionResult, Provider } from './provider.ts';

export interface ByokEndpoint {
  id: string;
  label: string;
  kind: 'openai-compat' | 'anthropic';
  baseUrl: string;
}

/** Fixed hosts only: a user-supplied base URL would let a key holder make this server fetch anything (SSRF). */
export const BYOK_ENDPOINTS: readonly ByokEndpoint[] = [
  { id: 'openai', label: 'OpenAI', kind: 'openai-compat', baseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { id: 'gemini', label: 'Google Gemini', kind: 'openai-compat', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'mistral', label: 'Mistral', kind: 'openai-compat', baseUrl: 'https://api.mistral.ai/v1' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai-compat', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'xai', label: 'xAI', kind: 'openai-compat', baseUrl: 'https://api.x.ai/v1' },
  { id: 'groq', label: 'Groq', kind: 'openai-compat', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'cerebras', label: 'Cerebras', kind: 'openai-compat', baseUrl: 'https://api.cerebras.ai/v1' },
  { id: 'together', label: 'Together', kind: 'openai-compat', baseUrl: 'https://api.together.ai/v1' },
  { id: 'fireworks', label: 'Fireworks', kind: 'openai-compat', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'kilo', label: 'Kilo Code', kind: 'openai-compat', baseUrl: 'https://api.kilo.ai/api/gateway' },
];

export function byokEndpoint(id: string): ByokEndpoint | undefined {
  return BYOK_ENDPOINTS.find((e) => e.id === id);
}

export class ProviderKeyLockedError extends Error {
  constructor(message = 'your provider key is locked; unlock private storage to use it') {
    super(message);
    this.name = 'ProviderKeyLockedError';
  }
}

const KEY_SHAPES: readonly RegExp[] = [
  /\bBearer\s+[^\s"',}]+/gi,
  /\b(?:sk|pk|rk|gsk|xai|fw|csk|key)[-_][A-Za-z0-9_-]{12,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];

/** Removes `known` secrets and anything shaped like an API key from provider error text. */
export function scrubSecrets(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const secret of known) if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  for (const shape of KEY_SHAPES) out = out.replace(shape, '[redacted]');
  return out;
}

export function byokProvider(endpoint: ByokEndpoint, model: string, secret: () => string, fetcher?: typeof fetch): Provider {
  const capabilities = caps({ structuredOutput: endpoint.id === 'openai' ? 'native-schema' : 'none' });
  return {
    id: endpoint.id,
    model,
    capabilities,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      // Read per call, so a lock or delete between two calls of one turn stops the second.
      const apiKey = secret();
      const opts = { apiKey, baseUrl: endpoint.baseUrl, model, capabilities, fetcher };
      const inner = endpoint.kind === 'anthropic' ? new AnthropicProvider(opts) : new OpenAICompatProvider(endpoint.id, opts);
      try {
        return await inner.complete(req);
      } catch (err) {
        throw new Error(scrubSecrets(err instanceof Error ? err.message : String(err), [apiKey]));
      }
    },
  };
}

export async function listModels(endpoint: ByokEndpoint, apiKey: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const anthropic = endpoint.kind === 'anthropic';
  const url = anthropic ? `${endpoint.baseUrl}/v1/models` : `${endpoint.baseUrl}/models`;
  const headers: Record<string, string> = anthropic
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${apiKey}` };
  try {
    const res = await fetcher(url, { headers, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
      .sort()
      .slice(0, 500);
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --test test/byok.test.ts test/providers.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/providers/http.ts src/providers/byok.ts test/byok.test.ts
git commit -m "feat(providers): add BYOK endpoint allowlist and per-call-key provider"
```

---

### Task 4: Unlock-mode grants (server) and provider-key wrap (browser)

**Files:**
- Create: `src/auth/ephemeral-provider-keys.ts`
- Modify: `web/src/crypto/keys.ts` — add after `storyAad` (line 165) and after `storyKeyHandoff` (line 270)
- Test: `test/ephemeral-provider-keys.test.ts` (create); `test/encryption-keys.test.ts` (append)

**Interfaces:**
- Consumes: private `encrypt`, `decrypt`, `importAesKey`, `VERSION`, `encoder` inside `web/src/crypto/keys.ts`.
- Produces:
  - `interface ProviderKeyGrant { keyId: string; expiresAt: string }`
  - `class EphemeralProviderKeyStore { constructor(now?: () => number, ttlMs?: number); unlock(userId, keyId, apiKey: string): ProviderKeyGrant; get(userId, keyId): string | null; list(userId): ProviderKeyGrant[]; lock(userId): boolean }` — one grant per user, default TTL 4 h
  - browser: `interface ProviderKeyRecord { keyId: string; wrap: EncryptedKeyEnvelope }`, `interface ProviderKeyHandoff { keyId: string; key: string }`, `wrapProviderKey(userId, masterKey: Uint8Array, keyId, apiKey): Promise<EncryptedKeyEnvelope>`, `providerKeyHandoff(userId, masterKey: Uint8Array, records: ProviderKeyRecord[]): Promise<ProviderKeyHandoff[]>` (skips unreadable wraps)

- [ ] **Step 1: Write the failing tests**

Create `test/ephemeral-provider-keys.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { EphemeralProviderKeyStore } from '../src/auth/ephemeral-provider-keys.ts';

test('a provider key grant is memory-only, user- and key-scoped, and expires', () => {
  let now = Date.parse('2026-09-26T10:00:00.000Z');
  const store = new EphemeralProviderKeyStore(() => now, 1_000);
  const grant = store.unlock('user:alice', 'key-1', 'sk-alice-0123456789');
  assert.deepEqual(grant, { keyId: 'key-1', expiresAt: '2026-09-26T10:00:01.000Z' });
  assert.equal(store.get('user:alice', 'key-1'), 'sk-alice-0123456789');
  assert.equal(store.get('user:alice', 'key-2'), null, 'a different key id is not unlocked');
  assert.equal(store.get('user:bob', 'key-1'), null, 'another user never reads it');
  now += 1_000;
  assert.equal(store.get('user:alice', 'key-1'), null);
  assert.deepEqual(store.list('user:alice'), []);
});

test('locking removes only that user\'s grant and a new unlock replaces the old one', () => {
  const store = new EphemeralProviderKeyStore();
  store.unlock('user:alice', 'key-1', 'sk-alice-0123456789');
  store.unlock('user:alice', 'key-2', 'sk-alice-new-0123456789');
  store.unlock('user:bob', 'key-3', 'sk-bob-0123456789');
  assert.equal(store.get('user:alice', 'key-1'), null);
  assert.equal(store.lock('user:alice'), true);
  assert.equal(store.lock('user:alice'), false);
  assert.equal(store.get('user:alice', 'key-2'), null);
  assert.equal(store.get('user:bob', 'key-3'), 'sk-bob-0123456789');
  assert.throws(() => store.unlock('user:bob', 'key-3', ''), /invalid provider key/);
});
```

Append to `test/encryption-keys.test.ts` (and add `providerKeyHandoff, wrapProviderKey` to its import from `../web/src/crypto/keys.ts`):

```ts
test('a provider key wrap round-trips only for the same user and key id', async () => {
  const enrollment = await createEncryptionEnrollment(userId, passphrase, storyIds);
  const unlocked = await unlockWithPassphrase(userId, enrollment.userKey, [], passphrase);
  const apiKey = 'sk-live-provider-secret-0123';
  const wrap = await wrapProviderKey(userId, unlocked.masterKey, 'key-1', apiKey);
  assert.equal(Buffer.from(wrap.ciphertext, 'base64').includes(Buffer.from(apiKey)), false);
  assert.deepEqual(await providerKeyHandoff(userId, unlocked.masterKey, [{ keyId: 'key-1', wrap }]), [
    { keyId: 'key-1', key: apiKey },
  ]);
  assert.deepEqual(await providerKeyHandoff(userId, unlocked.masterKey, [{ keyId: 'key-2', wrap }]), []);
  assert.deepEqual(await providerKeyHandoff('another-user', unlocked.masterKey, [{ keyId: 'key-1', wrap }]), []);
  eraseUnlockedStoryKeys(unlocked);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test test/ephemeral-provider-keys.test.ts test/encryption-keys.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `ephemeral-provider-keys.ts`, and `SyntaxError: The requested module '../web/src/crypto/keys.ts' does not provide an export named 'providerKeyHandoff'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/auth/ephemeral-provider-keys.ts`:

```ts
const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;

export interface ProviderKeyGrant {
  keyId: string;
  expiresAt: string;
}

interface Grant extends ProviderKeyGrant {
  key: Buffer;
  expiresAtMs: number;
}

/** Process-memory-only grants for unlock-mode provider keys, with the same lifetime rules as story-key grants. */
export class EphemeralProviderKeyStore {
  private readonly grants = new Map<string, Grant>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(now: () => number = Date.now, ttlMs = DEFAULT_TTL_MS) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  unlock(userId: string, keyId: string, apiKey: string): ProviderKeyGrant {
    this.prune();
    if (!userId || !keyId || !apiKey) throw new Error('invalid provider key');
    this.lock(userId);
    const expiresAtMs = this.now() + this.ttlMs;
    const expiresAt = new Date(expiresAtMs).toISOString();
    this.grants.set(userId, { keyId, key: Buffer.from(apiKey, 'utf8'), expiresAt, expiresAtMs });
    return { keyId, expiresAt };
  }

  get(userId: string, keyId: string): string | null {
    this.prune();
    const grant = this.grants.get(userId);
    return grant && grant.keyId === keyId ? grant.key.toString('utf8') : null;
  }

  list(userId: string): ProviderKeyGrant[] {
    this.prune();
    const grant = this.grants.get(userId);
    return grant ? [{ keyId: grant.keyId, expiresAt: grant.expiresAt }] : [];
  }

  lock(userId: string): boolean {
    const grant = this.grants.get(userId);
    if (!grant) return false;
    grant.key.fill(0);
    this.grants.delete(userId);
    return true;
  }

  private prune(): void {
    const now = this.now();
    for (const [userId, grant] of this.grants) {
      if (grant.expiresAtMs <= now) {
        grant.key.fill(0);
        this.grants.delete(userId);
      }
    }
  }
}
```

In `web/src/crypto/keys.ts`, add after the `StoryKeyHandoff` interface (line 42):

```ts
export interface ProviderKeyRecord {
  keyId: string;
  wrap: EncryptedKeyEnvelope;
}

export interface ProviderKeyHandoff {
  keyId: string;
  key: string;
}
```

Add after `storyAad` (line 165):

```ts
function providerAad(userId: string, keyId: string): string {
  return `fabulist:user:${userId}:provider:${keyId}:v${VERSION}`;
}
```

Add after `storyKeyHandoff` (line 270):

```ts
/** Wraps a provider API key under the unlocked master key; the server only ever stores the result. */
export async function wrapProviderKey(
  userId: string,
  masterKey: Uint8Array,
  keyId: string,
  apiKey: string,
): Promise<EncryptedKeyEnvelope> {
  if (!keyId || !apiKey) throw new Error('a provider key needs an id and a value');
  return encrypt(await importAesKey(masterKey), encoder.encode(apiKey), providerAad(userId, keyId));
}

/** Unwraps provider keys for the one-request unlock handoff; an unreadable wrap is skipped so story unlock still works. */
export async function providerKeyHandoff(
  userId: string,
  masterKey: Uint8Array,
  records: ProviderKeyRecord[],
): Promise<ProviderKeyHandoff[]> {
  const master = await importAesKey(masterKey);
  const out: ProviderKeyHandoff[] = [];
  for (const record of records) {
    const bytes = await decrypt(master, record.wrap, providerAad(userId, record.keyId)).catch(() => null);
    if (!bytes) continue;
    out.push({ keyId: record.keyId, key: new TextDecoder().decode(bytes) });
    bytes.fill(0);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --test test/ephemeral-provider-keys.test.ts test/encryption-keys.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/ephemeral-provider-keys.ts web/src/crypto/keys.ts test/ephemeral-provider-keys.test.ts test/encryption-keys.test.ts
git commit -m "feat(auth): add unlock-mode provider key grants and browser wrap"
```

---

### Task 5: Owner-scoped provider key store

**Files:**
- Create: `src/auth/provider-keys-pg.ts`
- Test: `test/pg-provider-keys.test.ts` (append)

**Interfaces:**
- Consumes: `Queryable` from `src/db/pg.ts`; table from Task 1.
- Produces:
  - `type ProviderTrust = 'unlock' | 'sealed'`; `interface ProviderModels { narrate: string; mechanics?: string; extract?: string }`
  - `interface ProviderKeyRow { id; userId; label; endpointId; models: ProviderModels; trust: ProviderTrust; nonce: Buffer; ciphertext: Buffer; keyHint: string; createdAt: string; lastUsedAt: string | null }`
  - `type NewProviderKey = Omit<ProviderKeyRow, 'createdAt' | 'lastUsedAt'>`; `type ProviderKeySummary = Omit<ProviderKeyRow, 'userId' | 'nonce' | 'ciphertext'>`
  - `providerKeyFor(db, userId): Promise<ProviderKeyRow | null>`; `saveProviderKey(db, key: NewProviderKey): Promise<void>` (replaces the user's row; PK clash with another user's id raises pg `23505`); `deleteProviderKey(db, userId): Promise<boolean>`; `touchProviderKey(db, userId, keyId): Promise<void>`; `summarizeProviderKey(row): ProviderKeySummary`

Isolation note: the spec says "RLS: owner only". This repo has no row-level security anywhere — per-user isolation is enforced in the application with `owner_user_id` filters (`src/db/schema-pg-roles.sql:94-98`). This module follows that convention: every statement filters by `user_id`.

- [ ] **Step 1: Write the failing test**

Append to `test/pg-provider-keys.test.ts` (add the import at the top):

```ts
import {
  deleteProviderKey,
  providerKeyFor,
  saveProviderKey,
  summarizeProviderKey,
  touchProviderKey,
} from '../src/auth/provider-keys-pg.ts';

const key = (id: string, userId: string) => ({
  id,
  userId,
  label: '',
  endpointId: 'openai',
  models: { narrate: 'gpt-test' },
  trust: 'sealed' as const,
  nonce: Buffer.alloc(12, 1),
  ciphertext: Buffer.alloc(40, 2),
  keyHint: 'abcd',
});

test('the provider key store is owner-scoped and replaces a user\'s key on save', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    await saveProviderKey(roles.play, key(ID1, 'user:alice'));
    await saveProviderKey(roles.play, { ...key(ID2, 'user:alice'), models: { narrate: 'gpt-2', extract: 'gpt-x' } });
    const alice = await providerKeyFor(roles.play, 'user:alice');
    assert.equal(alice?.id, ID2);
    assert.deepEqual(alice?.models, { narrate: 'gpt-2', extract: 'gpt-x' });
    assert.equal(alice?.lastUsedAt, null);
    assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_provider_keys`)).rows[0]?.n, 1);

    assert.equal(await providerKeyFor(roles.play, 'user:bob'), null);
    await assert.rejects(saveProviderKey(roles.play, key(ID2, 'user:bob')), { code: '23505' });
    assert.equal(await deleteProviderKey(roles.play, 'user:bob'), false);
    await touchProviderKey(roles.play, 'user:bob', ID2);
    assert.equal((await providerKeyFor(roles.play, 'user:alice'))?.lastUsedAt, null, 'another user cannot touch it');
    await touchProviderKey(roles.play, 'user:alice', ID2);
    assert.ok((await providerKeyFor(roles.play, 'user:alice'))?.lastUsedAt);

    const summary = summarizeProviderKey(alice!);
    assert.deepEqual(Object.keys(summary).sort(), ['createdAt', 'endpointId', 'id', 'keyHint', 'label', 'lastUsedAt', 'models', 'trust']);
    assert.equal(await deleteProviderKey(roles.play, 'user:alice'), true);
    assert.equal(await providerKeyFor(roles.play, 'user:alice'), null);
  });
  if (!ran) t.skip('no Postgres configured');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/pg-provider-keys.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/auth/provider-keys-pg.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/auth/provider-keys-pg.ts`:

```ts
import type { QueryResultRow } from 'pg';
import type { Queryable } from '../db/pg.ts';

export type ProviderTrust = 'unlock' | 'sealed';

export interface ProviderModels {
  narrate: string;
  mechanics?: string;
  extract?: string;
}

export interface ProviderKeyRow {
  id: string;
  userId: string;
  label: string;
  endpointId: string;
  models: ProviderModels;
  trust: ProviderTrust;
  nonce: Buffer;
  ciphertext: Buffer;
  keyHint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type NewProviderKey = Omit<ProviderKeyRow, 'createdAt' | 'lastUsedAt'>;
export type ProviderKeySummary = Omit<ProviderKeyRow, 'userId' | 'nonce' | 'ciphertext'>;

interface Row extends QueryResultRow {
  id: string;
  user_id: string;
  label: string;
  endpoint_id: string;
  models: ProviderModels;
  trust: ProviderTrust;
  nonce: Buffer;
  ciphertext: Buffer;
  key_hint: string;
  created_at: Date;
  last_used_at: Date | null;
}

function fromRow(r: Row): ProviderKeyRow {
  return {
    id: r.id,
    userId: r.user_id,
    label: r.label,
    endpointId: r.endpoint_id,
    models: r.models,
    trust: r.trust,
    nonce: r.nonce,
    ciphertext: r.ciphertext,
    keyHint: r.key_hint,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
  };
}

// Every statement filters by user_id: this module is the owner-only boundary (the schema has no RLS).
export async function providerKeyFor(db: Queryable, userId: string): Promise<ProviderKeyRow | null> {
  const { rows } = await db.query<Row>(
    `SELECT id, user_id, label, endpoint_id, models, trust, nonce, ciphertext, key_hint, created_at, last_used_at
       FROM user_provider_keys
      WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function saveProviderKey(db: Queryable, key: NewProviderKey): Promise<void> {
  await db.query(
    `INSERT INTO user_provider_keys (id, user_id, label, endpoint_id, models, trust, nonce, ciphertext, key_hint)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     ON CONFLICT (user_id) DO UPDATE SET
       id = EXCLUDED.id, label = EXCLUDED.label, endpoint_id = EXCLUDED.endpoint_id, models = EXCLUDED.models,
       trust = EXCLUDED.trust, nonce = EXCLUDED.nonce, ciphertext = EXCLUDED.ciphertext,
       key_hint = EXCLUDED.key_hint, created_at = now(), last_used_at = NULL`,
    [key.id, key.userId, key.label, key.endpointId, JSON.stringify(key.models), key.trust, key.nonce, key.ciphertext, key.keyHint],
  );
}

export async function deleteProviderKey(db: Queryable, userId: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM user_provider_keys WHERE user_id = $1`, [userId]);
  return (rowCount ?? 0) > 0;
}

export async function touchProviderKey(db: Queryable, userId: string, keyId: string): Promise<void> {
  await db.query(`UPDATE user_provider_keys SET last_used_at = now() WHERE user_id = $1 AND id = $2`, [userId, keyId]);
}

export function summarizeProviderKey(row: ProviderKeyRow): ProviderKeySummary {
  const { userId: _userId, nonce: _nonce, ciphertext: _ciphertext, ...summary } = row;
  return summary;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/pg-provider-keys.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/provider-keys-pg.ts test/pg-provider-keys.test.ts
git commit -m "feat(auth): add owner-scoped provider key store"
```

---

### Task 6: Metering wrapper and usage store

**Files:**
- Create: `src/providers/metered.ts`, `src/store/usage-pg.ts`
- Test: `test/metered.test.ts`, `test/pg-usage.test.ts` (create)

**Interfaces:**
- Consumes: `scrubSecrets`, `ProviderKeyLockedError` (Task 3); `Registry`, `Provider` (`src/providers/provider.ts:73-78,169-172`).
- Produces:
  - `type UsageSink = (call: { role: string; providerId: string; model: string; tokensIn: number; tokensOut: number }) => Promise<void>`
  - `class MeteredRegistry implements Registry { constructor(inner: Registry, sink: UsageSink) }` — keeps `id`/`model`/`capabilities`; skips providers with `id === 'mock'`; sink failures are logged, never thrown; errors other than `ProviderKeyLockedError` are rethrown as `new Error(scrubSecrets(message))`
  - `type KeySource = 'own' | 'server'`; `interface UsageEvent { userId; storyId: string | null; role; providerId; model; keySource: KeySource; tokensIn: number; tokensOut: number }`
  - `recordUsage(db, e: UsageEvent): Promise<void>`
  - `interface UsageRow { day: string; model: string; keySource: KeySource; calls: number; tokensIn: number; tokensOut: number }`; `usageForUser(db, userId, days): Promise<UsageRow[]>` (UTC day, newest first)
  - `interface UserUsageRow { userId: string; keySource: KeySource; calls: number; tokensIn: number; tokensOut: number }`; `usageByUser(db, days): Promise<UserUsageRow[]>` (largest total first)

- [ ] **Step 1: Write the failing tests**

Create `test/metered.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry, type CompletionRequest, type Provider } from '../src/providers/provider.ts';
import { MeteredRegistry, type UsageSink } from '../src/providers/metered.ts';
import { ProviderKeyLockedError } from '../src/providers/byok.ts';

const ask = (role: string): CompletionRequest => ({ role, messages: [{ role: 'user', content: 'hello' }] });

function sink() {
  const seen: Array<Parameters<UsageSink>[0]> = [];
  const fn: UsageSink = async (call) => {
    seen.push(call);
  };
  return { fn, seen };
}

function failing(error: Error): Provider {
  return { id: 'stub', model: 'stub-1', capabilities: new MockProvider().capabilities, complete: async () => { throw error; } };
}

test('every call through a metered registry is recorded with its role, provider and tokens', async () => {
  const { fn, seen } = sink();
  const registry = new MeteredRegistry(new ProviderRegistry(new MockProvider({ id: 'stub' })), fn);
  const result = await registry.get('narrate').complete(ask('narrate'));
  assert.deepEqual(seen, [
    { role: 'narrate', providerId: 'stub', model: result.model, tokensIn: result.tokensIn, tokensOut: result.tokensOut },
  ]);
  assert.equal(registry.get('extract').id, 'stub', 'the wrapper keeps the id upkeep is decided on');
  assert.equal(registry.all().length, 1);
});

test('the deterministic mock is never metered', async () => {
  const { fn, seen } = sink();
  await new MeteredRegistry(new ProviderRegistry(new MockProvider()), fn).get('narrate').complete(ask('narrate'));
  assert.equal(seen.length, 0);
});

test('provider errors are scrubbed of key-shaped strings and a locked key keeps its type', async () => {
  const leaky = new Error('https://api.example.com returned 401: {"auth":"Bearer sk-proj-abcdefghijklmnopqrstuv"}');
  await assert.rejects(
    new MeteredRegistry(new ProviderRegistry(failing(leaky)), sink().fn).get('narrate').complete(ask('narrate')),
    (err: Error) => {
      assert.doesNotMatch(err.message, /sk-proj-/);
      assert.match(err.message, /returned 401/);
      return true;
    },
  );
  await assert.rejects(
    new MeteredRegistry(new ProviderRegistry(failing(new ProviderKeyLockedError())), sink().fn).get('narrate').complete(ask('narrate')),
    ProviderKeyLockedError,
  );
});

test('a failing usage sink never fails the call it measures', async () => {
  const registry = new MeteredRegistry(new ProviderRegistry(new MockProvider({ id: 'stub' })), async () => {
    throw new Error('db down');
  });
  assert.equal(typeof (await registry.get('narrate').complete(ask('narrate'))).text, 'string');
});
```

Create `test/pg-usage.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPg } from './pg-harness.ts';
import { recordUsage, usageByUser, usageForUser } from '../src/store/usage-pg.ts';

test('usage groups a user\'s calls by day, model and key source, and never mixes users', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const base = { storyId: null, role: 'narrate', providerId: 'openai' };
    await recordUsage(roles.play, { ...base, userId: 'user:alice', model: 'gpt-a', keySource: 'own', tokensIn: 10, tokensOut: 2 });
    await recordUsage(roles.play, { ...base, userId: 'user:alice', model: 'gpt-a', keySource: 'own', tokensIn: 5, tokensOut: 1 });
    await recordUsage(roles.play, { ...base, userId: 'user:alice', model: 'srv', keySource: 'server', tokensIn: 3, tokensOut: 3 });
    await recordUsage(roles.play, { ...base, userId: 'user:bob', model: 'gpt-a', keySource: 'own', tokensIn: 100, tokensOut: 100 });
    await recordUsage(roles.play, { ...base, userId: 'user:carol', model: 'gpt-a', keySource: 'own', tokensIn: -5, tokensOut: Number.NaN });
    await db.query(
      `INSERT INTO usage_events (user_id, role, provider_id, model, key_source, tokens_in, tokens_out, at)
       VALUES ('user:alice', 'narrate', 'openai', 'old', 'own', 1, 1, now() - interval '40 days')`,
    );
    const today = new Date().toISOString().slice(0, 10);

    assert.deepEqual(await usageForUser(roles.play, 'user:alice', 30), [
      { day: today, model: 'gpt-a', keySource: 'own', calls: 2, tokensIn: 15, tokensOut: 3 },
      { day: today, model: 'srv', keySource: 'server', calls: 1, tokensIn: 3, tokensOut: 3 },
    ]);
    assert.deepEqual(await usageForUser(roles.play, 'user:carol', 30), [
      { day: today, model: 'gpt-a', keySource: 'own', calls: 1, tokensIn: 0, tokensOut: 0 },
    ]);
    assert.deepEqual((await usageByUser(roles.play, 30)).slice(0, 3), [
      { userId: 'user:bob', keySource: 'own', calls: 1, tokensIn: 100, tokensOut: 100 },
      { userId: 'user:alice', keySource: 'own', calls: 2, tokensIn: 15, tokensOut: 3 },
      { userId: 'user:alice', keySource: 'server', calls: 1, tokensIn: 3, tokensOut: 3 },
    ]);
  });
  if (!ran) t.skip('no Postgres configured');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `env FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/metered.test.ts test/pg-usage.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/providers/metered.ts` and `src/store/usage-pg.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/providers/metered.ts`:

```ts
import { ProviderKeyLockedError, scrubSecrets } from './byok.ts';
import type { CompletionRequest, CompletionResult, Provider, Registry } from './provider.ts';

export type UsageSink = (call: {
  role: string;
  providerId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}) => Promise<void>;

function metered(inner: Provider, sink: UsageSink): Provider {
  return {
    id: inner.id,
    model: inner.model,
    capabilities: inner.capabilities,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      let result: CompletionResult;
      try {
        result = await inner.complete(req);
      } catch (err) {
        if (err instanceof ProviderKeyLockedError) throw err;
        throw new Error(scrubSecrets(err instanceof Error ? err.message : String(err)));
      }
      if (inner.id !== 'mock') {
        await sink({ role: req.role, providerId: inner.id, model: result.model, tokensIn: result.tokensIn, tokensOut: result.tokensOut }).catch(
          (err: unknown) => console.error('[usage] could not record a provider call:', err instanceof Error ? err.message : err),
        );
      }
      return result;
    },
  };
}

/** One wrapper around every provider the resolver hands out, so no call site has to remember to meter. */
export class MeteredRegistry implements Registry {
  private readonly inner: Registry;
  private readonly sink: UsageSink;

  constructor(inner: Registry, sink: UsageSink) {
    this.inner = inner;
    this.sink = sink;
  }

  get(role: string): Provider {
    return metered(this.inner.get(role), this.sink);
  }

  all(): Provider[] {
    return this.inner.all().map((p) => metered(p, this.sink));
  }
}
```

Create `src/store/usage-pg.ts`:

```ts
import type { Queryable } from '../db/pg.ts';

export type KeySource = 'own' | 'server';

export interface UsageEvent {
  userId: string;
  storyId: string | null;
  role: string;
  providerId: string;
  model: string;
  keySource: KeySource;
  tokensIn: number;
  tokensOut: number;
}

export interface UsageRow {
  day: string;
  model: string;
  keySource: KeySource;
  calls: number;
  tokensIn: number;
  tokensOut: number;
}

export interface UserUsageRow {
  userId: string;
  keySource: KeySource;
  calls: number;
  tokensIn: number;
  tokensOut: number;
}

const tokens = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export async function recordUsage(db: Queryable, e: UsageEvent): Promise<void> {
  await db.query(
    `INSERT INTO usage_events (user_id, story_id, role, provider_id, model, key_source, tokens_in, tokens_out)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.userId, e.storyId, e.role, e.providerId, e.model, e.keySource, tokens(e.tokensIn), tokens(e.tokensOut)],
  );
}

export async function usageForUser(db: Queryable, userId: string, days: number): Promise<UsageRow[]> {
  const { rows } = await db.query<{ day: string; model: string; key_source: KeySource; calls: string; tokens_in: string; tokens_out: string }>(
    `SELECT to_char(date_trunc('day', at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, model, key_source,
            count(*) AS calls, sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out
       FROM usage_events
      WHERE user_id = $1 AND at >= now() - make_interval(days => $2::int)
      GROUP BY 1, 2, 3
      ORDER BY 1 DESC, 2, 3`,
    [userId, days],
  );
  return rows.map((r) => ({
    day: r.day,
    model: r.model,
    keySource: r.key_source,
    calls: Number(r.calls),
    tokensIn: Number(r.tokens_in),
    tokensOut: Number(r.tokens_out),
  }));
}

export async function usageByUser(db: Queryable, days: number): Promise<UserUsageRow[]> {
  const { rows } = await db.query<{ user_id: string; key_source: KeySource; calls: string; tokens_in: string; tokens_out: string }>(
    `SELECT user_id, key_source, count(*) AS calls, sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out
       FROM usage_events
      WHERE at >= now() - make_interval(days => $1::int)
      GROUP BY 1, 2
      ORDER BY sum(tokens_in) + sum(tokens_out) DESC, 1, 2`,
    [days],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    keySource: r.key_source,
    calls: Number(r.calls),
    tokensIn: Number(r.tokens_in),
    tokensOut: Number(r.tokens_out),
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `env FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/metered.test.ts test/pg-usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/metered.ts src/store/usage-pg.ts test/metered.test.ts test/pg-usage.test.ts
git commit -m "feat(providers): meter provider calls into usage_events"
```

---

### Task 7: `ProviderResolver`

**Files:**
- Create: `src/providers/resolver-pg.ts`
- Test: `test/pg-provider-resolver.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 2–6 (`sealProviderKey`, `openProviderKey`, `byokEndpoint`, `byokProvider`, `listModels`, `scrubSecrets`, `ProviderKeyLockedError`, `EphemeralProviderKeyStore`, provider-key store, `recordUsage`, `MeteredRegistry`); `MECHANIC_ROLES` (`src/providers/http.ts:782`); `RateLimiter` (`src/server/rate-limit.ts:32`); `SessionUser` (`src/auth/config.ts:452`).
- Produces:
  - `type ProviderStatus = 'own' | 'locked' | 'unavailable' | 'server' | 'none'`
  - `type SaveProviderKeyInput = { id; label; endpointId; models: ProviderModels; trust: 'sealed'; key: string } | { id; label; endpointId; models; trust: 'unlock'; wrap: { nonce: string; ciphertext: string }; keyHint: string }`
  - `class ProviderKeyInputError extends Error`, `class ProviderKeyForbiddenError extends Error`
  - `interface ProviderResolverOptions { db: Queryable; server: Registry; shareServerProvider: () => boolean; secretsKey: Buffer | null; grants?: EphemeralProviderKeyStore; fetcher?: typeof fetch; keyCallLimit?: { burst: number; perMinute: number } }`
  - `class ProviderResolver` with: `readonly grants`; `get sealedAvailable(): boolean`; `forRequest(user: SessionUser | null, storyId?: string): Promise<Registry>`; `status(user): Promise<ProviderStatus>`; `summary(user): Promise<ProviderKeySummary | null>`; `unlockRecord(user): Promise<{ keyId: string; wrap: { nonce: string; ciphertext: string } } | null>`; `save(user, input: SaveProviderKeyInput): Promise<ProviderKeySummary>`; `remove(user): Promise<boolean>`; `lock(userId): boolean`; `unlock(user, handoff: Array<{ keyId: string; key: string }>): Promise<ProviderKeyGrant[]>`; `test(user, { endpointId, model, key }): Promise<{ ok: true; model: string } | { ok: false; error: string }>`; `models({ endpointId, key }): Promise<string[]>`; `takeKeyCall(userId): number | null`; `invalidate(userId): void`

"Key version" (spec B3 cache key): every save gets a new UUID, so `(user, key id)` already versions the cache; there is no separate version column.

- [ ] **Step 1: Write the failing test**

Create `test/pg-provider-resolver.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPg } from './pg-harness.ts';
import { sessionUser } from './signed-in.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry, type CompletionRequest } from '../src/providers/provider.ts';
import { ProviderKeyLockedError } from '../src/providers/byok.ts';
import { EphemeralProviderKeyStore } from '../src/auth/ephemeral-provider-keys.ts';
import {
  ProviderKeyForbiddenError,
  ProviderKeyInputError,
  ProviderResolver,
  type ProviderResolverOptions,
} from '../src/providers/resolver-pg.ts';
import type { Queryable } from '../src/db/pg.ts';

const SECRET = Buffer.alloc(32, 5);
const ALICE_KEY = 'sk-alice-0123456789abcdefghij';
const models = { narrate: 'gpt-test' };
const keyId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fakeWrap = { nonce: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.alloc(48, 2).toString('base64') };
const alice = sessionUser('alice');
const bob = sessionUser('bob');
const admin = sessionUser('admin');
const ask = (role: string): CompletionRequest => ({ role, messages: [{ role: 'user', content: 'hello' }] });
const sealed = (n: number) => ({ id: keyId(n), label: '', endpointId: 'openai', models, trust: 'sealed' as const, key: ALICE_KEY });
const unlockMode = (n: number) => ({ id: keyId(n), label: '', endpointId: 'openai', models, trust: 'unlock' as const, wrap: fakeWrap, keyHint: 'ghij' });

/** Answers every chat completion; `fail` echoes the key in a 401 body. Records each bearer it saw. */
function stubFetch(fail = false) {
  const bearers: string[] = [];
  const fetcher = (async (_url: string, init: RequestInit = {}) => {
    const auth = String((init.headers as Record<string, string> | undefined)?.authorization ?? '');
    bearers.push(auth);
    return fail
      ? ({ ok: false, status: 401, json: async () => ({}), text: async () => `invalid ${auth}` } as unknown as Response)
      : ({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'ready' } }], usage: { prompt_tokens: 7, completion_tokens: 1 } }),
          text: async () => '',
        } as unknown as Response);
  }) as unknown as typeof fetch;
  return { fetcher, bearers };
}

function resolverFor(db: Queryable, over: Partial<ProviderResolverOptions> = {}, fail = false) {
  const { fetcher, bearers } = stubFetch(fail);
  const resolver = new ProviderResolver({
    db,
    server: new ProviderRegistry(new MockProvider({ id: 'server-stub' })),
    shareServerProvider: () => true,
    secretsKey: SECRET,
    fetcher,
    ...over,
  });
  return { resolver, bearers };
}

test('resolution falls back from the own key to the shared server provider to mock', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    let share = true;
    const { resolver } = resolverFor(roles.play, { shareServerProvider: () => share });
    assert.equal((await resolver.forRequest(null)).get('narrate').id, 'server-stub', 'login-off keeps the server registry');
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'server-stub');
    assert.equal(await resolver.status(alice), 'server');
    share = false;
    assert.equal((await resolver.forRequest(alice)).get('extract').id, 'mock', 'no key and no sharing: the agent keeps the world');
    assert.equal(await resolver.status(alice), 'none');
    assert.equal((await resolver.forRequest(admin)).get('narrate').id, 'server-stub', 'admins always reach the server provider');
    await resolver.save(alice, sealed(1));
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'openai');
    assert.equal(await resolver.status(alice), 'own');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a sealed key reaches the provider and meters as own usage without storing plaintext', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const { resolver, bearers } = resolverFor(roles.play);
    const summary = await resolver.save(alice, sealed(2));
    assert.equal(summary.keyHint, 'ghij');
    assert.equal(JSON.stringify(summary).includes(ALICE_KEY), false);
    const row = await db.one<{ ciphertext: Buffer }>(`SELECT ciphertext FROM user_provider_keys WHERE user_id = $1`, [alice.id]);
    assert.equal(row!.ciphertext.includes(Buffer.from(ALICE_KEY)), false);

    await (await resolver.forRequest(alice, 'story-1')).get('referee').complete(ask('referee'));
    assert.deepEqual(bearers, [`Bearer ${ALICE_KEY}`]);
    const usage = await db.query(`SELECT role, key_source, story_id, tokens_in FROM usage_events WHERE user_id = $1`, [alice.id]);
    assert.deepEqual(usage.rows, [{ role: 'referee', key_source: 'own', story_id: 'story-1', tokens_in: 7 }]);
    const touched = await db.one<{ last_used_at: Date | null }>(`SELECT last_used_at FROM user_provider_keys WHERE user_id = $1`, [alice.id]);
    assert.ok(touched?.last_used_at, 'last_used_at is stamped on use');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('sealed mode is refused without FABULIST_SECRETS_KEY and an existing sealed key falls back', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    await resolverFor(roles.play).resolver.save(alice, sealed(3));
    const { resolver: keyless } = resolverFor(roles.play, { secretsKey: null });
    assert.equal(keyless.sealedAvailable, false);
    await assert.rejects(keyless.save(bob, { ...sealed(4) }), (err: Error) => err instanceof ProviderKeyInputError && /sealed keys are disabled/.test(err.message));
    assert.equal((await keyless.forRequest(alice)).get('narrate').id, 'server-stub');
    assert.equal(await keyless.status(alice), 'unavailable');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('an unlock-mode key is usable only while its grant is live, and a lock mid-turn stops the next call', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    let now = Date.parse('2026-09-26T10:00:00.000Z');
    const { resolver, bearers } = resolverFor(roles.play, { grants: new EphemeralProviderKeyStore(() => now, 60_000) });
    await resolver.save(alice, unlockMode(5));
    assert.equal(await resolver.status(alice), 'locked');
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'server-stub');

    await resolver.unlock(alice, [{ keyId: keyId(5), key: ALICE_KEY }]);
    const midTurn = await resolver.forRequest(alice);
    assert.equal(midTurn.get('narrate').id, 'openai');
    await midTurn.get('classify').complete(ask('classify'));
    resolver.lock(alice.id);
    await assert.rejects(midTurn.get('extract').complete(ask('extract')), ProviderKeyLockedError);
    assert.equal(bearers.length, 1, 'nothing was sent after the lock');
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'server-stub');
    assert.equal(await resolver.status(alice), 'locked');

    await resolver.unlock(alice, [{ keyId: keyId(5), key: ALICE_KEY }]);
    now += 60_000;
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'server-stub', 'an expired grant falls back');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a user can neither see, unlock, use nor delete another user\'s key', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const { resolver } = resolverFor(roles.play);
    await resolver.save(alice, unlockMode(6));
    await assert.rejects(resolver.unlock(bob, [{ keyId: keyId(6), key: 'sk-bob-stolen-0123456789' }]), ProviderKeyForbiddenError);
    assert.equal(await resolver.summary(bob), null);
    assert.equal(await resolver.unlockRecord(bob), null);
    assert.equal((await resolver.forRequest(bob)).get('narrate').id, 'server-stub');
    assert.equal(await resolver.remove(bob), false);
    assert.equal((await resolver.summary(alice))?.id, keyId(6));

    await resolver.save(alice, sealed(7));
    await db.query(
      `INSERT INTO user_provider_keys (id, user_id, endpoint_id, models, trust, nonce, ciphertext, key_hint)
       SELECT $1, $2, endpoint_id, models, trust, nonce, ciphertext, key_hint FROM user_provider_keys WHERE user_id = $3`,
      [keyId(8), bob.id, alice.id],
    );
    resolver.invalidate(bob.id);
    await assert.rejects((await resolver.forRequest(bob)).get('narrate').complete(ask('narrate')), /cannot be decrypted/);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('deleting or replacing a key takes effect on the next request and on in-flight registries', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    const { resolver, bearers } = resolverFor(roles.play);
    await resolver.save(alice, sealed(9));
    const beforeDelete = await resolver.forRequest(alice);
    assert.equal(beforeDelete.get('narrate').id, 'openai');
    assert.equal(await resolver.remove(alice), true);
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'server-stub');
    await assert.rejects(beforeDelete.get('narrate').complete(ask('narrate')), ProviderKeyLockedError);

    await resolver.save(alice, sealed(10));
    const beforeReplace = await resolver.forRequest(alice);
    await resolver.save(alice, { ...sealed(11), key: 'sk-alice-rotated-0123456789' });
    await assert.rejects(beforeReplace.get('narrate').complete(ask('narrate')), ProviderKeyLockedError);
    await (await resolver.forRequest(alice)).get('narrate').complete(ask('narrate'));
    assert.deepEqual(bearers, ['Bearer sk-alice-rotated-0123456789']);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a delete that lands while a cache fill is reading does not leave the old key cached', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    await resolverFor(roles.play).resolver.save(alice, sealed(12));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gated = true;
    const slowDb: Queryable = {
      query: (async (sql: string, params?: unknown[]) => {
        const result = await roles.play.query(sql, params);
        if (gated && sql.includes('FROM user_provider_keys')) {
          gated = false;
          await gate;
        }
        return result;
      }) as Queryable['query'],
    };
    const { resolver } = resolverFor(slowDb);
    const pending = resolver.forRequest(alice);
    while (gated) await new Promise((r) => setTimeout(r, 1));
    await resolver.remove(alice);
    release();
    const stale = await pending;
    await assert.rejects(stale.get('narrate').complete(ask('narrate')), ProviderKeyLockedError);
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'server-stub');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('Test is a metered live call whose failure text never carries the key, and key calls are rate-limited', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const ok = resolverFor(roles.play, { keyCallLimit: { burst: 2, perMinute: 1 } }).resolver;
    assert.deepEqual(await ok.test(alice, { endpointId: 'openai', model: 'gpt-test', key: ALICE_KEY }), { ok: true, model: 'gpt-test' });
    const probe = await db.query(`SELECT role, key_source FROM usage_events WHERE user_id = $1`, [alice.id]);
    assert.deepEqual(probe.rows, [{ role: 'probe', key_source: 'own' }]);
    await assert.rejects(ok.test(alice, { endpointId: 'localhost', model: 'm', key: ALICE_KEY }), ProviderKeyInputError);

    const failing = resolverFor(roles.play, {}, true).resolver;
    const failed = await failing.test(alice, { endpointId: 'openai', model: 'gpt-test', key: ALICE_KEY });
    assert.equal(failed.ok, false);
    assert.equal(JSON.stringify(failed).includes(ALICE_KEY), false);

    assert.equal(ok.takeKeyCall(alice.id), null);
    assert.equal(ok.takeKeyCall(alice.id), null);
    assert.equal(typeof ok.takeKeyCall(alice.id), 'number');
    assert.equal(ok.takeKeyCall(bob.id), null, 'buckets are per user');
  });
  if (!ran) t.skip('no Postgres configured');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/pg-provider-resolver.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/providers/resolver-pg.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/providers/resolver-pg.ts`:

```ts
import type { SessionUser } from '../auth/config.ts';
import { EphemeralProviderKeyStore, type ProviderKeyGrant } from '../auth/ephemeral-provider-keys.ts';
import {
  deleteProviderKey,
  providerKeyFor,
  saveProviderKey,
  summarizeProviderKey,
  touchProviderKey,
  type ProviderKeyRow,
  type ProviderKeySummary,
  type ProviderModels,
} from '../auth/provider-keys-pg.ts';
import { openProviderKey, sealProviderKey } from '../crypto/provider-secret.ts';
import type { Queryable } from '../db/pg.ts';
import { RateLimiter } from '../server/rate-limit.ts';
import { recordUsage, type KeySource } from '../store/usage-pg.ts';
import { byokEndpoint, byokProvider, listModels, ProviderKeyLockedError, scrubSecrets } from './byok.ts';
import { MECHANIC_ROLES } from './http.ts';
import { MeteredRegistry, type UsageSink } from './metered.ts';
import { MockProvider } from './mock.ts';
import { ProviderRegistry, type Registry } from './provider.ts';

export type ProviderStatus = 'own' | 'locked' | 'unavailable' | 'server' | 'none';

interface KeyBase {
  id: string;
  label: string;
  endpointId: string;
  models: ProviderModels;
}

export type SaveProviderKeyInput =
  | (KeyBase & { trust: 'sealed'; key: string })
  | (KeyBase & { trust: 'unlock'; wrap: { nonce: string; ciphertext: string }; keyHint: string });

export class ProviderKeyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderKeyInputError';
  }
}

export class ProviderKeyForbiddenError extends Error {
  constructor() {
    super('can only unlock your own provider key');
    this.name = 'ProviderKeyForbiddenError';
  }
}

export interface ProviderResolverOptions {
  db: Queryable;
  server: Registry;
  shareServerProvider: () => boolean;
  secretsKey: Buffer | null;
  grants?: EphemeralProviderKeyStore;
  fetcher?: typeof fetch;
  keyCallLimit?: { burst: number; perMinute: number };
}

interface Cached {
  row: ProviderKeyRow | null;
  registry: Registry | null;
}

type Resolution = { registry: Registry; source: 'own' | 'server' | 'none'; row: ProviderKeyRow | null };

export class ProviderResolver {
  readonly grants: EphemeralProviderKeyStore;
  private readonly db: Queryable;
  private readonly server: Registry;
  private readonly share: () => boolean;
  private readonly secretsKey: Buffer | null;
  private readonly fetcher: typeof fetch | undefined;
  private readonly keyCalls: RateLimiter;
  private readonly cache = new Map<string, Cached>();
  private readonly generation = new Map<string, number>();

  constructor(opts: ProviderResolverOptions) {
    this.db = opts.db;
    this.server = opts.server;
    this.share = opts.shareServerProvider;
    this.secretsKey = opts.secretsKey;
    this.grants = opts.grants ?? new EphemeralProviderKeyStore();
    this.fetcher = opts.fetcher;
    this.keyCalls = new RateLimiter(opts.keyCallLimit?.burst ?? 5, opts.keyCallLimit?.perMinute ?? 5);
  }

  get sealedAvailable(): boolean {
    return this.secretsKey !== null;
  }

  async forRequest(user: SessionUser | null, storyId?: string): Promise<Registry> {
    return (await this.resolve(user, storyId)).registry;
  }

  async status(user: SessionUser): Promise<ProviderStatus> {
    const { source, row } = await this.resolve(user);
    if (source === 'own' || !row) return source;
    return row.trust === 'unlock' ? 'locked' : 'unavailable';
  }

  async summary(user: SessionUser): Promise<ProviderKeySummary | null> {
    const { row } = await this.cached(user.id);
    return row ? summarizeProviderKey(row) : null;
  }

  async unlockRecord(user: SessionUser): Promise<{ keyId: string; wrap: { nonce: string; ciphertext: string } } | null> {
    const { row } = await this.cached(user.id);
    if (row?.trust !== 'unlock') return null;
    return { keyId: row.id, wrap: { nonce: row.nonce.toString('base64'), ciphertext: row.ciphertext.toString('base64') } };
  }

  async save(user: SessionUser, input: SaveProviderKeyInput): Promise<ProviderKeySummary> {
    if (!byokEndpoint(input.endpointId)) throw new ProviderKeyInputError('that provider endpoint is not allowed');
    let wrapped: { nonce: Buffer; ciphertext: Buffer };
    let keyHint: string;
    if (input.trust === 'sealed') {
      if (!this.secretsKey) throw new ProviderKeyInputError('sealed keys are disabled on this server');
      wrapped = sealProviderKey(this.secretsKey, user.id, input.id, input.key);
      keyHint = input.key.slice(-4);
    } else {
      wrapped = { nonce: Buffer.from(input.wrap.nonce, 'base64'), ciphertext: Buffer.from(input.wrap.ciphertext, 'base64') };
      if (wrapped.nonce.length !== 12 || wrapped.ciphertext.length <= 16) throw new ProviderKeyInputError('invalid provider key wrap');
      keyHint = input.keyHint;
    }
    this.grants.lock(user.id);
    this.invalidate(user.id);
    await saveProviderKey(this.db, {
      id: input.id,
      userId: user.id,
      label: input.label,
      endpointId: input.endpointId,
      models: input.models,
      trust: input.trust,
      keyHint,
      ...wrapped,
    });
    this.invalidate(user.id);
    const saved = await this.summary(user);
    if (!saved) throw new Error('provider key was not saved');
    return saved;
  }

  async remove(user: SessionUser): Promise<boolean> {
    this.grants.lock(user.id);
    this.invalidate(user.id);
    const removed = await deleteProviderKey(this.db, user.id);
    this.invalidate(user.id);
    return removed;
  }

  lock(userId: string): boolean {
    return this.grants.lock(userId);
  }

  async unlock(user: SessionUser, handoff: Array<{ keyId: string; key: string }>): Promise<ProviderKeyGrant[]> {
    const [first, ...rest] = handoff;
    if (!first) return [];
    const { row } = await this.cached(user.id);
    if (rest.length || row?.trust !== 'unlock' || row.id !== first.keyId) throw new ProviderKeyForbiddenError();
    return [this.grants.unlock(user.id, row.id, first.key)];
  }

  async test(
    user: SessionUser,
    input: { endpointId: string; model: string; key: string },
  ): Promise<{ ok: true; model: string } | { ok: false; error: string }> {
    const endpoint = byokEndpoint(input.endpointId);
    if (!endpoint) throw new ProviderKeyInputError('that provider endpoint is not allowed');
    const probe = new MeteredRegistry(
      new ProviderRegistry(byokProvider(endpoint, input.model, () => input.key, this.fetcher)),
      this.sink(user.id, undefined, 'own'),
    ).get('probe');
    try {
      const result = await probe.complete({
        role: 'probe',
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        maxTokens: 8,
        temperature: 0,
      });
      return { ok: true, model: result.model };
    } catch (err) {
      return { ok: false, error: scrubSecrets(err instanceof Error ? err.message : String(err), [input.key]) };
    }
  }

  async models(input: { endpointId: string; key: string }): Promise<string[]> {
    const endpoint = byokEndpoint(input.endpointId);
    if (!endpoint) throw new ProviderKeyInputError('that provider endpoint is not allowed');
    return listModels(endpoint, input.key, this.fetcher);
  }

  takeKeyCall(userId: string): number | null {
    return this.keyCalls.take(userId);
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
    this.generation.set(userId, (this.generation.get(userId) ?? 0) + 1);
  }

  private async resolve(user: SessionUser | null, storyId?: string): Promise<Resolution> {
    if (!user) return { registry: this.server, source: 'server', row: null };
    const own = await this.cached(user.id);
    if (own.row && own.registry && this.usable(user.id, own.row)) {
      return { registry: new MeteredRegistry(own.registry, this.sink(user.id, storyId, 'own', own.row.id)), source: 'own', row: own.row };
    }
    if (this.share() || user.isAdmin) {
      return { registry: new MeteredRegistry(this.server, this.sink(user.id, storyId, 'server')), source: 'server', row: own.row };
    }
    return { registry: new ProviderRegistry(new MockProvider()), source: 'none', row: own.row };
  }

  private usable(userId: string, row: ProviderKeyRow): boolean {
    return row.trust === 'sealed' ? this.secretsKey !== null : this.grants.get(userId, row.id) !== null;
  }

  private async cached(userId: string): Promise<Cached> {
    const hit = this.cache.get(userId);
    if (hit) return hit;
    const before = this.generation.get(userId) ?? 0;
    const row = await providerKeyFor(this.db, userId);
    const entry: Cached = { row, registry: row ? this.build(userId, row) : null };
    // A save or delete that landed during this read wins; caching the older row would outlive it.
    // ponytail: one entry per user, never evicted; add an LRU if the user count makes it matter.
    if ((this.generation.get(userId) ?? 0) === before) this.cache.set(userId, entry);
    return entry;
  }

  private build(userId: string, row: ProviderKeyRow): Registry | null {
    const endpoint = byokEndpoint(row.endpointId);
    if (!endpoint) return null;
    const secret = (): string => {
      // The cache entry is the liveness check, so a key deleted or replaced mid-turn is never sent again.
      if (this.cache.get(userId)?.row?.id !== row.id) throw new ProviderKeyLockedError('your provider key was removed or replaced');
      if (row.trust === 'sealed') {
        if (!this.secretsKey) throw new ProviderKeyLockedError('sealed provider keys are disabled on this server');
        return openProviderKey(this.secretsKey, userId, row.id, row);
      }
      const key = this.grants.get(userId, row.id);
      if (key === null) throw new ProviderKeyLockedError();
      return key;
    };
    const provider = (model: string) => byokProvider(endpoint, model, secret, this.fetcher);
    const registry = new ProviderRegistry(provider(row.models.narrate));
    const mechanic = provider(row.models.mechanics ?? row.models.narrate);
    for (const role of MECHANIC_ROLES) registry.route(role, mechanic);
    const extractor = provider(row.models.extract ?? row.models.narrate);
    registry.route('extract', extractor);
    registry.route('passb', extractor);
    return registry;
  }

  private sink(userId: string, storyId: string | undefined, keySource: KeySource, keyId?: string): UsageSink {
    return async (call) => {
      await recordUsage(this.db, { userId, storyId: storyId ?? null, keySource, ...call });
      if (keyId) await touchProviderKey(this.db, userId, keyId);
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/pg-provider-resolver.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck` — Expected: no errors.

```bash
git add src/providers/resolver-pg.ts test/pg-provider-resolver.test.ts
git commit -m "feat(providers): resolve a per-request registry from the user's key"
```

---

### Task 8: Per-call registries in `Engine`, `Compactor` and `SetupService`

**Files:**
- Modify: `src/loop/engine-pg.ts:125-157` (`TakeTurnOptions`), `:214-241` (fields, constructor), `:243-245` (`compaction`), `:260-285` (`deps`), `:382-391`, `:493-508`, `:519-607` (`finishTurn`), `:643-690` (`commitExternalNarration`), `:699-711` (`renderProseRegeneration`), `:759-766` (`regenerateProse`)
- Modify: `src/loop/history-pg.ts:120-129` (`regenerateProseWithCheckpoint`)
- Modify: `src/application/play-pg.ts:8-29`
- Modify: `src/setup/service-pg.ts:90-94` (`AuthoringTarget`), `:425-432` (`plan`), `:510-549` (`startDiscover`), `:635`, `:682-695` (`runResumablePassB`), `:849-851`, `:940` (`continueIngest`), `:958-973` (`startCustomWorld`)
- Test: `test/pg-provider-injection.test.ts` (create)

**Interfaces:**
- Consumes: `Registry` (`src/providers/provider.ts:169`).
- Produces:
  - `TakeTurnOptions.providers?: Registry`
  - `Engine.registryFor(providers?: Registry): Registry` (plan A's `get registry(): Registry` stays the no-override accessor)
  - `Engine.compaction(providers?: Registry): Compactor` (built per call)
  - `Engine.commitExternalNarration(resumeToken: string, prose: string, worldOverride?: World, agentWorld?: unknown, providers?: Registry)` — `agentWorld` is plan A's 4th parameter
  - `commitNarration(db, engine, world, resumeToken, prose, agentWorld?, providers?: Registry)` (plan A's function in `src/application/play-pg.ts`, gains a 7th parameter)
  - `renderProseRegeneration` / `regenerateProse` opts gain `providers?: Registry`
  - `regenerateProseWithCheckpoint(db, world, engine, turnId, opts: { note?; onToken?; providers?: Registry })`
  - `PlayTurnOptions.providers?: Registry`
  - `AuthoringTarget.providers?: Registry`; `SetupService.plan(wish, wiki, providers?)`; `startDiscover(…, ownerUserId?, providers?)`; `continueIngest(overrides?, providers?)`

- [ ] **Step 1: Write the failing test**

Create `test/pg-provider-injection.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, withPg } from './pg-harness.ts';
import { World, createWorld } from '../src/store/index-pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import { seedWorld } from '../src/seed/verrow-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { SetupService } from '../src/setup/service-pg.ts';
import { regenerateProseWithCheckpoint } from '../src/loop/history-pg.ts';

const roles = (p: MockProvider) => new Set(p.calls.map((c) => c.role));

test('turns, rerolls and compaction run on the registry passed for the call, not the engine default', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'verrow', 'Saint Verrow');
    const story = await createStory(db, { title: 'A story', worldIds: [worldId] });
    const world = await World.forStory(db, story.id);
    await seedWorld(world);
    const fallback = new MockProvider();
    const perCall = new MockProvider({ id: 'per-call' });
    const providers = new ProviderRegistry(perCall);
    const engine = new Engine({ world, db, providers: new ProviderRegistry(fallback) });

    const first = await engine.takeTurn('i warm the ink and keep copying', { world, providers });
    assert.equal(first.kind, 'narrated', JSON.stringify(first).slice(0, 300));
    await engine.takeTurn('i check the door', { world, providers });
    assert.ok(roles(perCall).has('classify') && roles(perCall).has('referee') && roles(perCall).has('extract'));

    const proposed = await engine.takeTurn('i hide the psalter', { world, providers, narrateExternally: true });
    assert.equal(proposed.kind, 'awaiting-narration');
    if (proposed.kind !== 'awaiting-narration') return;
    const extractsBefore = perCall.calls.filter((c) => c.role === 'extract').length;
    await engine.commitExternalNarration(proposed.resumeToken, 'Brother Anselm hides the psalter.', world, undefined, providers);
    assert.ok(perCall.calls.filter((c) => c.role === 'extract').length > extractsBefore);

    if (first.kind === 'narrated') {
      await regenerateProseWithCheckpoint(db, world, engine, first.turn.id, { providers });
    }
    await engine.compaction(providers).summariseScene(world, (await world.session.get()).scene, true);
    assert.ok(roles(perCall).has('summarize'));
    assert.equal(fallback.calls.length, 0, 'the engine default saw no call');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a custom world is invented on the registry in its authoring target', async (t) => {
  const ran = await withPg(async (db) => {
    await createWorld(db, '');
    const story = await createStory(db, { title: '' });
    const fallback = new MockProvider();
    const perCall = new MockProvider({ id: 'per-call' });
    const service = new SetupService({ world: () => World.forStory(db, story.id), db, providers: new ProviderRegistry(fallback) });
    const job = service.startCustomWorld('A city of bell-ringers.', undefined, {
      world: await World.forStory(db, story.id),
      user: null,
      providers: new ProviderRegistry(perCall),
    });
    for (let i = 0; i < 400 && service.jobs.get(job.id)?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(service.jobs.get(job.id)?.status, 'done', service.jobs.get(job.id)?.error ?? '');
    assert.ok(roles(perCall).has('setup'));
    assert.equal(fallback.calls.length, 0);
  });
  if (!ran) t.skip('no Postgres configured');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/pg-provider-injection.test.ts`
Expected: FAIL — the first test at `assert.ok(roles(perCall).has('classify') …)` (the per-call registry is ignored, so every call went to `fallback`), the second at `assert.ok(roles(perCall).has('setup'))`.

- [ ] **Step 3: Implement the engine changes**

In `src/loop/engine-pg.ts`:

(a) In `TakeTurnOptions`, after `world?: World;` (line 156) add:

```ts
  /** This call's text providers (the caller's key, the server's, or mock); omitted uses the engine's own. */
  providers?: Registry;
```

(b) Replace the field `private compactor: Compactor;` (line 221) with `private chapterSize: number | undefined;`, and in the constructor replace

```ts
    this.compactor = new Compactor({
      provider: opts.providers.get('summarize'),
      ...(opts.chapterSize === undefined ? {} : { chapterSize: opts.chapterSize }),
    });
```

with `this.chapterSize = opts.chapterSize;`.

(c) Replace `compaction()` (lines 242-245; plan A put `get registry()` just above it — keep that getter) with:

```ts
  /** The registry a call runs on: the caller's, else this engine's default. */
  registryFor(providers?: Registry): Registry {
    return providers ?? this.registry;
  }

  /** Built per call so a per-request registry, and a live profile swap, reach compaction. */
  compaction(providers?: Registry): Compactor {
    return new Compactor({
      provider: this.registryFor(providers).get('summarize'),
      ...(this.chapterSize === undefined ? {} : { chapterSize: this.chapterSize }),
    });
  }
```

(d) `deps`: add a sixth parameter `providers: Registry` after `frames: Record<string, Frame>,` and delete the line `const providers = this.providers;` (line 267). The body already reads `providers.get(role)`.

(e) `takeTurnOn`: replace `const deps = this.deps(world, session, data, calls, frames);` (line 391) with

```ts
    const providers = this.registryFor(opts.providers);
    const deps = this.deps(world, session, data, calls, frames, providers);
```

and add `providers,` to the `this.finishTurn({ ... })` call at lines 493-508 (after `deps,`).

(f) `finishTurn` args type: add `providers: Registry;` after `deps: RoleDeps;` (line 533). Replace `await this.compactor.onSceneClosed(world, session.scene);` (line 605) with `await this.compaction(args.providers).onSceneClosed(world, session.scene);`.

(g) `commitExternalNarration`: plan A's signature is `(resumeToken: string, prose: string, worldOverride?: World, agentWorld?: unknown)`; append a fifth parameter so it reads `async commitExternalNarration(resumeToken: string, prose: string, worldOverride?: World, agentWorld?: unknown, providers?: Registry): Promise<TurnOutcome> {`; replace `const deps = this.deps(world, session, data, pending.calls, pending.frames);` (line 663) with

```ts
      const registry = this.registryFor(providers);
      const deps = this.deps(world, session, data, pending.calls, pending.frames, registry);
```

and add `providers: registry,` to its `this.finishTurn({ ... })` call (after `deps,`).

(h) `renderProseRegeneration` and `regenerateProse`: change both opts types to `{ note?: string; onToken?: (chunk: string) => void; world?: World; providers?: Registry }`. In `renderProseRegeneration` replace `const deps = this.deps(world, session, data, calls, frames);` (line 711) with `const deps = this.deps(world, session, data, calls, frames, this.registryFor(opts.providers));`. `regenerateProse` already spreads `opts` through.

In `src/loop/history-pg.ts`, add `import type { Registry } from '../providers/provider.ts';` and change the `regenerateProseWithCheckpoint` opts type (line 125) to `opts: { note?: string; onToken?: (chunk: string) => void; providers?: Registry } = {},` — the body already spreads `opts` into `renderProseRegeneration`.

In `src/application/play-pg.ts`, add `import type { Registry } from '../providers/provider.ts';`, add `providers?: Registry;` to `PlayTurnOptions` (after line 11), and add `...(opts.providers ? { providers: opts.providers } : {}),` inside `playTurn`'s `engine.takeTurn(text, { ... })` object (after `overrideIntegrity: options.overrideIntegrity,`). In plan A's `commitNarration(db, engine, world, resumeToken, prose, agentWorld?)`, add a seventh parameter `providers?: Registry` and pass it as the fifth argument: `engine.commitExternalNarration(resumeToken, prose, resolvedWorld, agentWorld, providers)`.

- [ ] **Step 4: Implement the setup changes**

In `src/setup/service-pg.ts`:

(a) `AuthoringTarget` (lines 90-94): add `/** This call's text providers; omitted uses the service's own. */` and `providers?: Registry;` after `user: SessionUser | null;`.

(b) After the constructor (line 390) add:

```ts
  private plannerFor(providers?: Registry): SetupPlanner {
    return providers ? new SetupPlanner(() => providers.get('setup')) : this.planner;
  }
```

(c) `plan` (line 425): add a third parameter `providers?: Registry,` and replace `this.planner.plan(` (line 430) with `this.plannerFor(providers).plan(`.

(d) `startDiscover`: add a ninth parameter `providers?: Registry,` after `ownerUserId?: string,` and replace `this.planner.refineCharacter(` (line 542) with `this.plannerFor(providers).refineCharacter(`.

(e) `runResumablePassB` (line 682): add a sixth parameter `providers: Registry = this.providers,` and replace `provider: this.providers.get('passb'),` (line 693) with `provider: providers.get('passb'),`. In `startIngest` change the call at line 635 to `this.runResumablePassB(world, handle, scoped, spec, wikiName, target?.providers)`.

(f) `continueIngest` (line 849): add a second parameter `providers?: Registry,` and change the call at line 940 to `this.runResumablePassB(world, handle, scoped, spec, wikiName, providers)`.

(g) `startCustomWorld`: replace `const planner = this.planner;` (line 963) with `const planner = this.plannerFor(target?.providers);`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `env FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/pg-provider-injection.test.ts test/pg-engine.test.ts test/pg-compact.test.ts test/pg-worldbuild.test.ts test/pg-services.test.ts`
Expected: PASS. Then `pnpm typecheck` — Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/loop/engine-pg.ts src/loop/history-pg.ts src/application/play-pg.ts src/setup/service-pg.ts test/pg-provider-injection.test.ts
git commit -m "refactor(engine): take the provider registry per call"
```

---

### Task 9: Per-request registry over HTTP and MCP

**Files:**
- Modify: `src/server/http.ts:78-84` (`statusForError`)
- Modify: `src/server/api-pg.ts` — imports (lines 58-80), `ServerOptions` (after line 206), `RouteContext` (after line 244), routes at lines 700, 716, 1241, 1257, 1855, 2092, 2135, 2178, 2199, 2334; `createApiServer` destructuring (lines 2478-2489), `mcpToolContextFor` return (lines 2541-2559), dispatcher (lines 2793-2827)
- Modify: `src/mcp/tools-pg.ts` — `McpToolContext` (lines 47-95), `proposeTurnTool` (594), `commitNarrationTool` (656), override tool (720), `playTool` (756), `regenerateTurnTool` (777), `compactTool` (1069), `closeSceneTool` (1088-1090), `planWorldTool` (1133), discover (1201), `commitIngestTool` (1225-1238), `createCustomWorldTool` (1248-1251), and every plan-A `upkeepFor(` call
- Test: `test/pg-provider-routing.test.ts` (create)

**Interfaces:**
- Consumes: `ProviderResolver.forRequest` (Task 7); per-call options (Task 8); plan A's `Engine.registry` getter, `upkeepFor(registry: Registry)` (`src/mcp/upkeep.ts`), `upkeepOf(ctx)` and the `upkeep` field on `proposeTurnTool`'s result.
- Produces:
  - `ServerOptions.providerResolver?: ProviderResolver`
  - `RouteContext.providers: Registry` (always set) and `RouteContext.providerResolver: ProviderResolver | undefined`
  - `McpToolContext.providers?: (storyId?: string) => Promise<Registry>`
  - `requestRegistry(ctx: McpToolContext, world: World): Promise<Registry>` and `upkeepOf(ctx: McpToolContext): Promise<Upkeep>` (now async) exported from `src/mcp/tools-pg.ts`
  - `statusForError(new ProviderKeyLockedError())` → `423`

- [ ] **Step 1: Write the failing test**

Create `test/pg-provider-routing.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, withPg, type RolePools } from './pg-harness.ts';
import { PEOPLE, fakeAuth, listenSignedIn, sessionUser, type Who } from './signed-in.ts';
import { World, worldFor } from '../src/store/index-pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import { seedWorld } from '../src/seed/verrow-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { ProviderKeyLockedError } from '../src/providers/byok.ts';
import { ProviderResolver } from '../src/providers/resolver-pg.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { createApiServer } from '../src/server/api-pg.ts';
import { statusForError } from '../src/server/http.ts';
import { proposeTurnTool, type McpToolContext } from '../src/mcp/tools-pg.ts';
import type { Db } from '../src/db/pg.ts';

async function seededStory(db: Db, who: Who): Promise<string> {
  const worldId = await makeWorld(db, `verrow-${who}`, 'Saint Verrow');
  const story = await createStory(db, { title: `${who}’s book`, worldIds: [worldId], ownerUserId: PEOPLE[who].id });
  await seedWorld(await World.forStory(db, story.id));
  return story.id;
}

function mcpFor(roles: RolePools, engine: Engine, resolver: ProviderResolver, who: Who, storyId: string): McpToolContext {
  const user = sessionUser(who);
  return {
    world: () => World.forStory(roles.play, storyId),
    db: roles.play,
    user,
    engine,
    dataRoot: 'data',
    providers: (id) => resolver.forRequest(user, id),
  };
}

test('a locked provider key surfaces as 423, the caller\'s own state', () => {
  assert.equal(statusForError(new ProviderKeyLockedError()), 423);
});

test('HTTP turns, scene close and MCP proposals run on the per-request registry and meter as server usage', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const storyId = await seededStory(db, 'alice');
    const fallback = new MockProvider();
    const shared = new MockProvider({ id: 'server-stub' });
    const boot = () => worldFor(roles.play, null);
    const engine = new Engine({ world: boot, db: roles.play, ingestDb: roles.ingest, providers: new ProviderRegistry(fallback) });
    const resolver = new ProviderResolver({ db: roles.play, server: new ProviderRegistry(shared), shareServerProvider: () => true, secretsKey: null });
    const { as, close } = await listenSignedIn(
      createApiServer({ world: boot, db: roles.play, ingestDb: roles.ingest, engine, authConfig: fakeAuth(), providerResolver: resolver }),
    );
    try {
      for (const input of ['i warm the ink and keep copying', 'i check the door']) {
        const played = await as('alice', 'POST', '/api/play', { input });
        assert.equal(played.status, 200, JSON.stringify(played.body));
      }
      assert.equal((await as('alice', 'POST', '/api/scene/close', {})).status, 200);
    } finally {
      await close();
    }
    assert.equal(fallback.calls.length, 0, 'the engine default registry was never used');
    const seen = new Set(shared.calls.map((c) => c.role));
    assert.ok(seen.has('referee') && seen.has('extract') && seen.has('summarize'), [...seen].join(','));
    const metered = await db.query<{ role: string; key_source: string; story_id: string }>(
      `SELECT DISTINCT role, key_source, story_id FROM usage_events WHERE user_id = $1`,
      [PEOPLE.alice.id],
    );
    assert.ok(metered.rows.every((r) => r.key_source === 'server' && r.story_id === storyId));
    assert.ok(metered.rows.some((r) => r.role === 'referee') && metered.rows.some((r) => r.role === 'summarize'));

    const before = shared.calls.length;
    await proposeTurnTool(mcpFor(roles, engine, resolver, 'alice', storyId), { text: 'i trim the wick' });
    assert.ok(shared.calls.length > before, 'MCP propose ran on the resolved registry');
    assert.equal(fallback.calls.length, 0);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('upkeep follows the registry resolved for the request', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const aliceStory = await seededStory(db, 'alice');
    const adminStory = await seededStory(db, 'admin');
    const boot = () => worldFor(roles.play, null);
    const engine = new Engine({ world: boot, db: roles.play, providers: new ProviderRegistry(new MockProvider()) });
    const resolver = new ProviderResolver({
      db: roles.play,
      server: new ProviderRegistry(new MockProvider({ id: 'server-stub' })),
      shareServerProvider: () => false,
      secretsKey: null,
    });
    const agent = await proposeTurnTool(mcpFor(roles, engine, resolver, 'alice', aliceStory), { text: 'i trim the wick' });
    assert.equal(agent.upkeep, 'agent', 'no own key and no sharing: the agent keeps the world');
    const server = await proposeTurnTool(mcpFor(roles, engine, resolver, 'admin', adminStory), { text: 'i trim the wick' });
    assert.equal(server.upkeep, 'server');
  });
  if (!ran) t.skip('no Postgres configured');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/pg-provider-routing.test.ts`
Expected: FAIL — `statusForError` returns 500 instead of 423, and `the engine default registry was never used` fails because `createApiServer` ignores `providerResolver` (Node strips types, so the unknown option does not stop the run).

- [ ] **Step 3: Map the locked error to 423**

In `src/server/http.ts`, import `ProviderKeyLockedError` from `'../providers/byok.ts'` and add as the second line of `statusForError` (after the `HttpError` check, line 79):

```ts
  if (err instanceof ProviderKeyLockedError) return 423;
```

- [ ] **Step 4: Resolve the registry per HTTP request**

In `src/server/api-pg.ts`:

(a) Imports: add `import type { Registry } from '../providers/provider.ts';` (next to the existing `SwappableRegistry` type import, line 58) and `import type { ProviderResolver } from '../providers/resolver-pg.ts';`.

(b) `ServerOptions`: after `paidCallLimit?: PaidCallLimit | null;` (line 206) add:

```ts
  /** Resolves each request's text providers from the signed-in user's own key; absent means the engine's own. */
  providerResolver?: ProviderResolver;
```

(c) `RouteContext`: after `ephemeralStoryKeys: EphemeralStoryKeyStore;` (line 244) add:

```ts
  /** This request's text-provider registry: the caller's own key, the shared server one, or mock. */
  providers: Registry;
  providerResolver: ProviderResolver | undefined;
```

(d) `createApiServer`: add `providerResolver,` to the destructuring at lines 2478-2489. In the dispatcher, after the `assertPrivateStoryMigrationReady` block (ends line 2808) add:

```ts
        const providers = providerResolver ? await providerResolver.forRequest(user, world.storyId) : engine.registry;
```

and add `providers,` and `providerResolver,` to the `match.handler(req, res, { ... })` object (after `ephemeralStoryKeys,`, line 2826).

(e) Routes — add `providers` to each handler's destructuring and pass it:
- `POST /api/turn/:id/regenerate` (line 700): `regenerateProseWithCheckpoint(db, world, engine, id, { ...(note?.trim() ? { note: note.trim() } : {}), providers })`
- `POST /api/play` (line 716): `playTurn(db, engine, world, input, { overrideIntegrity, providers })`
- `POST /api/play/stream` (line 1855): add `providers,` to the `playTurn(db, engine, world, input, { ... })` options
- `POST /api/compact` (line 1241): `const compactor = engine.compaction(providers);`
- `POST /api/scene/close` (line 1257): add `const compactor = engine.compaction(providers);` before `recordAuthoringCheckpoint`, and inside it use `compactor.onSceneClosed(transactionWorld, before.scene)` and `compactor.chapterOf(before.scene + 1)` in place of the two `engine.compaction()` calls
- `POST /api/setup/plan` (line 2092): `svc.plan(wish.trim(), wiki, providers)`
- `POST /api/setup/discover` (line 2135): append `, providers` after `user?.id` in `svc.startDiscover(...)`
- `POST /api/setup/ingest` (line 2178): pass `{ world, user, providers }` as the third argument of `svc.startIngest` (keep `assertMayAuthor({ world, user })`)
- `POST /api/setup/custom` (line 2199): `svc.startCustomWorld(description.trim(), style, { world, user, providers })`
- `POST /api/setup/continue` (line 2334): `svc.continueIngest({ seeds, mode, excludeCategories, limits }, providers)`

(f) `mcpToolContextFor`: in the returned object (after `engine,`, line 2549) add:

```ts
      ...(providerResolver ? { providers: (storyId?: string) => providerResolver.forRequest(user, storyId) } : {}),
```

- [ ] **Step 5: Resolve the registry per MCP call**

In `src/mcp/tools-pg.ts`:

(a) Import `type Registry` from `'../providers/provider.ts'` (and `type World` from `'../store/index-pg.ts'` if not already imported; `Upkeep` comes from plan A's `./upkeep.ts`). In `McpToolContext`, after `chargePaidCall?: () => void;` (line 94) add:

```ts
  /** This connection's text providers (own key, shared server, or mock); absent uses the engine's. */
  providers?: (storyId?: string) => Promise<Registry>;
```

After the interface add:

```ts
export async function requestRegistry(ctx: McpToolContext, world: World): Promise<Registry> {
  return ctx.providers ? ctx.providers(world.storyId) : ctx.engine.registry;
}
```

(b) Pass it at every model-reaching tool (line numbers are pre-plan-A; find by function name):
- `proposeTurnTool`: `const world = await ctx.world();` then `ctx.engine.takeTurn(args.text, { narrateExternally: true, world, providers: await requestRegistry(ctx, world), ...(args.actorId ? { actorId: args.actorId } : {}) })`
- `commitNarrationTool` (plan A routes it through `commitNarration(ctx.db, ctx.engine, world, args.resumeToken, args.prose, agentWorld)`): resolve `const world = await ctx.world();` once and append `await requestRegistry(ctx, world)` as the seventh argument; if a direct `ctx.engine.commitExternalNarration(…, agentWorld)` call remains, append it as the fifth argument there instead
- the override tool at line 720: same as `proposeTurnTool`, keeping `overrideIntegrity: true`
- `playTool`: `playTurn(ctx.db, ctx.engine, world, args.input, { overrideIntegrity: args.overrideIntegrity, providers: await requestRegistry(ctx, world) })`
- `regenerateTurnTool`: add `providers: await requestRegistry(ctx, world),` to the opts
- `compactTool`: `const compactor = ctx.engine.compaction(await requestRegistry(ctx, world));`
- `closeSceneTool`: `const compactor = ctx.engine.compaction(await requestRegistry(ctx, world));` before `recordAuthoringCheckpoint`, then `compactor.onSceneClosed(...)` and `compactor.chapterOf(...)` inside
- `planWorldTool`: `const world = await ctx.world(); return ctx.setup.plan(args.wish.trim(), args.wiki, await requestRegistry(ctx, world));`
- discover tool: `const world = await ctx.world();` and append `await requestRegistry(ctx, world)` after `ctx.user?.id` in `ctx.setup.startDiscover(...)`
- `commitIngestTool` and `createCustomWorldTool`: `const world = await ctx.world(); const target = { world, user: ctx.user ?? null, providers: await requestRegistry(ctx, world) };`

(c) Plan A's upkeep. Plan A declares `upkeepFor(registry: Registry)` in `src/mcp/upkeep.ts` and, in `tools-pg.ts`, `const upkeepOf = (ctx: McpToolContext) => upkeepFor(ctx.engine.registry);` with call sites `upkeep: upkeepOf(ctx),`. Make it per request:

```ts
/** Per request, so upkeep follows the caller's key, lock state and the sharing toggle. */
export const upkeepOf = async (ctx: McpToolContext) => upkeepFor(ctx.providers ? await ctx.providers() : ctx.engine.registry);
```

Then run `graft grep "upkeepOf("` and `graft grep "upkeepFor(ctx.engine.registry"`: every `upkeep: upkeepOf(ctx)` becomes `upkeep: await upkeepOf(ctx)`, and every `upkeepFor(ctx.engine.registry)` in `src/mcp/tools-pg.ts` and `src/mcp/server-pg.ts` (the `play` prompt) becomes `await upkeepOf(ctx)` (import `upkeepOf` from `./tools-pg.ts` in `server-pg.ts`; make the enclosing function `async` if it is not). `MeteredRegistry` implements `Registry`, so `upkeepFor`'s signature needs no change.

- [ ] **Step 6: Run tests to verify they pass**

Run: `env FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/pg-provider-routing.test.ts test/pg-api.test.ts test/pg-tenant-isolation.test.ts test/mcp-tools-pg.test.ts test/pg-roles.test.ts`
Expected: PASS. Then `pnpm typecheck` — Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/http.ts src/server/api-pg.ts src/mcp/tools-pg.ts src/mcp/server-pg.ts test/pg-provider-routing.test.ts
git commit -m "feat(api): resolve the provider registry per HTTP request and MCP call"
```

(Drop `src/mcp/server-pg.ts` from `git add` if Step 5c changed nothing there.)

---

### Task 10: Key-management and usage routes

**Files:**
- Modify: `src/server/contracts.ts:184-192` (unlock schema) — insert provider-key schemas immediately above `export const encryptionUnlockBodySchema`
- Modify: `src/server/api-pg.ts:410-458` (`GET /api/encryption/keys`, `POST /api/encryption/unlock`, `POST /api/encryption/lock`); insert new routes before `route('GET', '/api/state'` (line 489)
- Modify: `src/mcp/tools-pg.ts:313-330` (`getStateTool`)
- Test: `test/pg-provider-key-routes.test.ts` (create); `test/transport-contracts.test.ts` (append)

**Interfaces:**
- Consumes: `ProviderResolver` (Task 7), `ProviderKeyInputError`, `ProviderKeyForbiddenError`, `BYOK_ENDPOINTS`, `usageForUser`, `usageByUser`.
- Produces (HTTP, all 401 without a session, 503 when no resolver):
  - `GET /api/provider-key` → `{ key: ProviderKeySummary | null, status: ProviderStatus, sealedAvailable: boolean, endpoints: Array<{ id, label }> }`
  - `PUT /api/provider-key` body `providerKeyBodySchema` → `{ key, status }`; 400 bad input/endpoint, 409 key id taken, 429 rate limit
  - `DELETE /api/provider-key` → `{ removed: boolean, status }`
  - `POST /api/provider-key/test` body `{ endpointId, model, key }` → `{ ok: true, model } | { ok: false, error }` (rate-limited)
  - `POST /api/provider-key/models` body `{ endpointId, key }` → `{ models: string[] }` (rate-limited)
  - `GET /api/usage?days=N` → `{ days, rows: UsageRow[] }`; `GET /api/admin/usage?days=N` → `{ days, rows: UserUsageRow[] }` (admin only)
  - `POST /api/encryption/unlock` accepts `providerKeys: [{ keyId, key }]` (max 1), returns `{ grants, providerGrants }`; `storyKeys` may be empty when `providerKeys` is not
  - `POST /api/encryption/lock` without `storyId` also locks the provider key; returns `{ lockedStoryIds, providerLocked }`
  - `GET /api/encryption/keys` adds `providerKey: { keyId, wrap } | null`
  - MCP `get_state` adds `myUsage: UsageRow[] | null`

- [ ] **Step 1: Write the failing tests**

Append to `test/transport-contracts.test.ts` (add `providerKeyBodySchema` to its import from `../src/server/contracts.ts`):

```ts
test('provider-key contracts reject custom base URLs and accept a provider-only unlock', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const sealed = { id, endpointId: 'openai', models: { narrate: 'gpt-test' }, trust: 'sealed', key: 'sk-test-0123456789' };
  assert.equal(providerKeyBodySchema.safeParse(sealed).success, true);
  assert.equal(providerKeyBodySchema.safeParse({ ...sealed, baseUrl: 'http://169.254.169.254/v1' }).success, false);
  assert.equal(providerKeyBodySchema.safeParse({ ...sealed, id: 'not-a-uuid' }).success, false);
  assert.equal(providerKeyBodySchema.safeParse({ ...sealed, key: 'has space in it' }).success, false);
  assert.equal(providerKeyBodySchema.safeParse({ ...sealed, models: { narrate: '../../etc' } }).success, false);
  assert.equal(encryptionUnlockBodySchema.safeParse({ providerKeys: [{ keyId: id, key: 'sk-test-0123456789' }] }).success, true);
  assert.equal(encryptionUnlockBodySchema.safeParse({}).success, false, 'nothing to unlock');
});
```

Create `test/pg-provider-key-routes.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, withPg, type RolePools } from './pg-harness.ts';
import { PEOPLE, fakeAuth, listenSignedIn, sessionUser, type AsUser } from './signed-in.ts';
import { World, worldFor } from '../src/store/index-pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { ProviderResolver, type ProviderResolverOptions } from '../src/providers/resolver-pg.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { createApiServer } from '../src/server/api-pg.ts';
import { getStateTool } from '../src/mcp/tools-pg.ts';
import { createEncryptionEnrollment } from '../web/src/crypto/keys.ts';
import type { Db } from '../src/db/pg.ts';

const ALICE_KEY = 'sk-alice-0123456789abcdefghij';
const KEY1 = '00000000-0000-4000-8000-000000000001';
const KEY2 = '00000000-0000-4000-8000-000000000002';
const models = { narrate: 'gpt-test' };
const fakeWrap = { nonce: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.alloc(48, 2).toString('base64') };
type Body = Record<string, unknown>;
const body = (reply: { body: unknown }) => reply.body as Body;

function stubFetch(): typeof fetch {
  return (async (url: string) => {
    const json = String(url).endsWith('/models')
      ? { data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }
      : { choices: [{ message: { content: 'ready' } }], usage: { prompt_tokens: 7, completion_tokens: 1 } };
    return { ok: true, status: 200, json: async () => json, text: async () => '' } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function storiesFor(db: Db): Promise<Record<'alice' | 'bob' | 'admin', string>> {
  const worldId = await makeWorld(db, 'shared');
  const out = {} as Record<'alice' | 'bob' | 'admin', string>;
  for (const who of ['alice', 'bob', 'admin'] as const) {
    out[who] = (await createStory(db, { title: who, worldIds: [worldId], ownerUserId: PEOPLE[who].id })).id;
  }
  return out;
}

async function withKeyServer(
  roles: RolePools,
  fn: (as: AsUser, resolver: ProviderResolver) => Promise<void>,
  over: Partial<ProviderResolverOptions> = {},
): Promise<void> {
  const boot = () => worldFor(roles.play, null);
  const resolver = new ProviderResolver({
    db: roles.play,
    server: new ProviderRegistry(new MockProvider({ id: 'server-stub' })),
    shareServerProvider: () => true,
    secretsKey: Buffer.alloc(32, 5),
    fetcher: stubFetch(),
    keyCallLimit: { burst: 50, perMinute: 60 },
    ...over,
  });
  const engine = new Engine({ world: boot, db: roles.play, ingestDb: roles.ingest, providers: new ProviderRegistry(new MockProvider()) });
  const { as, close } = await listenSignedIn(
    createApiServer({ world: boot, db: roles.play, ingestDb: roles.ingest, engine, authConfig: fakeAuth(), providerResolver: resolver }),
  );
  try {
    await fn(as, resolver);
  } finally {
    await close();
  }
}

test('a sealed key is saved behind an allowlist and only its hint ever comes back', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    await storiesFor(db);
    await withKeyServer(roles, async (as) => {
      const saved = await as('alice', 'PUT', '/api/provider-key', { id: KEY1, endpointId: 'openai', models, trust: 'sealed', key: ALICE_KEY });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(JSON.stringify(saved.body).includes(ALICE_KEY), false);
      const read = body(await as('alice', 'GET', '/api/provider-key'));
      assert.equal((read.key as Body).keyHint, 'ghij');
      assert.equal(read.status, 'own');
      assert.equal(read.sealedAvailable, true);
      assert.equal((read.endpoints as unknown[]).length, 12);
      assert.equal(JSON.stringify(read).includes(ALICE_KEY), false);

      const bad = { id: KEY2, models, trust: 'sealed', key: ALICE_KEY };
      assert.equal((await as('alice', 'PUT', '/api/provider-key', { ...bad, endpointId: 'localhost' })).status, 400);
      assert.equal((await as('alice', 'PUT', '/api/provider-key', { ...bad, endpointId: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' })).status, 400);

      assert.equal(body(await as('bob', 'GET', '/api/provider-key')).key, null);
      assert.equal(body(await as('bob', 'DELETE', '/api/provider-key')).removed, false);
      assert.equal((await as('bob', 'PUT', '/api/provider-key', { ...bad, id: KEY1, endpointId: 'openai' })).status, 409, 'another user\'s key id');
      assert.equal(body(await as('alice', 'GET', '/api/provider-key')).status, 'own', 'Alice\'s key survived Bob');

      const removed = body(await as('alice', 'DELETE', '/api/provider-key'));
      assert.deepEqual(removed, { removed: true, status: 'server' });
    });
    await withKeyServer(roles, async (as) => {
      assert.equal(body(await as('alice', 'GET', '/api/provider-key')).sealedAvailable, false);
      const refused = await as('alice', 'PUT', '/api/provider-key', { id: KEY2, endpointId: 'openai', models, trust: 'sealed', key: ALICE_KEY });
      assert.equal(refused.status, 400);
      assert.match(String(refused.body.error), /sealed keys are disabled/);
    }, { secretsKey: null });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('an unlock-mode key is granted by the unlock handoff and revoked by lock, only for its owner', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const stories = await storiesFor(db);
    await withKeyServer(roles, async (as, resolver) => {
      for (const who of ['alice', 'bob'] as const) {
        const { recoveryCode: _code, ...enrollment } = await createEncryptionEnrollment(PEOPLE[who].id, 'a durable private passphrase', [stories[who]]);
        assert.equal((await as(who, 'POST', '/api/encryption/enroll', enrollment)).status, 201);
      }
      const saved = await as('alice', 'PUT', '/api/provider-key', { id: KEY1, endpointId: 'openai', models, trust: 'unlock', wrap: fakeWrap, keyHint: 'ghij' });
      assert.equal(body(saved).status, 'locked');
      assert.deepEqual(body(await as('alice', 'GET', '/api/encryption/keys')).providerKey, { keyId: KEY1, wrap: fakeWrap });

      const stolen = await as('bob', 'POST', '/api/encryption/unlock', { providerKeys: [{ keyId: KEY1, key: 'sk-bob-0123456789abcd' }] });
      assert.equal(stolen.status, 403);

      const unlocked = await as('alice', 'POST', '/api/encryption/unlock', { providerKeys: [{ keyId: KEY1, key: ALICE_KEY }] });
      assert.equal(unlocked.status, 200, JSON.stringify(unlocked.body));
      assert.equal((body(unlocked).providerGrants as unknown[]).length, 1);
      assert.equal(await resolver.status(sessionUser('alice')), 'own');

      assert.equal(body(await as('alice', 'POST', '/api/encryption/lock', {})).providerLocked, true);
      assert.equal(await resolver.status(sessionUser('alice')), 'locked');
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('Test and model listing are rate-limited per user and their usage is reported to the user and admins', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const stories = await storiesFor(db);
    await withKeyServer(roles, async (as) => {
      assert.deepEqual(body(await as('alice', 'POST', '/api/provider-key/test', { endpointId: 'openai', model: 'gpt-test', key: ALICE_KEY })), { ok: true, model: 'gpt-test' });
      assert.deepEqual(body(await as('alice', 'POST', '/api/provider-key/models', { endpointId: 'openai', key: ALICE_KEY })), { models: ['gpt-a', 'gpt-b'] });
      const limited = await as('alice', 'POST', '/api/provider-key/test', { endpointId: 'openai', model: 'gpt-test', key: ALICE_KEY });
      assert.equal(limited.status, 429);
      assert.ok(limited.headers.get('retry-after'));

      const mine = body(await as('alice', 'GET', '/api/usage?days=7'));
      assert.equal(mine.days, 7);
      assert.deepEqual((mine.rows as Body[]).map((r) => [r.model, r.keySource, r.calls]), [['gpt-test', 'own', 1]]);
      assert.equal((await as('alice', 'GET', '/api/admin/usage')).status, 403);
      const all = body(await as('admin', 'GET', '/api/admin/usage'));
      assert.ok((all.rows as Body[]).some((r) => r.userId === PEOPLE.alice.id));

      const state = await getStateTool({
        world: () => World.forStory(roles.play, stories.alice),
        db: roles.play,
        user: sessionUser('alice'),
        engine: new Engine({ world: () => worldFor(roles.play, null), db: roles.play, providers: new ProviderRegistry(new MockProvider()) }),
        dataRoot: 'data',
      });
      assert.equal(state.myUsage?.length, 1);
    }, { keyCallLimit: { burst: 2, perMinute: 1 } });
  });
  if (!ran) t.skip('no Postgres configured');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `env FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/transport-contracts.test.ts test/pg-provider-key-routes.test.ts`
Expected: FAIL — `providerKeyBodySchema` is not exported; routes answer `404 no route for PUT /api/provider-key`.

- [ ] **Step 3: Add the contracts**

In `src/server/contracts.ts`, insert immediately above `export const encryptionUnlockBodySchema` (line 184):

```ts
const providerKeyIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be a UUID');
const providerSecretSchema = z.string().min(8).max(512).regex(/^[\x21-\x7e]+$/, 'invalid API key');
const providerModelIdSchema = z.string().trim().min(1).max(200).regex(/^[\w.:@+-][\w.:/@+-]*$/, 'invalid model id').refine((v) => !v.includes('..'), 'invalid model id');
const providerEndpointIdSchema = z.string().min(1).max(40);
const providerKeyFields = {
  id: providerKeyIdSchema,
  label: z.string().trim().max(80).default(''),
  endpointId: providerEndpointIdSchema,
  models: z.object({
    narrate: providerModelIdSchema,
    mechanics: providerModelIdSchema.optional(),
    extract: providerModelIdSchema.optional(),
  }).strict(),
};
export const providerKeyBodySchema = z.discriminatedUnion('trust', [
  z.object({ ...providerKeyFields, trust: z.literal('sealed'), key: providerSecretSchema }).strict(),
  z.object({
    ...providerKeyFields,
    trust: z.literal('unlock'),
    wrap: encryptedKeyEnvelopeSchema,
    keyHint: z.string().max(4).regex(/^[\x21-\x7e]*$/),
  }).strict(),
]);
export const providerKeyTestBodySchema = z.object({
  endpointId: providerEndpointIdSchema,
  model: providerModelIdSchema,
  key: providerSecretSchema,
}).strict();
export const providerModelsBodySchema = z.object({ endpointId: providerEndpointIdSchema, key: providerSecretSchema }).strict();
```

Replace `encryptionUnlockBodySchema` (lines 184-189) with:

```ts
export const encryptionUnlockBodySchema = z.object({
  storyKeys: z.array(z.object({
    storyId: nonEmptyText,
    key: base64BytesSchema,
  }).strict()).max(100).default([]),
  providerKeys: z.array(z.object({ keyId: providerKeyIdSchema, key: providerSecretSchema }).strict()).max(1).default([]),
}).strict().refine((b) => b.storyKeys.length + b.providerKeys.length > 0, 'nothing to unlock');
```

- [ ] **Step 4: Add and extend the routes**

In `src/server/api-pg.ts`, add to the imports: `providerKeyBodySchema, providerKeyTestBodySchema, providerModelsBodySchema` (from `./contracts.ts`), `import { BYOK_ENDPOINTS } from '../providers/byok.ts';`, `import { ProviderKeyForbiddenError, ProviderKeyInputError } from '../providers/resolver-pg.ts';` (merge with the type import from Task 9), `import { usageByUser, usageForUser } from '../store/usage-pg.ts';`.

Replace the `GET /api/encryption/keys` handler (lines 410-414) with:

```ts
route('GET', '/api/encryption/keys', async (_req, res, { db, user, ephemeralStoryKeys, providerResolver }) => {
  if (!user) return send(res, 401, { error: 'sign-in required' });
  const keys = await encryptionKeysForUser(db, user.id);
  send(res, 200, {
    enrolled: keys.userKey !== null,
    grants: ephemeralStoryKeys.list(user.id),
    ...keys,
    providerKey: providerResolver ? await providerResolver.unlockRecord(user) : null,
  });
});
```

Replace the `POST /api/encryption/unlock` handler (lines 429-451) with:

```ts
route('POST', '/api/encryption/unlock', async (_req, res, { body, db, user, ephemeralStoryKeys, providerResolver }) => {
  if (!user) return send(res, 401, { error: 'sign-in required' });
  const { storyKeys, providerKeys } = parseBody(encryptionUnlockBodySchema, body);
  if (new Set(storyKeys.map((item) => item.storyId)).size !== storyKeys.length) {
    return send(res, 400, { error: 'duplicate private-story key' });
  }
  const persisted = await encryptionKeysForUser(db, user.id);
  if (!persisted.userKey) return send(res, 409, { error: 'configure private storage before unlocking it' });
  const permittedStoryIds = new Set(persisted.storyKeys.map((item) => item.storyId));
  if (storyKeys.some((item) => !permittedStoryIds.has(item.storyId))) {
    return send(res, 403, { error: 'can only unlock your enrolled stories' });
  }
  if (providerKeys.length && !providerResolver) {
    return send(res, 409, { error: 'personal provider keys are not enabled on this server' });
  }
  let grants: ReturnType<EphemeralStoryKeyStore['unlock']>;
  try {
    grants = ephemeralStoryKeys.unlock(
      user.id,
      storyKeys.map((item) => ({ storyId: item.storyId, key: Buffer.from(item.key, 'base64') })),
    );
  } catch {
    // Key bytes are deliberately not returned, logged, or placed in an error.
    return send(res, 400, { error: 'invalid private-story key' });
  }
  try {
    const providerGrants = providerResolver ? await providerResolver.unlock(user, providerKeys) : [];
    send(res, 200, { grants, providerGrants });
  } catch (err) {
    if (err instanceof ProviderKeyForbiddenError) return send(res, 403, { error: err.message });
    throw err;
  }
});
```

Replace the `POST /api/encryption/lock` handler (lines 453-458) with:

```ts
route('POST', '/api/encryption/lock', async (_req, res, { body, user, ephemeralStoryKeys, providerResolver }) => {
  if (!user) return send(res, 401, { error: 'sign-in required' });
  const { storyId } = parseBody(encryptionLockBodySchema, body);
  const lockedStoryIds = ephemeralStoryKeys.lock(user.id, storyId);
  // Locking everything includes the provider key: "locked" must mean nothing of theirs is usable here.
  const providerLocked = storyId ? false : (providerResolver?.lock(user.id) ?? false);
  send(res, 200, { lockedStoryIds, providerLocked });
});
```

Insert before `route('GET', '/api/state'` (line 489):

```ts
function requireResolver(res: ServerResponse, resolver: ProviderResolver | undefined): ProviderResolver | null {
  if (!resolver) {
    send(res, 503, { error: 'personal provider keys are not enabled on this server' });
    return null;
  }
  return resolver;
}

/** Spends one key-management call; answers 429 and returns false once the caller is out. */
function takeKeyCall(res: ServerResponse, resolver: ProviderResolver, user: SessionUser): boolean {
  const wait = resolver.takeKeyCall(user.id);
  if (wait === null) return true;
  res.setHeader('retry-after', String(wait));
  send(res, 429, { error: `too many provider-key requests; try again in ${wait}s` });
  return false;
}

function usageDays(url: URL): number {
  const days = Number(url.searchParams.get('days'));
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : 30;
}

route('GET', '/api/provider-key', async (_req, res, { user, providerResolver }) => {
  if (!user) return send(res, 401, { error: 'sign-in required' });
  const resolver = requireResolver(res, providerResolver);
  if (!resolver) return;
  send(res, 200, {
    key: await resolver.summary(user),
    status: await resolver.status(user),
    sealedAvailable: resolver.sealedAvailable,
    endpoints: BYOK_ENDPOINTS.map(({ id, label }) => ({ id, label })),
  });
});

route('PUT', '/api/provider-key', async (_req, res, { body, user, providerResolver }) => {
  if (!user) return send(res, 401, { error: 'sign-in required' });
  const resolver = requireResolver(res, providerResolver);
  if (!resolver || !takeKeyCall(res, resolver, user)) return;
  const input = parseBody(providerKeyBodySchema, body);
  try {
    const key = await resolver.save(user, input);
    send(res, 200, { key, status: await resolver.status(user) });
  } catch (err) {
    if (err instanceof ProviderKeyInputError) return send(res, 400, { error: err.message });
    if ((err as { code?: string }).code === '23505') return send(res, 409, { error: 'that key id is already in use' });
    throw err;
  }
});

route('DELETE', '/api/provider-key', async (_req, res, { user, providerResolver }) => {
  if (!user) return send(res, 401, { error: 'sign-in required' });
  const resolver = requireResolver(res, providerResolver);
  if (!resolver) return;
  const removed = await resolver.remove(user);
  send(res, 200, { removed, status: await resolver.status(user) });
});

route('POST', '/api/provider-key/test', async (_req, res, { body, user, providerResolver }) => {
  if (!user) return send(res, 401, { error: 'sign-in required' });
  const resolver = requireResolver(res, providerResolver);
  if (!resolver || !takeKeyCall(res, resolver, user)) return;
  try {
    send(res, 200, await resolver.test(user, parseBody(providerKeyTestBodySchema, body)));
  } catch (err) {
    if (err instanceof ProviderKeyInputError) return send(res, 400, { error: err.message });
    throw err;
  }
});

route('POST', '/api/provider-key/models', async (_req, res, { body, user, providerResolver }) => {
  if (!user) return send(res, 401, { error: 'sign-in required' });
  const resolver = requireResolver(res, providerResolver);
  if (!resolver || !takeKeyCall(res, resolver, user)) return;
  try {
    send(res, 200, { models: await resolver.models(parseBody(providerModelsBodySchema, body)) });
  } catch (err) {
    if (err instanceof ProviderKeyInputError) return send(res, 400, { error: err.message });
    throw err;
  }
});

route('GET', '/api/usage', async (_req, res, { db, user, url }) => {
  if (!user) return send(res, 401, { error: 'sign-in required' });
  const days = usageDays(url);
  send(res, 200, { days, rows: await usageForUser(db, user.id, days) });
});

route('GET', '/api/admin/usage', async (_req, res, { db, user, url, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const days = usageDays(url);
  send(res, 200, { days, rows: await usageByUser(db, days) });
});
```

In `src/mcp/tools-pg.ts`, import `usageForUser` from `'../store/usage-pg.ts'` and add to the object returned by `getStateTool` (after `usage: await world.chronicle.usageTotals(),`, line 328):

```ts
    myUsage: ctx.user ? await usageForUser(ctx.db, ctx.user.id, 30) : null,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `env FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/transport-contracts.test.ts test/pg-provider-key-routes.test.ts test/pg-api.test.ts test/mcp-tools-pg.test.ts`
Expected: PASS. Then `pnpm typecheck` — Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/contracts.ts src/server/api-pg.ts src/mcp/tools-pg.ts test/transport-contracts.test.ts test/pg-provider-key-routes.test.ts
git commit -m "feat(api): add provider-key, unlock handoff and usage routes"
```

---

### Task 11: Boot wiring, `shareServerProvider` config, deploy env

**Files:**
- Modify: `src/config/config.ts:14-58` (`Config`)
- Modify: `src/config/service.ts` — `patch`, after the `blocklist` block (lines 166-168)
- Modify: `src/cli/serve-pg.ts` — imports (line 35), after `configService` (line 272), `createApiServer({ ... })` (lines 351-368)
- Modify: `deploy/deploy.sh:34-37` and `:63-66`; `.github/workflows/release.yml` (env block ~line 108, `render_env` list lines 169-171); `README.md:770`
- Test: `test/config.test.ts` (append)

**Interfaces:**
- Consumes: `ProviderResolver` (Task 7), `secretsKeyFromEnv` (Task 2).
- Produces: `Config.shareServerProvider?: boolean` (absent = `true`), admin-patchable through `PUT /api/config`; the server always runs with a `ProviderResolver`.

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.ts`:

```ts
test('shareServerProvider is an admin-patchable boolean that defaults to sharing', () => {
  const { svc, saved } = service();
  assert.equal(svc.get().shareServerProvider, undefined);
  const off = svc.patch({ shareServerProvider: false });
  assert.deepEqual(off.issues, []);
  assert.equal(saved().shareServerProvider, false);
  const bad = svc.patch({ shareServerProvider: 'no' as never });
  assert.equal(bad.issues[0]?.field, 'shareServerProvider');
  assert.equal(saved().shareServerProvider, false, 'an invalid value is not saved');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test test/config.test.ts`
Expected: FAIL — `saved().shareServerProvider` is `undefined` (the patch drops the field).

- [ ] **Step 3: Implement**

In `src/config/config.ts`, add to `Config` after `requireLogin?: boolean;` (line 57):

```ts
  /** Whether signed-in non-admins without their own key may use this server's provider. Absent means true. */
  shareServerProvider?: boolean;
```

In `src/config/service.ts` `patch`, after the `blocklist` block (line 168) add:

```ts
    if (partial.shareServerProvider !== undefined) {
      if (typeof partial.shareServerProvider !== 'boolean') {
        issues.push({ field: 'shareServerProvider', message: 'must be true or false' });
      } else {
        next.shareServerProvider = partial.shareServerProvider;
      }
    }
```

In `src/cli/serve-pg.ts`, add imports `import { secretsKeyFromEnv } from '../crypto/provider-secret.ts';` and `import { ProviderResolver } from '../providers/resolver-pg.ts';`. After `const configService = new ConfigService(...)` (line 272) add:

```ts
  // Throws on a malformed FABULIST_SECRETS_KEY rather than booting with sealed keys silently unusable.
  const secretsKey = secretsKeyFromEnv(process.env);
  if (!secretsKey) console.log('sealed provider keys disabled (set FABULIST_SECRETS_KEY to 32 random bytes, base64)');
  const providerResolver = new ProviderResolver({
    db: play,
    server: registry,
    shareServerProvider: () => configService.get().shareServerProvider !== false,
    secretsKey,
  });
```

and add `providerResolver,` to the `createApiServer({ ... })` options (after `imagesDir,`, line 363).

In `deploy/deploy.sh`, add `FABULIST_SECRETS_KEY` to both allowlists: line 37 becomes `FABULIST_PG|POSTGRES_PASSWORD|COMPOSE_PROFILES|FABULIST_DB_ROLES|FABULIST_SECRETS_KEY)` and line 66 becomes `FABULIST_PG|POSTGRES_PASSWORD|COMPOSE_PROFILES|FABULIST_IMAGE|FABULIST_DB_ROLES|FABULIST_SECRETS_KEY)`.

In `.github/workflows/release.yml`, add `FABULIST_SECRETS_KEY: ${{ secrets.FABULIST_SECRETS_KEY }}` to the deploy step's `env:` (after `WORKOS_COOKIE_PASSWORD`, line 110), and append `FABULIST_SECRETS_KEY` to the `render_env` name list (line 171, after `FABULIST_DB_ROLES`).

In `README.md`, inside the env block after `AUTH_ADMIN_EMAILS=…` (line 770) add:

```bash
FABULIST_SECRETS_KEY=<openssl rand -base64 32>    # enables "sealed" personal provider keys; whoever holds it and the DB can decrypt them
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --test test/config.test.ts test/release-workflow.test.ts` — Expected: PASS. Then `pnpm typecheck` — Expected: no errors. Then boot check (with `pnpm pg:start` running and `FABULIST_PG` set to its `DATABASE_URL`): `env FABULIST_SECRETS_KEY=c2hvcnQ= pnpm serve` — Expected: exits with `FABULIST_SECRETS_KEY must decode to 32 bytes, got 5`; `env FABULIST_SECRETS_KEY=(openssl rand -base64 32) pnpm serve` (fish) boots without the "sealed provider keys disabled" line.

- [ ] **Step 5: Commit**

```bash
git add src/config/config.ts src/config/service.ts src/cli/serve-pg.ts deploy/deploy.sh .github/workflows/release.yml README.md test/config.test.ts
git commit -m "feat(serve): wire the provider resolver and FABULIST_SECRETS_KEY"
```

---

### Task 12: Web client, hooks and unlock handoff

**Files:**
- Modify: `web/src/api.ts` — import (line 21), `REQUIRED_ROUTES` (lines 617-643), `AppConfig` (lines 483-491), `EncryptionKeyBundle` (lines 587-592), `api.encryption.unlock/lock` (lines 696-697), `api` object (add `providerKey`, `usage`)
- Modify: `web/src/queries.ts:111-143`
- Modify: `web/src/App.tsx:102-109` (import), `:637-642` (unlock)
- Create: `web/src/my-provider.ts`
- Test: `test/my-provider-presentation.test.ts` (create)

**Interfaces:**
- Consumes: routes from Task 10; `providerKeyHandoff`, `ProviderKeyRecord`, `ProviderKeyHandoff` (Task 4).
- Produces:
  - types `ProviderStatus`, `ProviderModels`, `ProviderKeySummary`, `ProviderKeyState`, `ProviderKeyInput`, `ProviderKeyGrant`, `UsageRow`, `UserUsageRow` in `web/src/api.ts`
  - `api.providerKey.{get, save, remove, test, models}`, `api.usage.{mine, byUser}`; `api.encryption.unlock(handoff: { storyKeys: StoryKeyHandoff[]; providerKeys?: ProviderKeyHandoff[] })`
  - hooks `providerKeyKeys`, `usageKeys`, `useProviderKeyQuery`, `useSaveProviderKeyMutation`, `useDeleteProviderKeyMutation`, `useTestProviderKeyMutation`, `useProviderModelsMutation`, `useMyUsageQuery`, `useUsageByUserQuery`
  - `web/src/my-provider.ts`: `providerStatusLine(status: ProviderStatus | undefined): string`, `TRUST_COPY: { unlock: string; sealed: string }`, `keyHintFor(apiKey: string): string`

- [ ] **Step 1: Write the failing test**

Create `test/my-provider-presentation.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { keyHintFor, providerStatusLine, TRUST_COPY } from '../web/src/my-provider.ts';

test('every provider status reads as a plain-words line', () => {
  assert.equal(providerStatusLine('own'), 'Using your key.');
  assert.match(providerStatusLine('locked'), /unlock private storage/i);
  assert.match(providerStatusLine('unavailable'), /cannot be used/);
  assert.match(providerStatusLine('server'), /server provider/);
  assert.match(providerStatusLine('none'), /agent keeps the world/);
  assert.equal(providerStatusLine(undefined), 'Checking…');
});

test('the trust copy says who can decrypt the key', () => {
  assert.match(TRUST_COPY.unlock, /only you can decrypt/i);
  assert.match(TRUST_COPY.sealed, /runs this server can decrypt/i);
});

test('the key hint is the last four characters only', () => {
  assert.equal(keyHintFor('sk-abcdefgh1234'), '1234');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test test/my-provider-presentation.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `web/src/my-provider.ts`.

- [ ] **Step 3: Implement the client, hooks and helper**

In `web/src/api.ts`:

Change line 21 to `import type { EncryptedKeyEnvelope, EncryptionEnrollment, ProviderKeyHandoff, ProviderKeyRecord, StoryKeyHandoff, StoryKeyRecord, UserKeyRecord } from './crypto/keys.ts';`.

Add `shareServerProvider?: boolean;` to `AppConfig` (after `mockTokenDelayMs?: number;`, line 490).

Add `providerKey?: ProviderKeyRecord | null;` to `EncryptionKeyBundle` (after `grants: StoryKeyGrant[];`, line 591).

Add after the `EncryptionKeyBundle`/`StoryKeyGrant` declarations:

```ts
export type ProviderStatus = 'own' | 'locked' | 'unavailable' | 'server' | 'none';

export interface ProviderModels {
  narrate: string;
  mechanics?: string;
  extract?: string;
}

export interface ProviderKeySummary {
  id: string;
  label: string;
  endpointId: string;
  models: ProviderModels;
  trust: 'unlock' | 'sealed';
  keyHint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ProviderKeyState {
  key: ProviderKeySummary | null;
  status: ProviderStatus;
  sealedAvailable: boolean;
  endpoints: Array<{ id: string; label: string }>;
}

export type ProviderKeyInput =
  | { id: string; label: string; endpointId: string; models: ProviderModels; trust: 'sealed'; key: string }
  | { id: string; label: string; endpointId: string; models: ProviderModels; trust: 'unlock'; wrap: EncryptedKeyEnvelope; keyHint: string };

export interface ProviderKeyGrant {
  keyId: string;
  expiresAt: string;
}

export interface UsageRow {
  day: string;
  model: string;
  keySource: 'own' | 'server';
  calls: number;
  tokensIn: number;
  tokensOut: number;
}

export interface UserUsageRow {
  userId: string;
  keySource: 'own' | 'server';
  calls: number;
  tokensIn: number;
  tokensOut: number;
}
```

Append to `REQUIRED_ROUTES` (before `] as const;`, line 643):

```ts
  'GET /api/provider-key',
  'PUT /api/provider-key',
  'DELETE /api/provider-key',
  'GET /api/usage',
```

Replace `unlock` and `lock` in `api.encryption` (lines 696-697) with:

```ts
    unlock: (handoff: { storyKeys: StoryKeyHandoff[]; providerKeys?: ProviderKeyHandoff[] }) =>
      post<{ grants: StoryKeyGrant[]; providerGrants: ProviderKeyGrant[] }>('/encryption/unlock', handoff),
    lock: (storyId?: string) =>
      post<{ lockedStoryIds: string[]; providerLocked: boolean }>('/encryption/lock', storyId ? { storyId } : {}),
```

Add inside `export const api = {` after the `encryption: { … },` block:

```ts
  providerKey: {
    get: () => req<ProviderKeyState>('/provider-key'),
    save: (input: ProviderKeyInput) => put<{ key: ProviderKeySummary; status: ProviderStatus }>('/provider-key', input),
    remove: () => req<{ removed: boolean; status: ProviderStatus }>('/provider-key', { method: 'DELETE' }),
    test: (input: { endpointId: string; model: string; key: string }) =>
      post<{ ok: true; model: string } | { ok: false; error: string }>('/provider-key/test', input),
    models: (input: { endpointId: string; key: string }) => post<{ models: string[] }>('/provider-key/models', input),
  },
  usage: {
    mine: (days = 30) => req<{ days: number; rows: UsageRow[] }>(`/usage?days=${days}`),
    byUser: (days = 30) => req<{ days: number; rows: UserUsageRow[] }>(`/admin/usage?days=${days}`),
  },
```

In `web/src/queries.ts`, after `encryptionKeys` (line 115) add:

```ts
export const providerKeyKeys = { all: ['provider-key'] as const };
export const usageKeys = {
  all: ['usage'] as const,
  mine: (days: number) => ['usage', 'mine', days] as const,
  byUser: (days: number) => ['usage', 'by-user', days] as const,
};
```

Replace `useUnlockMutation` and `useLockMutation` (lines 137-143) with:

```ts
export function useUnlockMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.encryption.unlock,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: providerKeyKeys.all }),
  });
}

export function useLockMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.encryption.lock(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: providerKeyKeys.all }),
  });
}
```

After `useMigrateMutation` (line 147) add:

```ts
// ---------------------------------------------------------------- my provider

export function useProviderKeyQuery(enabled: boolean) {
  return useQuery({ queryKey: providerKeyKeys.all, queryFn: api.providerKey.get, enabled, retry: false });
}

export function useSaveProviderKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.providerKey.save,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: providerKeyKeys.all }),
  });
}

export function useDeleteProviderKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.providerKey.remove,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: providerKeyKeys.all }),
  });
}

export function useTestProviderKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.providerKey.test,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: usageKeys.all }),
  });
}

export function useProviderModelsMutation() {
  return useMutation({ mutationFn: api.providerKey.models });
}

export function useMyUsageQuery(days: number, enabled: boolean) {
  return useQuery({ queryKey: usageKeys.mine(days), queryFn: () => api.usage.mine(days), enabled });
}

export function useUsageByUserQuery(days: number, enabled: boolean) {
  return useQuery({ queryKey: usageKeys.byUser(days), queryFn: () => api.usage.byUser(days), enabled });
}
```

Create `web/src/my-provider.ts`:

```ts
import type { ProviderStatus } from './api.ts';

export function providerStatusLine(status: ProviderStatus | undefined): string {
  switch (status) {
    case 'own':
      return 'Using your key.';
    case 'locked':
      return 'Locked — unlock private storage to use your key.';
    case 'unavailable':
      return 'Your saved key cannot be used on this server right now.';
    case 'server':
      return 'Using the server provider.';
    case 'none':
      return 'No provider — your agent keeps the world.';
    default:
      return 'Checking…';
  }
}

export const TRUST_COPY = {
  unlock:
    'Only you can decrypt it. It works while private storage is unlocked (up to 4 hours); when it locks, MCP and background jobs stop using it. Needs private storage.',
  sealed:
    'The server encrypts it with its own secret. Always usable, including MCP and background jobs, but whoever runs this server can decrypt it.',
} as const;

export function keyHintFor(apiKey: string): string {
  return apiKey.slice(-4);
}
```

In `web/src/App.tsx`, add `providerKeyHandoff,` to the `./crypto/keys.ts` import (lines 102-109) and replace line 642 (`const result = await unlockMutation.mutateAsync(storyKeyHandoff(unlocked.storyKeys));`) with:

```ts
      const providerKeys = keyBundle.providerKey
        ? await providerKeyHandoff(user.id, unlocked.masterKey, [keyBundle.providerKey])
        : [];
      const result = await unlockMutation.mutateAsync({ storyKeys: storyKeyHandoff(unlocked.storyKeys), providerKeys });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --test test/my-provider-presentation.test.ts test/private-storage-presentation.test.ts` — Expected: PASS.
Run: `env FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/pg-api.test.ts` — Expected: PASS (`every route the web client demands is actually served`).
Run: `pnpm typecheck && pnpm build:web` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/queries.ts web/src/App.tsx web/src/my-provider.ts test/my-provider-presentation.test.ts
git commit -m "feat(web): add provider-key client and unlock handoff"
```

---

### Task 13: My provider panel, usage panels, admin toggle

**Files:**
- Create: `web/src/views/MyProviderPanel.tsx`
- Modify: `web/src/App.tsx` — import (near line 24), `SettingsTab` (lines 2164-2171 and 2232)
- Modify: `web/src/views/ConfigPanels.tsx:45-97`
- Test: `pnpm typecheck`, `pnpm build:web`, manual check

**Interfaces:**
- Consumes: hooks and helpers from Task 12; `wrapProviderKey`, `unlockWithPassphrase`, `eraseUnlockedStoryKeys` (`web/src/crypto/keys.ts`); `encryptionKeys`, `useEncryptionKeysQuery`, `useUnlockMutation`, `useConfigPatchMutation` (`web/src/queries.ts`).
- Produces: `MyProviderPanel({ user }: { user: CurrentUser })`, `MyUsagePanel()`, `AdminUsagePanel()`.

The logic worth testing (status copy, trust copy, key hint) is already pinned by `test/my-provider-presentation.test.ts`; this task is presentation, so it is verified by typecheck, build and a browser pass.

- [ ] **Step 1: Write the panel**

Create `web/src/views/MyProviderPanel.tsx`:

```tsx
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type CurrentUser } from '../api.ts';
import { eraseUnlockedStoryKeys, unlockWithPassphrase, wrapProviderKey } from '../crypto/keys.ts';
import { keyHintFor, providerStatusLine, TRUST_COPY } from '../my-provider.ts';
import {
  encryptionKeys,
  useDeleteProviderKeyMutation,
  useEncryptionKeysQuery,
  useMyUsageQuery,
  useProviderKeyQuery,
  useProviderModelsMutation,
  useSaveProviderKeyMutation,
  useTestProviderKeyMutation,
  useUnlockMutation,
  useUsageByUserQuery,
} from '../queries.ts';

export function MyProviderPanel({ user }: { user: CurrentUser }) {
  const queryClient = useQueryClient();
  const { data: state, error: loadError } = useProviderKeyQuery(true);
  const { data: keyBundle } = useEncryptionKeysQuery(true);
  const save = useSaveProviderKeyMutation();
  const remove = useDeleteProviderKeyMutation();
  const probe = useTestProviderKeyMutation();
  const listModels = useProviderModelsMutation();
  const unlock = useUnlockMutation();
  const [endpointId, setEndpointId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [narrate, setNarrate] = useState('');
  const [mechanics, setMechanics] = useState('');
  const [extract, setExtract] = useState('');
  const [trust, setTrust] = useState<'unlock' | 'sealed'>('unlock');
  const [passphrase, setPassphrase] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!state) {
    return (
      <div className="card">
        <h3>my provider</h3>
        <p className="empty">{loadError ? loadError.message : 'loading…'}</p>
      </div>
    );
  }

  const endpoint = endpointId || state.key?.endpointId || state.endpoints[0]?.id || '';
  const enrolled = keyBundle?.enrolled === true;
  const modelSet = () => ({
    narrate: narrate.trim(),
    ...(mechanics.trim() ? { mechanics: mechanics.trim() } : {}),
    ...(extract.trim() ? { extract: extract.trim() } : {}),
  });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onLoadModels = () =>
    run(async () => {
      const { models: found } = await listModels.mutateAsync({ endpointId: endpoint, key: apiKey });
      setModels(found);
      setNote(found.length ? `${found.length} models found` : 'this provider did not list models; type a model id');
    });

  const onTest = () =>
    run(async () => {
      const result = await probe.mutateAsync({ endpointId: endpoint, model: narrate.trim(), key: apiKey });
      setNote(result.ok ? `works — ${result.model} answered` : `failed — ${result.error}`);
    });

  const onSave = () =>
    run(async () => {
      const id = crypto.randomUUID();
      const base = { id, label: '', endpointId: endpoint, models: modelSet() };
      if (trust === 'sealed') {
        await save.mutateAsync({ ...base, trust: 'sealed', key: apiKey });
      } else {
        const bundle = await queryClient.fetchQuery({ queryKey: encryptionKeys.keys, queryFn: api.encryption.keys });
        if (!bundle.userKey) throw new Error('set up private storage first, or choose the server-sealed mode');
        const unlocked = await unlockWithPassphrase(user.id, bundle.userKey, [], passphrase);
        try {
          const wrap = await wrapProviderKey(user.id, unlocked.masterKey, id, apiKey);
          await save.mutateAsync({ ...base, trust: 'unlock', wrap, keyHint: keyHintFor(apiKey) });
          await unlock.mutateAsync({ storyKeys: [], providerKeys: [{ keyId: id, key: apiKey }] });
        } finally {
          eraseUnlockedStoryKeys(unlocked);
        }
      }
      setApiKey('');
      setPassphrase('');
      setNote('saved');
    });

  const onDelete = () =>
    run(async () => {
      await remove.mutateAsync();
      setNote('deleted');
    });

  const canSave =
    !busy && !!apiKey && !!narrate.trim() && (trust === 'sealed' ? state.sealedAvailable : enrolled && passphrase.length >= 12);

  return (
    <div className="card">
      <h3>my provider</h3>
      <p className="small">{providerStatusLine(state.status)}</p>
      {state.key ? (
        <p className="small dim">
          saved: <span className="mono">{state.key.endpointId} ••••{state.key.keyHint}</span> ({state.key.trust})
        </p>
      ) : null}
      <label className="field-row">
        <span>provider</span>
        <select value={endpoint} disabled={busy} onChange={(e) => setEndpointId(e.target.value)}>
          {state.endpoints.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field-row">
        <span>API key</span>
        <input type="password" autoComplete="off" value={apiKey} disabled={busy} onChange={(e) => setApiKey(e.target.value)} />
      </label>
      <button type="button" disabled={busy || !apiKey} onClick={() => void onLoadModels()}>
        load models
      </button>
      <datalist id="my-provider-models">
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {([
        ['narrate', narrate, setNarrate],
        ['mechanics (optional)', mechanics, setMechanics],
        ['extract (optional)', extract, setExtract],
      ] as const).map(([label, value, set]) => (
        <label className="field-row" key={label}>
          <span>{label}</span>
          <input list="my-provider-models" value={value} disabled={busy} onChange={(e) => set(e.target.value)} />
        </label>
      ))}
      <fieldset className="field-row block">
        <legend>how your key is protected</legend>
        <label>
          <input type="radio" name="trust" checked={trust === 'unlock'} disabled={busy || !enrolled} onChange={() => setTrust('unlock')} />{' '}
          with my passphrase — {TRUST_COPY.unlock}
        </label>
        <label>
          <input type="radio" name="trust" checked={trust === 'sealed'} disabled={busy || !state.sealedAvailable} onChange={() => setTrust('sealed')} />{' '}
          by the server — {state.sealedAvailable ? TRUST_COPY.sealed : 'Not available on this server.'}
        </label>
      </fieldset>
      {trust === 'unlock' ? (
        <label className="field-row">
          <span>passphrase</span>
          <input type="password" autoComplete="current-password" value={passphrase} disabled={busy} onChange={(e) => setPassphrase(e.target.value)} />
        </label>
      ) : null}
      <div className="row">
        <button type="button" disabled={busy || !apiKey || !narrate.trim()} onClick={() => void onTest()}>
          test
        </button>
        <button type="button" disabled={!canSave} onClick={() => void onSave()}>
          save
        </button>
        <button type="button" disabled={busy || !state.key} onClick={() => void onDelete()}>
          delete
        </button>
      </div>
      {note ? <p className="small dim" role="status">{note}</p> : null}
    </div>
  );
}

export function MyUsagePanel() {
  const { data } = useMyUsageQuery(30, true);
  if (!data?.rows.length) {
    return (
      <div className="card">
        <h3>your usage</h3>
        <p className="empty">No provider calls in the last 30 days.</p>
      </div>
    );
  }
  return (
    <div className="card">
      <h3>your usage · last {data.days} days</h3>
      {data.rows.map((r) => (
        <div key={`${r.day}|${r.model}|${r.keySource}`} className="row small">
          <span className="grow dim">
            {r.day} · {r.model}
          </span>
          <span className="tag">{r.keySource === 'own' ? 'your key' : 'server'}</span>
          <span className="mono dimmer">
            {r.calls}× {r.tokensIn.toLocaleString()}→{r.tokensOut.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

export function AdminUsagePanel() {
  const { data } = useUsageByUserQuery(30, true);
  return (
    <div className="card">
      <h3>usage by user · last 30 days</h3>
      {data?.rows.length ? (
        data.rows.map((r) => (
          <div key={`${r.userId}|${r.keySource}`} className="row small">
            <span className="grow mono dim">{r.userId}</span>
            <span className="tag">{r.keySource === 'own' ? 'own key' : 'server'}</span>
            <span className="mono dimmer">
              {r.calls}× {r.tokensIn.toLocaleString()}→{r.tokensOut.toLocaleString()}
            </span>
          </div>
        ))
      ) : (
        <p className="empty">No metered calls yet.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire it into Settings and add the admin toggle**

In `web/src/App.tsx`, add `import { AdminUsagePanel, MyProviderPanel, MyUsagePanel } from './views/MyProviderPanel.tsx';` next to the `ConfigPanels` import (line 24). In `SettingsTab`, after the `PrivateStoragePanel` block (the `) : null}` at line 2171) add:

```tsx
        {currentUser ? <MyProviderPanel user={currentUser} /> : null}
```

and replace `<UsagePanel usage={state?.usage ?? null} />` (line 2232) with:

```tsx
        <UsagePanel usage={state?.usage ?? null} />
        {currentUser ? <MyUsagePanel /> : null}
        {currentUser?.isAdmin ? <AdminUsagePanel /> : null}
```

In `web/src/views/ConfigPanels.tsx`, add `const patchMutation = useConfigPatchMutation();` after `const [note, setNote] = useState<string | null>(null);` (line 49), and insert before `<ProsePanel cfg={cfg} busy={busy} apply={apply} />` (line 88):

```tsx
      <div className="card">
        <h3>shared provider</h3>
        <label className="field-row">
          <span>let signed-in users use this server's provider</span>
          <input
            type="checkbox"
            checked={cfg.shareServerProvider !== false}
            disabled={busy}
            onChange={(e) => void apply(() => patchMutation.mutateAsync({ shareServerProvider: e.target.checked }))}
          />
        </label>
        <p className="hint">Off: users without their own key get no model and their agent keeps the world. Admins always use it.</p>
      </div>
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm build:web` — Expected: no errors.
Manual: `pnpm pg:start`, then `env FABULIST_SECRETS_KEY=$(openssl rand -base64 32) pnpm serve` with login configured; in Settings confirm the My provider status line, save a sealed key, Test, Delete, and (as admin) toggle "shared provider" and see status change to "No provider — your agent keeps the world." for a non-admin without a key.

- [ ] **Step 4: Commit**

```bash
git add web/src/views/MyProviderPanel.tsx web/src/App.tsx web/src/views/ConfigPanels.tsx
git commit -m "feat(web): add my provider panel, usage panels and sharing toggle"
```

---

### Task 14: Security review gate (before merge)

**Files:**
- Review: `src/crypto/provider-secret.ts`, `src/auth/ephemeral-provider-keys.ts`, `src/auth/provider-keys-pg.ts`, `src/providers/byok.ts`, `src/providers/metered.ts`, `src/providers/resolver-pg.ts`, `src/server/api-pg.ts` (encryption and provider-key routes, dispatcher), `src/server/contracts.ts` (provider schemas), `src/mcp/tools-pg.ts` (`requestRegistry`, `get_state`), `web/src/crypto/keys.ts` (`wrapProviderKey`, `providerKeyHandoff`), `web/src/views/MyProviderPanel.tsx` (save flow), `src/db/migrations-pg/010-byok-provider-keys.sql`
- Modify: whatever the review finds, each fix with its own failing test first

**Interfaces:**
- Consumes: the whole branch.
- Produces: a written findings list with every Critical/High resolved or explicitly accepted by the user.

- [ ] **Step 1: Run the full suite first**

Run: `env FABULIST_REQUIRE_TEST_PG=1 pnpm test && pnpm typecheck && pnpm lint && pnpm build:web`
Expected: all green. Do not start the review on a red branch.

- [ ] **Step 2: Dispatch the security reviewer**

Dispatch the `deep-security` agent with this prompt (verbatim):

```text
Adversarial security review of the BYOK provider-key feature on branch feature/agent-upkeep-byok (diff: git diff main...HEAD). Spec: docs/superpowers/specs/2026-09-26-agent-upkeep-and-byok-design.md section B; plan: docs/superpowers/plans/2026-09-26-byok-providers.md.
Files: src/crypto/provider-secret.ts, src/auth/ephemeral-provider-keys.ts, src/auth/provider-keys-pg.ts, src/providers/byok.ts, src/providers/metered.ts, src/providers/resolver-pg.ts, src/server/api-pg.ts (encryption + provider-key routes, dispatcher), src/server/contracts.ts, src/mcp/tools-pg.ts, web/src/crypto/keys.ts, web/src/views/MyProviderPanel.tsx, src/db/migrations-pg/010-byok-provider-keys.sql.
Construct concrete attacks, do not checklist. At minimum try: (1) using, unlocking, replacing or deleting another user's key via any HTTP route or MCP tool, including key-id collisions and the pending-narration resume token; (2) getting plaintext keys into any response, log line, error, usage row, SSE event or MCP result, including via provider error bodies, zod error messages and console.error in errorBody; (3) SSRF or credential exfiltration through endpointId, model ids, /models listing or header injection; (4) AES-GCM misuse: nonce reuse, AAD confusion between sealed and unlock modes, key/length validation, FABULIST_SECRETS_KEY parsing; (5) grant lifetime: lock, expiry, delete and replace mid-turn, cache fill races, and whether JS string copies of the key outlive the zeroed Buffer in ways that matter; (6) rate-limit bypass on save/test/models; (7) whether the server-side save of unlock-mode wraps lets a client plant anything harmful; (8) the browser save flow's handling of the passphrase and master key.
Return findings with severity, attack path, file:line and a concrete fix. Do not edit files.
```

- [ ] **Step 3: Fix findings**

For each Critical/High finding: write a failing test in the owning task's test file that reproduces the attack, run it to see it fail, fix, run it to pass, and commit with `fix(security): <what>` touching only those files. Present Medium/Low findings to the user with a recommendation; do not fix them unasked.

- [ ] **Step 4: Re-verify and report**

Run: `env FABULIST_REQUIRE_TEST_PG=1 pnpm test && pnpm typecheck && pnpm lint`
Expected: green. Report the findings list, what was fixed (commit SHAs) and what was accepted, with the raw test output. Do not merge; merging is the user's call.
