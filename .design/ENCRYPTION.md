# Private stories: encrypting user data so the operator cannot read it

Design and pilot implementation record. Companion to `.design/SAAS-MULTIUSER.md`
(which established identity and per-user isolation as a
`WHERE owner_user_id = $1` predicate) and `docs/privacy-policy.md` §5.

The pilot implements passphrase/recovery enrollment, process-memory story-key
grants, encrypted story values and illustration files, per-story blind indexes,
and an explicit verified migration. Existing stories remain plaintext until
their owner runs that migration. Creating, claiming, forking, or resetting stories after enrollment is blocked
until browser-side key provisioning for a new story is implemented.

The goal, stated as the feature request did: **the operator of a deployment —
holding a database dump, the server filesystem, and root on the box — must not be
able to read what a user wrote.** Sharing a story deliberately makes it readable
and is out of scope here; this document is about the default.

Today that promise is policy, not mechanism. `turns.book_prose` is `TEXT`
(`src/db/schema-pg.sql:507`), so `pg_dump` is the whole attack. Everything below
is about replacing a promise with a key the operator does not have.

---

## 1. The decision that shapes everything else

The server assembles the LLM prompt. That is not incidental — it is the design.
`buildNarratorFrame` (`src/frame/builders-pg.ts:544-559`) puts the last six turns
of the manuscript verbatim into the narrator prompt (`recentProse`, `:396-402`),
alongside full character sheets, scene summaries and the author's pinned style
anchors. After narration, `extract` (`src/loop/engine-pg.ts:435`) sends the whole
newly-written prose *back* to a model to derive the state delta that
`commitDelta` writes.

So there are exactly two honest positions:

| | Server sees plaintext | Cost |
|---|---|---|
| **A. Encrypted at rest** | transiently, in RAM, while an unlocked request is handled | modest; engine keeps working |
| **B. Zero-knowledge** | never | frame assembly + provider calls move to the client; forces per-user BYOK |

**This document specifies A.** A DB dump, a filesystem snapshot, a stolen backup,
and idle `psql` access all yield nothing readable. A live process handling an
unlocked request holds that story's key and requested plaintext in memory for the
duration of the grant/request, and writes neither.

B is not ruled out forever — the `narrateExternally` split
(`src/loop/engine-pg.ts:355-374`, `:520-557`) already proves the server can hand
prompt assembly to an outside model and take prose back — but B requires every
user to bring their own provider credentials, and today credentials are one shared
`process.env` for the whole instance (`src/providers/http.ts:651`, `env` defaulting
to `process.env`; one `Engine` and one registry per process,
`src/cli/serve-pg.ts:246-260`). Encrypting at rest does not depend on that
changing. Making the server blind does. Note also that the existing split still
sends the whole prompt — including the last six turns verbatim — out to a
third-party model, so it moves the trust, it does not remove it.

### 1.1 Pilot processing grant

The selected pilot favors one consistent browser/API/MCP model over separate
client-side read decryption. The browser unwraps every story key locally and
sends those random keys once over HTTPS. The server keeps an owner/story-scoped
grant in process memory for at most four hours and uses it for reads and writes.
Lock, logout, expiry, or process restart clears the grant.

This means the server sees plaintext while an unlocked story is read or
processed, not only during generation. It does not persist the key or plaintext,
and a locked story fails closed. This is weaker than the client-only read model
previously considered here, but matches the stated threat model: protect
database dumps, backups, filesystem snapshots, and idle operator access while
accepting transient backend processing.

---

## 2. Key hierarchy

Four levels, so that changing how you unlock does not re-encrypt a manuscript.

```
passkey (WebAuthn PRF) ──────────▶ KEK_pk ──┐   ← primary, §2.6
passphrase ──Argon2id/PBKDF2(salt)─▶ KEK_pw ─┤
device key (non-extractable) ─────▶ KEK_dev ─┼─wrap─▶ MK (user master key, random 256-bit)
recovery code ────────HKDF────────▶ KEK_rc ──┘          │
                                                        │ wrap
                                                 DEK_s (per story, random 256-bit)
                                                        │
                                                        ├─ HKDF(DEK_s,"content") → content key (AES-256-GCM)
                                                        └─ HKDF(DEK_s,"index")   → IK_s (HMAC, blind indexes §5.2)
```

- `MK` is wrapped **once per enrolled unlock method**, and every wrapped copy lives in
  the database. Any one of them unlocks it; none is useful to the operator, because
  every `KEK` above comes from the user's hardware, memory, or a code only they hold.
  **Never from the server, the session, or the WorkOS id** — see §2.4 and §2.5.
- **Adding, changing or removing an unlock method rewraps `MK` only.** No story is
  re-encrypted. This is the entire reason `MK` exists rather than deriving story keys
  from a passphrase directly, and it is what makes "add a passkey," "add this device"
  and "change passphrase" all cheap.
- `DEK_s` is per story, so a future "share this story" grants one story by
  rewrapping one key to another user, without touching anything else. Sharing is
  out of scope, but the shape should not have to change to add it. It is also what
  lets an MCP grant (§7.3) cover one story rather than the account.

### 2.1 KDF choice: PBKDF2 first, Argon2id behind a field

This applies only to the **passphrase** wrap. A passkey's PRF output (§2.6) and a
recovery code are already high-entropy, so they need HKDF, not a slow KDF — stretching
exists to compensate for human-chosen passwords, and applying 600k iterations to a
256-bit random value is pure cost.

Argon2id is the right primitive for the passphrase case and is not in WebCrypto; it
costs a WASM dependency. This repo runs on seven runtime dependencies
(`package.json`) and that restraint is deliberate.

So: **v1 uses PBKDF2-SHA256 at 600,000 iterations** (WebCrypto native, zero new
dependencies), and `user_keys.kdf` / `kdf_params` record which KDF and parameters
produced a given wrap. Adding `argon2id` later is a new row value and a rewrap on
next unlock, not a migration. Do not skip the `kdf` column to save a field — it is
what keeps the choice reversible, and it is also how a row records "this one is
passkey-PRF, no stretching needed."

### 2.2 Recovery: unrecoverable by design, with a code

