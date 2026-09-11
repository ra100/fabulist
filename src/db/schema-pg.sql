-- Fabulist schema, Postgres. See DESIGN.md §2 for the canon/chronicle idea and
-- `.design/DBFIXES.md` for the migration history that led here.
--
-- ============================================================================
-- WHAT CHANGED FROM THE SQLITE SCHEMA, AND WHY
-- ============================================================================
--
-- The SQLite version kept canon and chronicle rows in ONE table, discriminated
-- by a `layer` column, with `story_id` NULL for canon. That was forced: one
-- file held one world, so there was nowhere else to put canon. It cost three
-- things this schema gets back.
--
-- 1. **Real foreign keys.** `entities.story_id` had to be nullable (canon has
--    no story), so the "canon rows have no story, chronicle rows must have
--    one" rule lived in a CHECK constraint (old schema.sql:72) instead of the
--    type system. Splitting the tables makes `story_id`/`world_id` NOT NULL
--    with actual REFERENCES, so the database enforces what a comment used to.
--
-- 2. **Uniqueness without NULL games.** `story_id` being nullable meant a
--    composite PRIMARY KEY silently admitted duplicate canon rows, because
--    SQL treats NULL as never equal to NULL. The old schema worked around it
--    with `UNIQUE INDEX ... (id, layer, COALESCE(story_id, ''))`. With the
--    tables split, `PRIMARY KEY (world_id, id)` and `PRIMARY KEY (story_id,
--    id)` are just primary keys.
--
-- 3. **A grantable user/system boundary.** This is the one that motivated the
--    migration. Canon is *system* data: ingested, admin-owned, rebuildable
--    from the wiki. Stories are *user* data: irreplaceable. With them in one
--    table no privilege could tell them apart, so "the play path must not
--    corrupt canon" was a code-review promise. Here `canon_*` and the
--    story-scoped tables are different tables, so it is a GRANT — see
--    `schema-pg-roles.sql`.
--
-- Layering is otherwise unchanged and still the heart of the design: canon
-- rows are ingested and immutable at play time; chronicle rows overlay them
-- copy-on-write. Reads resolve `chronicle ?? canon`, which is what lets one
-- ingest support many playthroughs and still answer "what did the source
-- material actually say?". What used to be `layer = 'canon'` is now "lives in
-- canon_entities"; what used to be `layer = 'chronicle' AND story_id = ?` is
-- now "lives in chron_entities with that story_id".
--
-- A story reads canon from N worlds, not one (`story_sources`) — that is what
-- makes a crossover possible. Precedence is chronicle first, then each source
-- in `ordinal` order. See `src/db/overlay.ts` for the queries, which must stay
-- index-ordered and LIMIT-bounded per arm: the naive UNION-then-sort form was
-- measured at 1220ms where the bounded form is 1.7ms.

-- ============================================================================
-- migrations: the schema version marker
-- ============================================================================
-- `.design/DBFIXES.md` asked for this before the scoping axis moved, and it is
-- what makes an automatic importer safe to run on every boot: without a
-- durable record of what has already been applied, "is this database new,
-- half-migrated, or current?" is unanswerable, and the importer would either
-- re-run destructively or refuse to run at all.

CREATE TABLE IF NOT EXISTS migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- SYSTEM DATA — canon. Rebuildable by re-ingesting; not owned by any user.
-- ============================================================================