At setup the user gets a 256-bit recovery code, base32, grouped, shown once and
downloadable. It wraps the same `MK`.

**There is no operator escrow.** An operator who can recover a key can read the
data, which is the thing this feature exists to prevent. Lose both the passphrase
and the code and the stories are cryptographically gone — the UI must say so in
those words at setup, and the setup flow must require an explicit acknowledgement
plus a re-entry of the passphrase before the first story is encrypted. A
`recovery_code_hint` (first 4 characters) is stored so a user can tell which code
they are holding.

### 2.3 Where the passphrase is stored: nowhere

**The passphrase is never stored, never transmitted to the server, and never goes
near WorkOS.** It is typed into a form, used in the browser to derive `KEK_pw`, and
discarded. What the database holds is `wrap(KEK_pw, MK)` — a blob that reveals
nothing about the passphrase and cannot be reversed into it.

That must stay true in a specific, testable way, because there are three plausible
places it could leak by accident:

- **Not a WorkOS field.** WorkOS is the identity provider and holds exactly what
  `SessionUser` exposes: `id`, `email`, `firstName`, `lastName`
  (`src/auth/config.ts:170-177`). There is no custom-attribute write anywhere in this
  codebase, and there must never be one for key material. Putting a passphrase,
  master key, or recovery code into a WorkOS user attribute would hand it to a third
  party *and* to anyone with WorkOS dashboard access — strictly worse than the
  plaintext `TEXT` column this feature exists to remove.
- **Not the WorkOS session cookie.** `cookiePassword` (`src/auth/config.ts:29`) is
  the AES key WorkOS seals its *own* session payload with. It is operator-held
  configuration, unrelated to the story-key hierarchy, and the two must never be
  conflated — the operator holds `cookiePassword`, which is exactly why nothing in
  §2 may derive from it.
- **Not a server-side hash either.** There is no reason to store even a verifier.
  "Was the passphrase right?" is answered by whether the AEAD unwrap of `MK`
  authenticates. A stored hash would be one more offline-attackable artifact for zero
  functional gain.

So, directly: **a WorkOS admin sees who you are, not what you wrote.** They can see
the account, its email, and its login history. They cannot decrypt a story, because
the wrapped keys live in *this* application's Postgres and the passphrase that opens
them was never sent to anyone.

### 2.4 The identity-provider substitution attack

The question above exposes something the rest of this design has to be explicit
about, and it is the one place WorkOS genuinely matters.

Encrypted rows are looked up by WorkOS user id, and **the operator controls the
WorkOS configuration.** So an operator could point the deployment at an identity
provider they control, mint a session claiming `sub = <victim's id>`, and be served
that user's rows. Today that yields plaintext immediately. Under this design it
yields **ciphertext plus the wrapped-key blobs** — and opening them still needs the
victim's passphrase, which was never stored.

That property holds only because of one rule, which is worth treating as the
load-bearing invariant of the whole document:

> **`MK` is wrapped by the passphrase and the recovery code alone — never by
> anything the server or the identity provider can produce.**

This forbids several tempting shortcuts that would each quietly reintroduce the
operator: deriving a key from the session token, from `cookiePassword`, from the
WorkOS user id, or letting a fresh login re-enrol a device (§6.5) without
re-entering the passphrase. Each one turns "log in as anyone" back into "read
anyone's stories."

The `user_keys` row is therefore keyed *by* the WorkOS id for lookup, but its
contents are not derived from it. An attacker who can forge identity can fetch the
blob and cannot open it — though they do get everything outside the envelope, which
is §8's metadata list.

### 2.5 Why the WorkOS user id cannot be the passphrase

This was proposed directly, and it is worth recording *why* it fails rather than just
ruling it out, because the appeal is real: it would need no password field anywhere, so
every seamlessness problem in §6.5 and §7 would evaporate.

It fails because **the user id is not a secret.** It is:

- a plaintext column in this database (`stories.owner_user_id`,
  `world_access.user_id`, `schema-pg.sql:117,276`) — so it sits *next to* the
  ciphertext it would be protecting, in the same dump;
- indexed (`idx_stories_owner`, `:290`);
- the `sub` claim of every JWT the MCP path verifies (`src/mcp/auth.ts:136`);
- visible in the WorkOS dashboard.

A key derived from it would be recoverable by exactly the person this feature exists
to exclude — from the dump alone, with no WorkOS access needed at all. It is not a
weakened guarantee; it is **encryption with the key printed on the box.** It would be
worse than the current plaintext `TEXT`, because the code and the docs would claim a
protection that does not exist.

The proposal came with two caveats attached — that migrating off WorkOS would require
decrypting first, and that "whoever has the DB *and* WorkOS could decrypt." The second
understates it decisively: **the DB alone is sufficient**, because the id is in the DB.
There is no second factor.

The instinct underneath it is right, though, and §2.6 answers it: the user should not
have to type a passphrase. The fix is a secret the *user's device* holds, not a public
identifier the server holds.

### 2.6 Passkeys are the seamless answer

WebAuthn's **PRF extension** lets a passkey deterministically produce a
high-entropy secret for a given salt. That secret is derived inside the authenticator
(Touch ID, Face ID, Windows Hello, a phone acting for a laptop) and is never stored on
any server.

Used as a `KEK`, it gives exactly what was asked for:

- **Unlock is a fingerprint or a face**, not a typed passphrase.
- **Nothing to remember, nothing to paste.**
- **Synced by the platform** (iCloud Keychain, Google Password Manager), so a new
  phone inherits it without an enrolment dance — which is the answer to IndexedDB
  eviction, the weakness in §6.5's device key.
- **The operator cannot produce it**, satisfying §2.4's invariant: it comes from
  hardware the user holds.

So the intended hierarchy becomes: passkey-PRF as the primary `KEK`, with the recovery
code (§2.2) as the escape hatch, and a passphrase kept as an optional third wrap for
users on platforms or browsers without PRF support.

Two caveats to check before committing: PRF support is good on current Chrome/Safari
but not universal, so the passphrase path cannot be deleted; and a passkey is bound to
its RP ID (the domain), so a self-hosted instance on a different domain enrols its own
passkey — which is correct behaviour, not a bug, but should be documented.

---

## 3. Record format

Per row, one AEAD envelope rather than one ciphertext per column. Forty new
`_enc` columns across thirty tables would be unreadable; a per-row envelope keeps
the diff to two columns per table and makes the field set explicit in one place.

```
ct    BYTEA   -- AES-256-GCM(content key, nonce, plaintext=JSON{field:value,...}, aad)
nonce BYTEA   -- 12 bytes, random per write
kv    INT     -- key version, for rotation
```

**AAD binds the ciphertext to its own row identity:**

```
aad = "fab1" || story_id || table_name || primary_key || kv
```

Without AAD, confidentiality holds but an operator with write access can *move*
blobs — swap turn 12 of one story into turn 3 of another, or replay an old scene
summary — and the client would decrypt it happily. With it, a relocated blob fails
authentication and the client reports tampering rather than rendering a lie.

What this does *not* defend against: deletion, wholesale rollback to an older
dump, or the operator serving modified JavaScript. See §8.

Partial updates (`setProse`, `src/store/chronicle-pg.ts:296-302`;
`appendRerollMeta`, `:311`) become read-modify-write of the envelope. Both already
run inside the turn/regenerate paths, where the key is present.

---

## 4. What gets encrypted, and what deliberately does not

Canon is **not** encrypted. `canon_entities`, `canon_edges`, `canon_sheets`,
`ingest_pages` and the `worlds` tables are ingested wiki material, shared between
users, rebuildable, and not anybody's private writing — `src/db/schema-pg.sql:26-32`
already draws that user/system line as a `GRANT` boundary. Encrypting canon would
break the overlay's ordered index scans (the 1220ms → 1.7ms result at
`schema-pg.sql:163-172`) for no privacy gain.