-- One row per ingested world (a fandom, a wiki, an authored setting).
--
-- `revision_watermark` and `last_refreshed_at` are what make refresh possible
-- at all. The SQLite schema recorded `ingest_pages.revision` per page and
-- never read it back, so "what changed upstream since we last looked" had no
-- answer and the only whole-world rebuild available was a destructive reset
-- that deleted every story with it.
CREATE TABLE IF NOT EXISTS worlds (
  id                 BIGSERIAL PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  title              TEXT NOT NULL DEFAULT '',
  -- Attribution for the "recipe not payload" posture in
  -- docs/legal-briefing-fandom-ingest.md: a world knows where it came from.
  licence            TEXT NOT NULL DEFAULT '',
  ingest_context     JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision_watermark TEXT NOT NULL DEFAULT '',
  last_refreshed_at  TIMESTAMPTZ,
  -- See `world_access` for what these mean and why 'public' is the default.
  visibility         TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who may see and ingest into a world.
--
-- Worlds are system data shared by every story that reads them, so "may this user
-- see this world" is not answerable from the story tables — the question could not
-- even be asked when a world was a file on one laptop. Two things it decides:
--
--   * `visibility = 'public'` means every signed-in user may read the world and
--     point a story at it. That is the right default for an ingested wiki: the
--     canon is not anybody's private writing, and hiding it by default would make a
--     shared instance useless until an admin granted each world individually.
--   * `visibility = 'private'` means only the rows below may. For a world someone
--     is still building, or one whose source material is not meant to be shared.
--
-- A row grants one user a role *on top of* visibility, so a private world can name
-- its readers, and a public world can name who may re-ingest it. `role`:
--   'reader'  — may read canon and point a story at it.
--   'ingest'  — may also run the wizard against it and refresh its canon.
--   'owner'   — may also rename it, change its visibility, and delete it.
--
-- Deliberately *not* enforced by Postgres roles. The grants in schema-pg-roles.sql
-- separate user data from system data (a play connection cannot write canon at
-- all), which is a different question from which humans may see which world — that
-- one changes per row, and encoding it as database roles would mean a role per
-- user. Enforcement lives in `store/access-pg.ts`, called by the routes.
CREATE TABLE IF NOT EXISTS world_access (
  world_id   BIGINT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  -- Empty string is the login-off local case, matching `stories.owner_user_id`
  -- and `prose_blocklist.user_id`: one person on one laptop, no identities.
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'reader' CHECK (role IN ('reader','ingest','owner')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_world_access_user ON world_access (user_id);

-- Per-source detail within a world. A world can ingest more than one wiki
-- (data/worlds/star-trek-alpha-beta really does hold two: `enmemoryalpha` and
-- `startrek`), and each has its own base URL, licence and revision cursor.
CREATE TABLE IF NOT EXISTS world_sources (
  world_id           BIGINT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  wiki               TEXT NOT NULL,
  base_url           TEXT NOT NULL DEFAULT '',
  licence            TEXT NOT NULL DEFAULT '',
  revision_watermark TEXT NOT NULL DEFAULT '',
  last_refreshed_at  TIMESTAMPTZ,
  page_count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, wiki)
);

-- Canon entities. Was `entities WHERE layer = 'canon'`.
--
-- `retired_at_revision` rather than DELETE, because refresh must never remove
-- a row a story might reference: no foreign key can span the canon/chronicle
-- overlay (an id is valid if *either* a canon row or this story's chronicle
-- row exists, which SQL cannot express), so deleting canon out from under a
-- playthrough would produce exactly the dangling reference
-- `store/integrity.ts` exists to catch. NULL means live.
CREATE TABLE IF NOT EXISTS canon_entities (
  world_id            BIGINT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id                  TEXT NOT NULL,
  type                TEXT NOT NULL,
  name                TEXT NOT NULL,
  summary             TEXT NOT NULL DEFAULT '',
  provenance          TEXT NOT NULL DEFAULT 'authored',
  confidence          REAL NOT NULL DEFAULT 1.0,
  salience            REAL NOT NULL DEFAULT 0.5,
  depth_level         INTEGER NOT NULL DEFAULT 0,
  props               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_scene       INTEGER NOT NULL DEFAULT 0,
  retired_at_revision TEXT,
  PRIMARY KEY (world_id, id)
);

-- The index the whole design rests on. Measured: the frame-building query
-- (top-N by salience across canon plus chronicle) ran at 82 TPS / 1220ms
-- without it and 57,532 TPS / 1.7ms with it, because it turns a full scan and
-- sort of every canon row into an ordered index scan that stops at N. `name`
-- is included because it is the tie-break in ORDER BY salience DESC, name —
-- without it Postgres still has to do an incremental sort (measured 7.5ms).
-- Do not drop this index. Do not add a tie-break column to that ORDER BY
-- without adding it here too.
CREATE INDEX IF NOT EXISTS idx_canon_entities_salience
  ON canon_entities (world_id, salience DESC, name);
CREATE INDEX IF NOT EXISTS idx_canon_entities_type  ON canon_entities (world_id, type);
CREATE INDEX IF NOT EXISTS idx_canon_entities_depth ON canon_entities (world_id, depth_level);
CREATE INDEX IF NOT EXISTS idx_canon_entities_name  ON canon_entities (world_id, lower(name));

-- Canon edges. Was `edges WHERE layer = 'canon'`.
--
-- Temporally scoped, unchanged from SQLite: nothing is deleted, relations
-- expire. `valid_to IS NULL` means still in force, so "who is an ally now" is
-- a time-filtered walk.
--
-- No `valid_to` is ever written here by the play path: retiring a canon edge
-- copies it into a chronicle row instead (see GraphStore.retireEdge). A
-- non-NULL `valid_to` on a canon edge would mean canon had been mutated by a
-- playthrough, which is the bug the split exists to make impossible — there
-- is a test asserting the column stays NULL.
CREATE TABLE IF NOT EXISTS canon_edges (
  eid        BIGSERIAL PRIMARY KEY,
  world_id   BIGINT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  subject    TEXT NOT NULL,
  predicate  TEXT NOT NULL,
  object     TEXT NOT NULL,
  valid_from INTEGER NOT NULL DEFAULT 0,
  valid_to   INTEGER,
  weight     REAL NOT NULL DEFAULT 0.5,
  provenance TEXT NOT NULL DEFAULT 'authored',
  confidence REAL NOT NULL DEFAULT 1.0,
  evidence   TEXT
);

-- Partial indexes on `valid_to IS NULL`: every hot traversal wants live edges
-- only, and restricting the index to them keeps it small and the planner
-- honest. Measured 97,509 TPS on a 2.26M-edge corpus.
CREATE INDEX IF NOT EXISTS idx_canon_edges_subject_live
  ON canon_edges (world_id, subject) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_canon_edges_object_live
  ON canon_edges (world_id, object) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_canon_edges_subject ON canon_edges (world_id, subject);
CREATE INDEX IF NOT EXISTS idx_canon_edges_object  ON canon_edges (world_id, object);
-- One live edge per (world, subject, predicate, object): the Postgres form of
-- the old `idx_edges_unique_live` partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_canon_edges_unique_live
  ON canon_edges (world_id, subject, predicate, object) WHERE valid_to IS NULL;

-- Canon character sheets. Was `sheets WHERE layer = 'canon'`.
CREATE TABLE IF NOT EXISTS canon_sheets (
  world_id   BIGINT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  entity_id  TEXT NOT NULL,
  identity   JSONB NOT NULL DEFAULT '{}'::jsonb,
  contract   JSONB NOT NULL DEFAULT '{}'::jsonb,
  voice      JSONB NOT NULL DEFAULT '{}'::jsonb,
  condition  JSONB NOT NULL DEFAULT '{}'::jsonb,
  appearance JSONB NOT NULL DEFAULT '{}'::jsonb,
  locks      JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (world_id, entity_id)
);

-- Which pages were read, per world per wiki.
--
-- `PRIMARY KEY (world_id, wiki, page_id)`: Fandom mints page ids per-wiki from
-- its own auto-increment sequence, so two unrelated wikis routinely reuse the
-- same numeric id for completely different pages (confirmed directly: ~95k of
-- Memory Alpha's and Memory Beta's ids collide out of no shared history
-- whatsoever). `wiki` is in the key for that reason; `world_id` joins it
-- because one Postgres table now holds every world's pages rather than one
-- file per world.
--
-- `passb_status` is what makes an interrupted ingest resumable. '' means "not
-- attempted"; 'done' means Pass B genuinely succeeded; 'failed' means it was
-- attempted and the extractor reported failure (a dead token, a rate limit,
-- unparseable output). Before this column existed, a page whose Pass B call
-- failed silently and one the model had actually read were the identical
-- shape, so a crawl that died mid-run left no trace of which pages still
-- needed the LLM pass.
CREATE TABLE IF NOT EXISTS ingest_pages (
  world_id     BIGINT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  wiki         TEXT NOT NULL,
  page_id      TEXT NOT NULL,
  title        TEXT NOT NULL,
  revision     TEXT NOT NULL DEFAULT '',
  depth        INTEGER NOT NULL DEFAULT 0,
  hops         INTEGER NOT NULL DEFAULT 0,
  score        REAL NOT NULL DEFAULT 0,
  fetched_at   TIMESTAMPTZ,
  passb_status TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (world_id, wiki, page_id)
);

CREATE INDEX IF NOT EXISTS idx_ingest_pages_status ON ingest_pages (world_id, wiki, passb_status);
CREATE INDEX IF NOT EXISTS idx_ingest_pages_title  ON ingest_pages (world_id, wiki, title);

-- ============================================================================
-- USER DATA — stories and everything scoped to one. Irreplaceable.
-- ============================================================================

-- One row per playthrough.
--
-- `owner_user_id` is NULL for "no owner": every story created before login
-- existed, and every story created while login is off (src/auth/config.ts).
-- NULL means unowned, never "owned by everyone" — silently attributing a
-- stranger's old local save to whoever logs in first would be a privacy bug,
-- not a convenience.
CREATE TABLE IF NOT EXISTS stories (
  id                  TEXT PRIMARY KEY,
  owner_user_id       TEXT,
  -- Storage format per story. `0` is legacy plaintext rows, `1` is encrypted
  -- envelopes. Kept on the story so a mixed fleet can exist during rollout.
  encryption_version  INTEGER NOT NULL DEFAULT 0,
  title               TEXT NOT NULL DEFAULT '',
  scene               INTEGER NOT NULL DEFAULT 1,
  turn                INTEGER NOT NULL DEFAULT 0,
  player_character_id TEXT NOT NULL DEFAULT '',
  current_location_id TEXT,
  style               JSONB NOT NULL DEFAULT '{}'::jsonb,
  knobs               JSONB NOT NULL DEFAULT '{}'::jsonb,
  forked_from         TEXT REFERENCES stories(id) ON DELETE SET NULL,
  forked_at_scene     INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_played_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stories_owner  ON stories (owner_user_id, last_played_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_played ON stories (last_played_at DESC, created_at DESC);

-- Additive migration for databases created before `encryption_version` existed.
ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS encryption_version INTEGER NOT NULL DEFAULT 0;

-- Per-user encryption rollout controls.
--
-- `bootstrap_email` lets an operator pre-enrol one address before knowing the
-- stable WorkOS id. On first login, the app binds that row to `user_id` and
-- all later checks key off the id, not the mutable email.
CREATE TABLE IF NOT EXISTS encryption_rollout (
  bootstrap_email     TEXT PRIMARY KEY,
  user_id             TEXT UNIQUE,
  enabled             BOOLEAN NOT NULL DEFAULT false,
  encrypt_new_stories BOOLEAN NOT NULL DEFAULT false,
  bound_at            TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_encryption_rollout_user_id ON encryption_rollout (user_id);

-- Initial pilot account: enabled for encrypted story creation once that user
-- first signs in and the row is bound to their WorkOS id.
INSERT INTO encryption_rollout (bootstrap_email, enabled, encrypt_new_stories, updated_at)
VALUES ('fabulist@rast.io', true, true, now())
ON CONFLICT (bootstrap_email) DO NOTHING;

-- Browser-generated encryption material for a user enrolled in the private-story
-- pilot. This table stores only authenticated ciphertext and public KDF inputs:
-- the passphrase, recovery code, master key, and story keys never persist here.
--
-- A master key has two independent wraps. The passphrase wrap uses the recorded
-- PBKDF2 parameters; the recovery-code wrap uses a random 256-bit recovery code
-- as its AES key. The application deliberately cannot decrypt either wrap.
CREATE TABLE IF NOT EXISTS user_encryption_keys (
  user_id                 TEXT PRIMARY KEY,
  version                 INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  passphrase_kdf          TEXT NOT NULL CHECK (passphrase_kdf = 'pbkdf2-sha256'),
  passphrase_kdf_params   JSONB NOT NULL,
  passphrase_salt         BYTEA NOT NULL,
  passphrase_nonce        BYTEA NOT NULL,
  passphrase_ciphertext   BYTEA NOT NULL,
  recovery_salt           BYTEA NOT NULL,
  recovery_nonce          BYTEA NOT NULL,
  recovery_ciphertext     BYTEA NOT NULL,
  recovery_code_hint      TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One random data-encryption key (DEK) per story, wrapped by its owner's
-- browser-held master key. `story_id` is the key because sharing is outside the
-- pilot; adding it later can add recipient wraps without changing ciphertext.
CREATE TABLE IF NOT EXISTS story_encryption_keys (
  story_id                TEXT PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  owner_user_id           TEXT NOT NULL,
  version                 INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  nonce                   BYTEA NOT NULL,
  ciphertext              BYTEA NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_story_encryption_keys_owner ON story_encryption_keys (owner_user_id);

-- Authenticated ciphertext for a private story field. Table, record, and
-- field identity are public routing metadata and are bound into AES-GCM AAD;
-- the value itself exists only in `ciphertext`, never alongside this row.
CREATE TABLE IF NOT EXISTS encrypted_story_values (
  story_id                TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  table_name              TEXT NOT NULL,
  record_id               TEXT NOT NULL,
  field_name              TEXT NOT NULL,
  version                 INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  nonce                   BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext              BYTEA NOT NULL CHECK (octet_length(ciphertext) > 16),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, table_name, record_id, field_name)
);

-- Which canon worlds a story reads, in precedence order. THE crossover table.
--
-- One row per source. `ordinal` 1 is the primary world, 2 the next, and so on;
-- the overlay resolves chronicle first, then sources in this order. A plain
-- story has exactly one row here, which is why the single-world case needs no
-- special handling anywhere.
--
-- No source-count ceiling. The SQLite design would have capped this at 8,
-- because composing worlds there meant ATTACHing one database file per world
-- and SQLite refuses the 11th attach (measured: "too many attached databases -
-- max 10"). Here it is an ordinary join.
--
-- `alias` namespaces ids when two worlds collide. Measured on the real
-- corpora, Star Trek (33,332 canon entities) and Mass Effect (11,680) collide
-- on exactly 6 ids — `loc:luna`, `char:april`, `char:warren`,
-- `concept:engineer`, `concept:century`, `concept:invasion` — so aliasing is
-- rare enough to apply per-collision (see `story_id_aliases`) rather than
-- rewriting all 45,000 ids and breaking the `char:`/`loc:` prefix assumptions
-- in setup/apply.ts and web/src/App.tsx.
CREATE TABLE IF NOT EXISTS story_sources (
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  world_id BIGINT NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  ordinal  INTEGER NOT NULL DEFAULT 1,
  alias    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (story_id, world_id)
);

-- `story_id` alone: the overlay reads every source for one story on each
-- query, so this is the hot lookup. Without it the planner seq-scans
-- story_sources on every read (visible in the EXPLAIN output during
-- benchmarking).
CREATE INDEX IF NOT EXISTS idx_story_sources_story ON story_sources (story_id, ordinal);

-- Only colliding ids get an alias, so this table is tiny (6 rows for the
-- Trek x Mass Effect case). `composed_id` is what the story and the model see;
-- `local_id` is what the canon row is keyed by inside its own world. Canon is
-- never rewritten, which is what keeps it independently refreshable.
CREATE TABLE IF NOT EXISTS story_id_aliases (
  story_id    TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  world_id    BIGINT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  local_id    TEXT NOT NULL,
  composed_id TEXT NOT NULL,
  PRIMARY KEY (story_id, composed_id)
);

CREATE INDEX IF NOT EXISTS idx_story_aliases_local ON story_id_aliases (story_id, world_id, local_id);

-- Chronicle entities: this story's divergences from canon, plus entities that
-- only ever existed in this story (emergent, player-invented — those have no
-- canon row and never will).
CREATE TABLE IF NOT EXISTS chron_entities (
  story_id      TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  type          TEXT NOT NULL,
  name          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  provenance    TEXT NOT NULL DEFAULT 'authored',
  confidence    REAL NOT NULL DEFAULT 1.0,
  salience      REAL NOT NULL DEFAULT 0.5,
  depth_level   INTEGER NOT NULL DEFAULT 0,
  props         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_scene INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (story_id, id)
);

-- Mirrors idx_canon_entities_salience: the chronicle arm of the overlay query
-- must also be an ordered index scan that stops at N.
CREATE INDEX IF NOT EXISTS idx_chron_entities_salience
  ON chron_entities (story_id, salience DESC, name);
CREATE INDEX IF NOT EXISTS idx_chron_entities_type ON chron_entities (story_id, type);
CREATE INDEX IF NOT EXISTS idx_chron_entities_name ON chron_entities (story_id, lower(name));

-- Keyed, per-story tokens for private entity-name and logical-id equality
-- lookups. They intentionally reveal equality/frequency within one story only.
CREATE TABLE IF NOT EXISTS chron_entity_blind_indexes (
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  entity_id  TEXT NOT NULL,
  index_kind TEXT NOT NULL CHECK (index_kind IN ('name', 'logical_id')),
  token      TEXT NOT NULL,
  PRIMARY KEY (story_id, entity_id, index_kind),
  UNIQUE (story_id, index_kind, token, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_chron_entity_blind_lookup
  ON chron_entity_blind_indexes (story_id, index_kind, token);

-- Chronicle edges. Once a story touches a (subject, predicate, object)
-- identity at all — asserts it, retires it, whatever — that identity is
-- masked from canon entirely and only this story's rows answer for it. See
-- `src/db/overlay.ts`; the mask is why a canon edge a story retired does not
-- keep reading as live.
CREATE TABLE IF NOT EXISTS chron_edges (
  eid        BIGSERIAL PRIMARY KEY,
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  subject    TEXT NOT NULL,
  predicate  TEXT NOT NULL,
  object     TEXT NOT NULL,
  valid_from INTEGER NOT NULL DEFAULT 0,
  valid_to   INTEGER,
  weight     REAL NOT NULL DEFAULT 0.5,
  provenance TEXT NOT NULL DEFAULT 'authored',
  confidence REAL NOT NULL DEFAULT 1.0,
  evidence   TEXT
);

CREATE INDEX IF NOT EXISTS idx_chron_edges_subject ON chron_edges (story_id, subject);
CREATE INDEX IF NOT EXISTS idx_chron_edges_object  ON chron_edges (story_id, object);
-- The masking lookup: "has this story touched this identity?"
CREATE INDEX IF NOT EXISTS idx_chron_edges_identity
  ON chron_edges (story_id, subject, predicate, object);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chron_edges_unique_live
  ON chron_edges (story_id, subject, predicate, object) WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS chron_sheets (
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  entity_id  TEXT NOT NULL,
  identity   JSONB NOT NULL DEFAULT '{}'::jsonb,
  contract   JSONB NOT NULL DEFAULT '{}'::jsonb,
  voice      JSONB NOT NULL DEFAULT '{}'::jsonb,
  condition  JSONB NOT NULL DEFAULT '{}'::jsonb,
  appearance JSONB NOT NULL DEFAULT '{}'::jsonb,
  locks      JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_player  BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (story_id, entity_id)
);

-- Directional and asymmetric: A trusts B while B despises A is the normal
-- case. Only ever written at play time, so story-scoped outright with no canon
-- layer to overlay.
CREATE TABLE IF NOT EXISTS relationships (
  story_id  TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  from_id   TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  trust     REAL NOT NULL DEFAULT 0,
  affection REAL NOT NULL DEFAULT 0,
  respect   REAL NOT NULL DEFAULT 0,
  note      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (story_id, from_id, to_id)
);

-- Facts are true in the world; knowledge of them is per-entity. Without this
-- NPCs react to information they cannot possess.
CREATE TABLE IF NOT EXISTS facts (
  id       TEXT PRIMARY KEY,
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  text     TEXT NOT NULL,
  scene    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_facts_story ON facts (story_id, scene);

CREATE TABLE IF NOT EXISTS fact_knowledge (
  fact_id     TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  entity_id   TEXT NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('knows','suspects','wrong')),
  since_scene INTEGER NOT NULL DEFAULT 0,
  distortion  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (fact_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_fact_knowledge_entity ON fact_knowledge (entity_id);

-- Threads exist instead of a plot: a plot breaks when the player deviates, a
-- thread just gets re-aimed.
CREATE TABLE IF NOT EXISTS threads (
  id            TEXT PRIMARY KEY,
  story_id      TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  stakes        TEXT NOT NULL DEFAULT '',
  tension       REAL NOT NULL DEFAULT 0.5,
  parties       JSONB NOT NULL DEFAULT '[]'::jsonb,
  resolutions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        TEXT NOT NULL DEFAULT 'open',
  created_scene INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_threads_status ON threads (story_id, status, tension DESC);

CREATE TABLE IF NOT EXISTS events (
  id                  TEXT PRIMARY KEY,
  story_id            TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  scene               INTEGER NOT NULL,
  turn                INTEGER NOT NULL,
  text                TEXT NOT NULL,
  participants        JSONB NOT NULL DEFAULT '[]'::jsonb,
  location_id         TEXT,
  significance        REAL NOT NULL DEFAULT 0.5,
  visibility          TEXT NOT NULL DEFAULT 'onscreen',
  from_consequence_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_scene ON events (story_id, scene, turn);
-- GIN over the participants array: `witnessedEvents` filters on membership,
-- and the SQLite version had to do it with json_each after `LIKE '%id%'`
-- silently matched any id the target was a prefix of (a real epistemics bug —
-- searching `char:tem` matched `char:tem-the-elder`). A GIN index makes the
-- containment query both correct and indexed.
CREATE INDEX IF NOT EXISTS idx_events_participants ON events USING gin (participants);

-- A propagation queue, not a world simulation: only the neighbourhood that was
-- actually disturbed gets processed.
CREATE TABLE IF NOT EXISTS consequences (
  id             TEXT PRIMARY KEY,
  story_id       TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  cause_event_id TEXT NOT NULL,
  trigger        JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id       TEXT NOT NULL,
  action         TEXT NOT NULL,
  visibility     TEXT NOT NULL,
  maturity       TEXT NOT NULL DEFAULT 'pending',
  depth          INTEGER NOT NULL DEFAULT 1,
  significance   REAL NOT NULL DEFAULT 0.5,
  created_scene  INTEGER NOT NULL,
  fired_scene    INTEGER,
  superseded_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_cons_maturity ON consequences (story_id, maturity, created_scene);
CREATE INDEX IF NOT EXISTS idx_cons_actor    ON consequences (story_id, actor_id);

CREATE TABLE IF NOT EXISTS turns (
  id         TEXT PRIMARY KEY,
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  scene      INTEGER NOT NULL,
  turn       INTEGER NOT NULL,
  raw_input  TEXT NOT NULL,
  intent     TEXT,
  delta      JSONB,
  book_prose TEXT NOT NULL DEFAULT '',
  pinned     BOOLEAN NOT NULL DEFAULT false,
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_turns_order ON turns (story_id, scene, turn);

-- Hierarchical compaction: only the current scene stays verbatim, everything
-- above becomes a summary that keeps entity references intact.
CREATE TABLE IF NOT EXISTS scenes (
  story_id    TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  scene       INTEGER NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  location_id TEXT,
  chapter     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (story_id, scene)
);

CREATE TABLE IF NOT EXISTS chapters (
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  chapter  INTEGER NOT NULL,
  title    TEXT NOT NULL DEFAULT '',
  summary  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (story_id, chapter)
);

CREATE TABLE IF NOT EXISTS directives (
  id              TEXT PRIMARY KEY,
  story_id        TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'chapter',
  strength        TEXT NOT NULL DEFAULT 'hint',
  lifetime_scenes INTEGER,
  status          TEXT NOT NULL DEFAULT 'active',
  created_scene   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_directives_story ON directives (story_id, status);

-- Explicit list of departures from canon, so the Referee never quietly reverts
-- to the source material.
CREATE TABLE IF NOT EXISTS divergences (
  id       BIGSERIAL PRIMARY KEY,
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  scene    INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  detail   TEXT NOT NULL,
  canon    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_divergences_story ON divergences (story_id, scene);

-- Passages the player liked, re-injected to stop prose homogenising toward
-- generic model voice.
CREATE TABLE IF NOT EXISTS style_anchors (
  id       BIGSERIAL PRIMARY KEY,
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  text     TEXT NOT NULL,
  note     TEXT NOT NULL DEFAULT '',
  scene    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_style_anchors_story ON style_anchors (story_id, scene);

-- Personal prose blocklist. Now keyed by user, not global: a phrase one player
-- is tired of is not a property of the server. (The SQLite table was global
-- and, as it turns out, read by nothing in src/ — config.blocklist was what
-- actually fed the linter — so scoping it correctly costs nothing.)
-- `user_id` empty string means the login-off local case.
CREATE TABLE IF NOT EXISTS prose_blocklist (
  user_id TEXT NOT NULL DEFAULT '',
  pattern TEXT NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  added   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pattern)
);

-- One row per generated image. Scene and portrait subjects share every column
-- but `kind`, and a caller almost always wants "illustrations for this turn" or
-- "for this entity" without a UNION.
--
-- Image *bytes* stay on disk, not in the database: a generated PNG is tens to
-- hundreds of KB and nothing about it benefits from being inside a
-- transaction. `path` is relative to the images directory.
CREATE TABLE IF NOT EXISTS illustrations (
  id              TEXT PRIMARY KEY,
  story_id        TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('scene','portrait')),
  turn_id         TEXT,
  entity_id       TEXT,
  location_id     TEXT,
  visual_style    TEXT NOT NULL DEFAULT 'painterly',
  prompt          TEXT NOT NULL DEFAULT '',
  negative_prompt TEXT NOT NULL DEFAULT '',
  seed            BIGINT,
  provider        TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  path            TEXT,
  error           TEXT,
  created_scene   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_illustrations_turn   ON illustrations (story_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_illustrations_entity ON illustrations (story_id, entity_id, created_at DESC);

-- World-level key/value, per world rather than per file.
--
-- `.design/DBFIXES.md` asked for this decision to be written down: `meta` used
-- to be file-global with `worldTitle` as a bare key, which is wrong the moment
-- one story composes two fandoms. Per-world titles now live in `worlds.title`
-- and per-source detail in `world_sources`; this table is for anything else a
-- world needs to remember.
CREATE TABLE IF NOT EXISTS world_meta (
  world_id BIGINT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (world_id, key)
);

-- Bookkeeping for the automatic SQLite importer (src/db/import-sqlite.ts).
--
-- Per-world rather than one global flag, because the importer runs one
-- transaction per world: a large world failing must not roll back or re-run
-- the ones that already succeeded. `state` is 'done' or 'failed'; a world with
-- no row here has not been attempted.
--
-- 'failed' deliberately blocks re-import until an operator clears it. The
-- deployed instance has already crash-looped at boot once under
-- `restart: unless-stopped` (see resolveCurrentStory's comment in
-- store/world.ts), and a data importer that retries itself automatically on
-- every restart is how that incident escalates from downtime to corruption.
CREATE TABLE IF NOT EXISTS sqlite_import_log (
  slug        TEXT PRIMARY KEY,
  state       TEXT NOT NULL CHECK (state IN ('done','failed')),
  world_id    BIGINT REFERENCES worlds(id) ON DELETE SET NULL,
  entities    INTEGER NOT NULL DEFAULT 0,
  edges       INTEGER NOT NULL DEFAULT 0,
  stories     INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  source_path TEXT NOT NULL DEFAULT '',
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