Encrypted (author's words):

| Table | Fields |
|---|---|
| `turns` | `raw_input`, `book_prose`, `intent`, `delta`, and the prose-bearing part of `meta` (§4.1) |
| `events` | `text` |
| `facts` | `text` |
| `scenes` / `chapters` | `title`, `summary` |
| `threads` | `title`, `stakes`, `resolutions` |
| `directives` | `text` |
| `divergences` | `detail`, `canon` |
| `style_anchors` | `text`, `note` |
| `relationships` | `note` |
| `chron_entities` | `name`, `summary`, `props` |
| `chron_edges` | `evidence` |
| `chron_sheets` | `identity`, `contract`, `voice`, `condition`, `appearance` |
| `stories` | `title`, `style` |
| `illustrations` | `prompt`, `negative_prompt`, **and the image bytes** (§6.3) |
| `prose_blocklist` | `pattern`, `note` (low priority; a per-user preference, but it is a list of phrases someone chose) |

`chron_edges.evidence` is worth calling out because it is easy to miss: it is in
`EDGE_COLUMNS` (`src/db/overlay.ts:218`), never rendered into a prompt, and read by
nothing but the JSON response — yet it holds a **quoted source sentence**. Opaque
to the code is not opaque to a dump.

Four columns have no server-side plaintext reader at all and so cost nothing to
encrypt: `illustrations.negative_prompt` (built from constants — arguably skip it),
`divergences.canon`, `style_anchors.note`, and `relationships.note`. Encrypt them
anyway; a column nothing reads is the cheapest possible case.

Left plaintext on purpose, because it is structural and encrypting it would break
indexed access for little gain: `scene`/`turn` numbers, `salience`, `weight`,
`confidence`, `trust`/`affection`/`respect`, `tension`, timestamps, `status`,
`visibility`, `type`, `kind`, `depth_level`, `chapter`, foreign keys, and
`events.participants` (see §5.3 — this is only safe once ids are opaque).

### 4.1 `turns.meta` must be split, not encrypted whole

`usageTotals` (`src/store/chronicle-pg.ts:277`) does
`SELECT meta FROM turns WHERE story_id = $1` and sums `providerCalls[].tokensIn/Out`
to feed `/api/state`. Those are integers and are not private in any interesting
way; the same JSONB also holds the integrity verdict, the referee's reasoning and
the lint findings, which quote the prose.

Split the column: `meta_usage JSONB` (plaintext counts, keeps `usageTotals` a
plain SQL aggregate) and the rest inside the row envelope. Encrypting `meta`
wholesale would push token accounting into the client for no reason.

---

## 5. What genuinely breaks

Everything else is mechanical. Three items need a real decision (§5.1–5.3); four
more need a small specific one (§5.4).

### 5.1 `resolveName` — and why it is easier than it looks

`GraphStore.resolveName` (`src/store/graph-pg.ts:511-530`) maps a name written in
prose to an entity id, and it queries chronicle names with
`lower(name) = $2` then `lower(name) LIKE $2`. Encrypted names defeat both. It runs
during commit, on every turn, and a chronicle miss means a dropped edge.

Read it closely, though. The LIKE pass is **not** a fuzzy search — it is a
candidate generator whose results are then filtered by
`normaliseName(c.name) === norm` (`:526-528`). There is deliberately no similarity
fallback (`:506-509`, and the measured reason: 14,205 of ~15,700 edges once
attached to the wrong nodes). So the *semantics* of `resolveName` are exactly
**exact match on the normalised name**.

That is a perfect fit for a blind index, with no loss of behaviour:

```sql
ALTER TABLE chron_entities ADD COLUMN name_bidx BYTEA;  -- HMAC-SHA256(IK_s, normaliseName(name))
CREATE INDEX idx_chron_entities_bidx ON chron_entities (story_id, name_bidx);
```

The server computes the tag during commit, when it already holds `DEK_s` and the
plaintext, so the client never needs `normaliseName`. Canon resolution is
unchanged (canon is plaintext). Both of `resolveName`'s passes collapse into one
indexed equality lookup, which is also faster than the LIKE scan it replaces.

The implementation uses a domain-separated HMAC-SHA256 over the per-story DEK
(`fabulist:story-blind-index:v1:graph:name` or `graph:logical-id`), encoded as
base64url. Without the DEK, the tag is opaque and cannot be correlated across
stories. The deliberate cost is equality/frequency leakage within one story: an
operator can see when the same normalized lookup value recurs and how often each
token occurs. This is the accepted trade for indexed equality lookup; substring
search still decrypts chronicle rows in memory.

### 5.2 Substring search has to move

`GraphStore.search` (`src/store/graph-pg.ts:460-486`) does
`lower(name) LIKE $2 OR lower(id) LIKE $2 OR lower(summary) LIKE $2` across
chronicle and canon, feeding `GET /api/search`. Substring matching over ciphertext
is not possible without leaking far more than equality does.

Resolution: **canon arms stay in SQL and are unchanged; the chronicle arm moves to
the client.** `chron_entities` holds a story's divergences and emergent entities —
small by construction (the canon corpora are 33,332 and 11,680 entities; a
chronicle is orders of magnitude below that). The client already fetches the graph
for `GraphView`. Filtering a few hundred decrypted rows in JS is cheaper than the
round trip.

The MCP `search` tool (`src/mcp/tools-pg.ts:1129-1145`, matching fact text and
thread titles) has no client to do this in. See §7.

### 5.3 Stable entity ids are structural metadata

Entity ids are load-bearing cross-store references: they occur in `chron_edges`,
`events.participants` (GIN-indexed, `schema-pg.sql:476`), `relationships`,
`fact_knowledge`, and the `char:`/`loc:` prefix is parsed in
`src/setup/apply.ts` and `web/src/App.tsx`.

V1 deliberately preserves those stable ids rather than transforming them to
opaque values. It keeps every story-owned reference compatible and makes future
conversion resumable without a cross-table identifier rewrite. This is a bounded
privacy tradeoff: ids that themselves contain a human name remain visible, as do
the graph's edge topology, predicates, timing, weights, type, salience and row
counts. New encrypted prose is kept in AEAD envelopes; equality lookup uses the
per-story blind indexes in §5.1, never a raw value or unkeyed hash. A future
opaque-id migration remains a separate, explicitly scoped project.

### 5.4 Four smaller SQL and JS dependencies

Found by inventory; each needs a specific answer, and none is hard once named.

**`NULLIF` on scene and chapter text.** `chronicle-pg.ts:346-354` (and `:380-384`
for chapters) upserts with
`title = COALESCE(NULLIF(EXCLUDED.title,''), scenes.title)`, so Postgres itself
tests the *emptiness* of user text — deliberately, so "a blank patch does not erase
an existing title or summary" when the compactor and the wizard write to the same
row. Ciphertext of an empty string is not empty, so the guard silently inverts.
Add a plaintext `has_title BOOLEAN` / `has_summary BOOLEAN`, or move the
merge into JS inside the turn path where the key is present. **Do not just drop the
`NULLIF`** — it exists because the compactor and the wizard collide.

**Slot emptiness decides whether a prompt slot exists.** `budget.ts:61` filters on
`s.content.trim().length > 0`. Under encryption the server has plaintext during a
turn, so this keeps working — it is listed only because a naive "encrypt reads,
keep the loop" refactor breaks it invisibly.

**`isHub` regexes entity names and summaries.** `propagate-pg.ts:488-492`
tests `/inn|tavern|courier|spy|market/i` against `${e.name} ${e.summary}` to decide
rumour propagation. This runs during `worldTick`, which the REST play routes call
*after* commit (`api-pg.ts:544-548`). The key is still in scope there — so the fix
is to keep the tick inside the keyed window, not to move it.

**Directive recalculation word-matches user text against user text.**
`propagate-pg.ts:527-544` tokenises `directives.text` and scores it against
`threads.title/stakes/resolutions`, mutating `tension` and consequence maturity.
Triggered by `POST /api/directive` (`api-pg.ts:727`) — a route that does not
currently carry a key. Either it joins the keyed route family (§6.1) or directive
recalc moves client-side. Simplest: add the key to that route.

Also worth noting: `resolvePresentIds` (`builders-pg.ts:284-295`) scans the whole
cast and filters in JS on `condition.locationId`, a field inside the sheet
envelope. It is already a JS-side scan, so it survives — but it means "who is on
stage" needs the sheets decrypted, which is another reason the turn path is the
keyed one.

### 5.5 The tie-break index still works

`idx_chron_entities_salience (story_id, salience DESC, name)`
(`schema-pg.sql:360-361`) exists so the overlay's chronicle arm is an ordered
index scan that stops at N. `salience` stays plaintext, so the index keeps its
job. Only the `name` tie-break becomes ciphertext order — arbitrary but stable,
and the overlay collapses by `DISTINCT ON (id)` regardless. No correctness impact.
Do not drop the column from the index; the header comment at `:166-170` explains
why the tie-break must stay present.

---

## 6. Wire and client changes

### 6.1 Key handoff for the turn

The client sends `DEK_s` (base64) **in the POST body** of `/api/play/stream`, not
in a header or query string — headers and URLs are what proxies and access logs
capture by default, bodies are not. The server holds it in a local variable for
the life of the request.

Non-negotiable, and worth a test each: never logged, never written to disk, never
put on the `Engine` instance, never included in an error message or a `meta` blob.
`RAW_BODY_ROUTES` is currently declared and empty (`src/server/api-pg.ts:216`), so
every body is JSON-parsed — the key must be stripped from the parsed object before
anything else can see it.

Optional hardening, worth doing if it is cheap: wrap the key to an ephemeral
server ECDH public key so it is not recoverable from a proxy buffer or a heap
dump of the request. It does not change the threat model (the server sees the key
either way) but it shortens the window.

Same handoff for `POST /api/scene/close`, `POST /api/turn/:id/regenerate`,
`POST /api/compact`, and the illustration routes — every path that calls a model
with prose.

### 6.2 The 3-second poll

`LIVE_POLL_MS = 3000` (`web/src/App.tsx:296`) re-reads the whole book every three
seconds while the tab is visible, because an MCP client may be writing to the same
story. Decrypting the entire manuscript on that cadence is wasteful.

Cache decrypted turns client-side by turn id and decrypt only ids not already
held. Add an ETag or a `max(turn)` cursor to `/api/book` so an unchanged book is a
304 and no decryption happens at all. This is a performance fix the polling loop
arguably wants regardless of encryption.

### 6.3 Two things that never pass through JavaScript

- **`GET /api/export`** is an `<a href>` download (`web/src/api.ts:725`,
  `App.tsx:737,746`); the server builds the file (`exportMarkdown`/`exportPlainText`,
  `src/loop/export-pg.ts`). Under encryption the server cannot. Export moves to
  the client: assemble from already-decrypted turns, `Blob`, object URL, download.
  The server-side export path stays for unencrypted stories.
- **Illustration bytes are files on disk, not rows** — deliberately
  (`schema-pg.sql:589-592`), and served straight to `<img src>`
  (`web/src/api.ts:755`). A scene illustration is a *picture of the scene*: an
  operator browsing the images directory reads the story visually, no SQL needed.
  So the PNG bytes must be encrypted at rest too, and the client must fetch them
  as ciphertext, decrypt, and render via `createObjectURL`. This also kills the
  `cache-control: public, max-age=31536000, immutable` header at
  `api-pg.ts:948` — an object URL is not an HTTP cache entry.

Encrypting image bytes is the single most easily forgotten part of this design and
one of the largest leaks. It is not optional.

### 6.4 Client crypto from zero

There is no crypto in `web/src` today — no `crypto.subtle`, no `TextEncoder`, no
IndexedDB, no service worker; the only client persistence is a story id in
`sessionStorage` and a theme in `localStorage`. The manifest
(`web/index.html:22`) is icons-only and provides no offline scaffolding.

So a new `web/src/crypto/` module is genuinely new surface: KDF, wrap/unwrap,
envelope open/seal, a decrypted-row cache, and an in-memory key holder.

`REQUIRED_ROUTES` (`web/src/api.ts:592-612`) is diffed against `/api/meta` to
raise the "page is newer than the server" banner. New routes must be added there
or the staleness check misfires.

### 6.5 Unlocking must not feel like a chore

An earlier draft of this document said the key lives only in a module-scoped
variable, so every page reload demands the passphrase again. That is defensible
cryptography and bad product design — for a non-technical user it reads as "the app
keeps locking me out," and the 3-second book poll (§6.2) means a reload is common.
A feature people turn off is worth nothing.

So: **the passphrase is asked for once per device, not once per page load** — and with
§2.6's passkey path, ideally never typed at all.

**Primary: passkey (WebAuthn PRF), per §2.6.** Unlock is Face ID / Touch ID / Windows
Hello. Because passkeys are platform-synced, a new phone or a reinstalled browser
inherits the ability to unlock with no enrolment step and no re-typing — which is also
the answer to the storage-eviction problem below.

**Fallback: a device key**, for browsers without PRF. Wrap `MK` to a key held in
**IndexedDB as a non-extractable `CryptoKey`**. WebCrypto can store a key object that
JavaScript may *use* but cannot read the bytes of, so it survives reload, and an XSS
payload can borrow it while the page is open but cannot exfiltrate it for later. That is
materially better than a raw key in `localStorage`, which is the naive version and which
really would hand the key to any XSS.

Note the mobile weakness this fallback carries, and why passkeys are preferred: **iOS
Safari evicts IndexedDB after roughly seven days without a visit.** A user who plays
fortnightly would be re-prompted for their passphrase every time and would reasonably
conclude the app is broken. Passkeys have no such expiry.

The resulting flow:

- **First use, with a passkey:** a biometric prompt. Nothing typed, nothing to
  remember.
- **First use, without PRF support:** enter passphrase, tick "remember this device."
- **Every reload after:** silent unlock (device key) or one biometric touch (passkey).
- **Explicit "lock" control**, and a "forget this device" that deletes the wrapped
  copy — the shared-computer answer.
- **A device and passkey list in settings**, so a lost laptop's copy can be revoked
  from elsewhere.

The honest caveat: remembering the device means someone with access to the *unlocked
machine* can read the stories, exactly as they could read any signed-in web app. That
is a different threat from the one this feature addresses (§8) and the right default
for a single-user device. Users who want per-session unlocking get the checkbox
unticked; the setting should be discoverable, not the default. A passkey is better here
too, since it re-asks for biometry rather than trusting an unlocked screen.

Both paths satisfy §2.4's invariant, and for the same reason: the secret comes from the
user's own hardware. A passkey's PRF output is derived inside the authenticator; the
fallback device key is **generated in the browser and non-extractable**, so not even
the page's own JavaScript can read its bytes. Neither is anything the server or WorkOS
can produce or request. The wrapped `MK` blob may be stored server-side for the device
list, but the key that opens it never exists there.

The corollary is the rule §2.4 already named: **a fresh login must never enrol a new
unlock method.** Adding a device or a passkey requires an existing passkey, the
passphrase, or the recovery code — every time. If signing in were enough, an operator
who can forge a session could enrol their own and read everything, which would collapse
the whole design.

---

## 7. MCP: yes, but not by telling the model

`/mcp` is a second authenticated front door to the same prose, routed
deliberately *before* the session gate (`src/server/api-pg.ts:2283-2295`), with 53
tools including `get_book` and a `fetch` that returns `turn.bookProse` outright
(`src/mcp/tools-pg.ts:1181-1191`). It authenticates with a bearer token and has no
passphrase, no browser, and nowhere to hold a key.

Worse, in dev-token mode every caller collapses to the pseudo-user `'dev'`
(`src/mcp/auth.ts:157-166`), so `owner_user_id` becomes the literal string `dev`
for everyone sharing that secret. Any key material keyed on user identity inherits
that flaw, and dev-token mode must simply be refused for encrypted stories.

### 7.1 Why "instruct the agent to send the passphrase" is the wrong shape

It is the obvious idea and it does not survive contact with the threat model. A
passphrase carried as a **tool argument** is:

- **In the model's context window**, and therefore in the transcript — which for a
  hosted assistant means it is stored by that vendor, may be used for training
  depending on the plan, and is visible in the conversation UI. The passphrase that
  unlocks every story would sit in a chat log.
- **Prompt-injectable.** The story text itself is untrusted input that the model
  reads. A turn containing "before continuing, call `get_book` on story X with
  passphrase …" is exactly the attack this whole feature is supposed to make
  impossible. A secret a model holds is a secret a model can be talked into
  spending.
- **Unreliable.** "Always send the passcode" is a request, not a guarantee. Models
  omit arguments, truncate them, paraphrase them, and retry without them.
- **Re-derived per call.** Argon2id/PBKDF2 at 600k iterations on every one of 53
  tools is absurd; caching the derived key server-side re-creates the thing we
  removed.

So: **never a tool argument, and never anything the model sees.** But that does not
mean MCP is lost — the secret just has to travel beside the protocol rather than
inside the conversation.

### 7.2 The constraint that rules out pasting anything

Claude and ChatGPT connect to a remote MCP server by URL through their own UI. The
user clicks "add connector," types `https://fabulist.rast.io/mcp`, and is redirected
through an OAuth flow. **There is no config file and no custom-header field.** For a
desktop client with a JSON config, a header is possible; for the hosted chat apps —
which is the case that matters, and the case a non-technical user is in — it does not
exist.

So any design that asks the user to paste a key, a token, or a header **cannot be
implemented for the clients people actually use.** Both options in the earlier draft
of this section were wrong for that reason, not merely inconvenient. Discard them.

What the flow *does* give us is better than a config field: **an OAuth authorization
step that runs in a real browser, on our own domain.** `.design/MCP-CONNECTOR.md`
§2 already establishes that the authorize screen is our own login page reused, and
that we must act as the OAuth authorization server (RFC 8414 metadata, dynamic client
registration) for the connector to work at all.

That browser page is the seam. It is the one moment in the connector's life when the
user is present, on our origin, with JavaScript we control — exactly the conditions
the web app already uses to unlock a story.

### 7.3 The design: unlock at consent, wrap to the token

The connector never learns the passphrase and never holds a key the user pasted.
Instead, unlocking happens once during authorization:

1. The user adds the connector in Claude/ChatGPT. It redirects to our authorize
   endpoint.
2. Our page loads. The user signs in as normal — **and, because this is our origin
   with our JavaScript, is prompted for their passphrase** in the same component the
   web app uses. It looks like one extra field on a consent screen: *"Unlock your
   private stories so Claude can read and write them."*
3. In the browser, the passphrase unwraps `MK`, and from it the `DEK_s` of each story
   the user consents to share. A checkbox list of stories is the consent UI, which is
   also the scoping mechanism.
4. **The browser wraps those `DEK_s` values to the access token that is about to be
   issued**, and posts the wrapped blobs to the server as part of completing the
   authorization. The server stores blobs it cannot open.
5. The connector receives an ordinary OAuth access token. On each tool call it sends
   that token as it already does (`src/mcp/auth.ts:105-109` extracts it today). The
   server derives the unwrapping key from the presented token, opens the blobs it
   needs, and holds the plaintext key for that request only.

From the user's side, the entire encryption feature is **one password field on a
screen they were already going to see**, plus checkboxes for which stories to share.
Nothing to copy, nothing to paste, nothing to keep. That is the bar you set, and this
meets it.

Mechanically this is the same "wrap the story key to a secret the server only sees
per request" trick the discarded designs used — but the secret is the OAuth token the
protocol already issues and transmits, rather than a value a human has to move
between two applications.

**This is a deliberate, bounded exception to §2.4's invariant, and it must be labelled
as one.** The token is minted by us, so an operator who is willing to forge one can
open the grant blobs for the stories the user consented to share. That is strictly
weaker than the browser path, where `MK` is reachable only through the passphrase.

Three things keep it honest rather than a hole:

- **It is opt-in, per story, at a screen that says so.** Nothing is wrapped to a
  token until the user ticks a box on the consent page.
- **It covers only the shared stories.** `MK` itself is never wrapped to a token, so
  the exception cannot widen to the whole account — an operator who forges a token for
  a connector granted one story gets one story.
- **It is revocable, and revocation is visible to the user** in both Claude's UI and
  ours.

If that trade is unacceptable for a given story, the correct answer is to not connect
a connector to it — which is why §7.6 ships "opaque to MCP" first and why the consent
screen must state the trade in plain words rather than bury it.

### 7.4 What follows from tying keys to the token

**Token refresh must re-wrap.** OAuth access tokens are short-lived and refresh
rotates them. If keys are wrapped to the access token, every refresh invalidates
them and the connector silently stops being able to read — the worst possible failure
mode, because it looks like data loss.

Fix: wrap to a value that survives refresh. Either wrap to the **refresh token**
(longer-lived, and the server sees it at each refresh, so it can re-wrap the blobs to
the new access token as part of the exchange), or mint a per-grant random secret at
authorization, wrap the keys to *that*, and store it encrypted to the refresh token.
The second is more indirection but keeps a single stable wrapping key across the
grant's whole life. **Decide this before implementing** — it is the one detail that
determines whether the connector keeps working on day two.

**Revocation is free and already meaningful.** Disconnecting the connector in
Claude's UI revokes the token; the stored blobs become unopenable. Revoking in our
own UI does the same by deleting the grant row. Either way the story stays encrypted
and nothing needs re-encrypting.

**Re-consent is the price of adding a story.** Keys are wrapped at authorization for
the stories chosen then. Sharing a story later means the user re-visits the consent
screen. That is acceptable — it is also the honest UI for "this connector can now
read one more thing."

**The consent screen runs in an in-app webview, and that is fine.** On mobile, adding
a connector opens the authorize page inside Claude's or ChatGPT's own webview, which
may have no access to the real browser's IndexedDB and may be discarded the moment the
flow completes. This looked like it broke the design; it does not, because of *when*
the key work happens.

The webview only needs to do one thing, once: unwrap `MK`, wrap the chosen `DEK_s`
values to the grant, and post the blobs. After that the webview is disposable — the
grant lives server-side and the connector authenticates with its token. **Nothing needs
to persist in the webview at all**, so eviction and storage isolation are irrelevant to
this path.

What the webview *does* need is a way to unlock `MK` without a synced device key it
cannot see. That is precisely where §2.6 pays for itself: a **passkey prompt works in a
webview** (Face ID / Touch ID surfaces normally, and the credential is
platform-synced rather than origin-storage-bound), so the user authenticates
biometrically on a screen they were already looking at. The passphrase field remains the
fallback for platforms without PRF, and typing it once per connector setup — rather than
once per app launch — is an acceptable worst case.

Two things to verify during implementation, because they are webview-specific and
cannot be settled from this codebase: that the target clients' webviews permit a
WebAuthn `navigator.credentials.get()` call (they are ordinary system webviews, so this
is expected, but expected is not verified), and that the redirect back to the client
survives the passkey round trip.

**Dev-token mode must refuse encrypted stories outright.** It collapses every caller
to the pseudo-user `'dev'` (`src/mcp/auth.ts:157-166`) with no per-user token to wrap
anything to. It is a local development affordance and cannot participate in this.

### 7.5 What this still costs, stated plainly

**The server sees plaintext during an MCP tool call**, exactly as it does during a
browser turn (§1). That is unchanged and unavoidable under this document's threat
model; the point is that no durable readable copy exists and no key sits in a
third-party config file.

**The grant is a standing capability.** Between authorization and revocation, the
server can open those stories on presentation of the token — and the operator
controls the server. A user who wants the strongest guarantee should not connect a
connector to a private story. The UI should say that at the consent step, not bury it
in a policy document.

**And MCP already sends the manuscript to a third party regardless.**
`propose_turn` returns the whole narrator frame — last six turns verbatim, full
sheets, scene summaries — to the calling model (`src/loop/engine-pg.ts:372-373`).
Encryption protects the story from *us*; it cannot protect it from the assistant the
user deliberately pointed at it. Say so plainly on the consent screen.

### 7.6 Staging

**v1: encrypted stories are opaque to MCP.** Prose-returning tools report
`story is encrypted; open it in the browser`. Ships with Stage 2, keeps the promise
honest, and requires nothing new.

**v2: unlock-at-consent, per §7.3.** Its own change, with its own tests: wrap and
unwrap across a full authorize flow, **refresh-survives-rewrap** (the failure mode in
§7.4), revocation making blobs unopenable, per-story scoping enforced, dev-token mode
refused, and a test asserting no key material ever appears in a tool argument, a tool
result, or a log line.

Note the ordering dependency: this requires us to be the OAuth authorization server,
which `.design/MCP-CONNECTOR.md` §1 describes as real work beyond a login page. If
that is not yet built, v2 waits on it — which is another reason v1 is "opaque" rather
than "clever."

Do **not** quietly let the MCP path keep reading plaintext while the browser
advertises encryption; that would make the feature a lie for anyone who has ever
linked a connector.

---

## 8. What the operator can still see, and the one attack this cannot stop

State this in `docs/privacy-policy.md` rather than implying more than is true.

Still visible with a dump: that a story exists, its owner, its timestamps, scene
and turn counts, how many entities and edges and events it has, `salience` and
relationship numerics, entity *types* and canon predicates, which worlds it reads,
token usage totals, and — via blind-index equality — whether two entities share a
name, plus confirmation of a *guessed* name only with the story key.

Not defended: **deletion and rollback.** An operator can destroy data or restore
an older dump. AAD makes silent relocation of a blob fail loudly; it cannot make
the absence of a row detectable. Detecting rollback needs a client-held hash chain
over turn ids, which is worth considering later and is not in v1.

**And the fundamental limit: the server ships the JavaScript that does the
encryption.** An actively malicious operator can serve a modified bundle that
exfiltrates the passphrase. No web-delivered E2EE escapes this — it is the honest
ceiling on the whole feature, and it must be written down plainly rather than
implied away.

What it does buy, precisely: a passive operator, a stolen backup, a leaked dump, a
subpoena served on the database, a compromised host, and idle curiosity all get
nothing. That is a large and real improvement over `TEXT`. It is not a promise
that a hostile operator cannot attack a user who keeps using their server.

Mitigations worth listing without pretending they are complete: publish build
hashes, keep the bundle reproducible, add SRI, and note that a self-hosted or
desktop client is the only way to remove the operator from the trust path
entirely.

---

## 9. Scope: two stacks, one of which must be decided first

`src/server/api.ts` (91 routes) and `src/loop/engine.ts` are a complete SQLite
twin of the Postgres stack, still wired to `pnpm serve-sqlite`
(`package.json:47`), sharing the identity layer, the provider layer, the MCP tool
contract and the browser bundle. `src/db/schema.sql` is a third data-at-rest
location.

If the encryption work changes the wire format of `/api/book`, `/api/play/stream`
or `/api/export` — it does — then either the twins move in lockstep or
`pnpm serve-sqlite` serves a client it no longer matches.

**Decide before starting.** Recommendation: scope this to `-pg` and freeze or
retire the SQLite stack in the same release, because `deploy/` and the Dockerfile
already point only at `-pg`. Doing the work twice for an entry point nothing
deploys is not a good trade.

---

## 10. Staging

Each stage ships something true on its own.

**Stage 0 — decide.** SQLite stack in or out (§9). MCP is no longer an open
question — §7 settles it: opaque in v1, unlock-at-consent in v2 — but confirm the
staging, since "MCP keeps working" is the requirement most likely to change the
order of everything after. Note that v2 depends on us being the OAuth authorization
server, which may not exist yet.

**Stage 1 — key management, no data encrypted.** `user_keys` and `story_keys`
tables; `web/src/crypto/`; setup flow with **passkey enrolment (§2.6) as the primary
path**, passphrase as fallback, recovery code, and the unrecoverability
acknowledgement; unlock, add/remove unlock method (rewrap `MK` only);
**device-key fallback per §6.5 (`remember this device`, lock, forget, device list)**;
`stories.encrypted` + `enc_version` defaulting to false. Nothing is encrypted yet
and nothing breaks. Tests: wrap/unwrap round trip, recovery-code path, rewrap
leaves `DEK_s` untouched, wrong passphrase fails cleanly, device key survives reload,
forget-device makes the stored wrap unusable, and **passkey PRF derives the same
`KEK_pk` across two separate sessions** — the property the entire passkey path rests on.

Verify PRF availability early, before building UI around it: §2.6 notes support is not
universal, and the passphrase path cannot be deleted.

One more Stage 1 test, and it is the most important one in the document: **a forged
session must not yield plaintext.** Construct a valid session for user B, request user
A's story, and assert the response is ciphertext and that no code path derives a key
from the session, the user id, or `cookiePassword` (§2.4). This is the test that keeps
the operator out; everything else is mechanics.

Note this finally adds the row the schema has never had: there is no `users` table
(30 tables, none for users) and `stories.owner_user_id` is a bare nullable `TEXT`
with no FK. `user_keys` is *not* a users table — identity stays in WorkOS — it is
key material only, keyed by the WorkOS user id.

**Stage 2 — the append-only leaves.** `turns`, `events`, `facts`, `scenes`,
`chapters`, `style_anchors`, `divergences`, `directives`, `relationships.note`,
`threads`, `stories.title`/`style`. Client-side decryption for all reads; key
handoff on the turn path; `meta` split (§4.1); client-side export (§6.3). This is
the bulk of the manuscript and the bulk of the value.

**Stage 3 — the graph.** `chron_entities`, `chron_sheets`, and per-story keyed
blind indexes for normalized name and logical-id lookup. Stable entity ids remain
plaintext structural references; the accepted residual leakage is intra-story
equality/frequency plus graph shape. The lookup token is an HMAC under the random
story key, never a raw or unkeyed hash.

**Stage 4 — illustrations.** Encrypt prompts and image bytes at rest, fetch as
ciphertext, render via object URL, drop the immutable cache header (§6.3).

**Stage 5 — migration of existing stories.** Explicit, owner-wide, and resumable.
The browser must unlock every owned story first. The server encrypts each value
under that story's key, verifies the persisted envelope, then clears the legacy
column. Illustration files use an atomic encrypted-file write and verification
before the plaintext file is removed. The legacy prose blocklist is user-wide,
so verified per-story copies are created for every owned story before its shared
plaintext rows are deleted. Durable checkpoints block browser and MCP content
access after any partial failure; every story moves to version 1 only in the
final successful transaction.

**Stage 6 — documentation.** `docs/privacy-policy.md` §5 currently says story
content is "never shown to another user"; it should say what is now
cryptographically true, including §8's limits and the JS-delivery ceiling.

---

## 11. Open questions

1. **Per-story or per-user opt-in?** Per story is finer and matches `story_keys`,
   but a user who wants privacy wants it by default. Suggest: a per-user default
   applied to new stories, overridable per story.
2. **Which wrapping target survives OAuth refresh?** (§7.4) — refresh token, or a
   per-grant secret stored encrypted to it. This is the one open question that can
   break the connector on day two, so settle it before writing v2.
3. **`prose_blocklist`** has no UI at all today (`web/src/api.ts:895-898` has no
   call site). Encrypt it, or build the UI first, or leave it.
4. **Rollback detection** (§8) — a client-held hash chain over turn ids. Cheap to
   add later, cannot be retrofitted over history that was never chained.
5. **Illustration cache** — losing `immutable` on image responses may be
   noticeable on an image-heavy story. Measure before deciding whether a
   client-side blob cache is needed.
6. **Compaction is the one irreversible keyed operation.** `compact-pg.ts:137-141`
   overwrites `scenes.summary` with LLM-derived text, and thereafter the frame
   renders the summary instead of the prose (`builders-pg.ts:404-409`). It must run
   inside the keyed window, which it does today (scene close is a keyed route in
   §6.1) — but it means a story cannot be compacted by a background job that has no
   key. If batch or scheduled compaction is ever wanted, it needs the client
   present. Worth knowing before someone proposes a cron job.
7. **Does the recovery code need a second use?** Largely answered by §2.6: with
   platform-synced passkeys the "new device can't unlock" case mostly disappears, since
   the passkey travels with the user's account. It still matters for the passphrase
   fallback, and for a user who loses every enrolled device at once. Suggest: the
   recovery code is sufficient to enrol a new unlock method, and the UI nags until it
   has been saved somewhere.
8. **Does a WebAuthn call work inside Claude's and ChatGPT's in-app webviews?** §7.4
   depends on it for mobile connector setup. Expected to work (they are ordinary
   system webviews) but unverified, and unverifiable from this codebase. Test on a real
   device before committing to the passkey-in-webview flow; the passphrase field is the
   fallback if not.

---

## 12. Defects found while surveying, unrelated to encryption

Recorded here because they were verified during this survey and one of them will
be blamed on this feature if it is not fixed first.

- **`engine.lastFrames` is never assigned** (`src/loop/engine-pg.ts:179` declared,
  `:465` read, no write). `TurnMeta.frameLog` is therefore always `null` and
  `GET /api/frames` always returns `{}` — the "why?" panel's frame budget, which
  `.design/GAPS.md` §1.1 called the whole transparency argument, is dead.
- **The `narrateExternally` pending TTL is not enforced.**
  `PENDING_NARRATION_TTL_MS` is checked only by the lazy sweeper
  (`engine-pg.ts:492`), which runs only on the next `pending.set` (`:371`);
  `commitExternalNarration` never checks age. On an idle server a resume token
  stays redeemable indefinitely, and the error string at `:522` claims otherwise.
- **`PendingNarration` stores no `userId`** (`:143-155`); the only resume guard is
  a `storyId` equality check (`:528-533`).
- **`propose_turn` is annotated `readOnlyHint: true`** (`src/mcp/server-pg.ts:404`)
  but the referee upserts emergent entities before the pause
  (`engine-pg.ts:311-329`), so an abandoned proposal mutates the graph.
- **`commit_narration` skips `seedConsequences` and `worldTick`**, which both REST
  play routes run (`api-pg.ts:544-548`, `:1626-1630`). A story played entirely
  through MCP never seeds consequences or advances the world clock.
- **`switch_world` is documented but not registered** in the `-pg` tool set
  (`server-pg.ts:112`, `:956`); it was replaced by `set_story_sources` and
  `switch_story`. A model following the instructions calls a tool that does not
  exist.
- **`tools-pg.ts:172-179`** still says ownership "is deliberately left unset here
  … future work" while `:185` sets `ownerUserId: ctx.user.id`.
