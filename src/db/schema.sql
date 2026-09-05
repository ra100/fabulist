-- Fabulist schema. See DESIGN.md §2, and .design/GAPS.md for the multi-story
-- migration this file went through.
--
-- Layering: canon rows are ingested (or authored once, for a custom world) and
-- immutable at play time; chronicle rows overlay them copy-on-write. Reads
-- resolve `chronicle ?? canon`, which is what lets one ingest support many
-- playthroughs and still answer "what did the source material actually say?".
--
-- Multi-story: canon belongs to the *world* (this file) and is shared by every
-- story in it. Chronicle belongs to a *story* — every chronicle-layer row on a
-- mutable table carries `story_id`, and two stories in the same world never see
-- each other's chronicle even when they diverge from the same canon entity.
-- `stories` replaces the old single-row `session` singleton; there is one row
-- per story instead of one row per file.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ------------------------------------------------------------------- stories
-- One row per playthrough of this world. Replaces the old `session` table,
-- which had exactly one row (`PRIMARY KEY CHECK (id = 1)`) because a file held
-- exactly one story. `forked_from`/`forked_at_scene` record lineage when a
-- story was copy-forked from another rather than started fresh against canon.

CREATE TABLE IF NOT EXISTS stories (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL DEFAULT '',
  scene                INTEGER NOT NULL DEFAULT 1,
  turn                 INTEGER NOT NULL DEFAULT 0,
  player_character_id  TEXT NOT NULL DEFAULT '',
  current_location_id  TEXT,
  style                TEXT NOT NULL DEFAULT '{}',
  knobs                TEXT NOT NULL DEFAULT '{}',
  forked_from          TEXT,
  forked_at_scene      INTEGER,
  created_at           TEXT NOT NULL DEFAULT '',
  last_played_at       TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (forked_from) REFERENCES stories(id) ON DELETE SET NULL
);

-- ------------------------------------------------------------------- entities
-- Canon rows (layer='canon') have no story_id: one ingest, shared by every
-- story. Chronicle rows (layer='chronicle') carry story_id, and only exist
-- once a story has actually diverged that entity from canon.
--
-- Not a composite PRIMARY KEY on (id, layer, story_id): SQLite (like most SQL
-- engines) treats NULL as never equal to NULL for uniqueness purposes, so a
-- PK including the nullable story_id column would silently admit duplicate
-- canon rows — checked directly against node:sqlite before writing this, not
-- assumed. The COALESCE-folded unique index below is what actually enforces
-- "one canon row per id" and "one chronicle row per (id, story)".

CREATE TABLE IF NOT EXISTS entities (
  rowid_pk      INTEGER PRIMARY KEY,
  id            TEXT NOT NULL,
  layer         TEXT NOT NULL CHECK (layer IN ('canon','chronicle')),
  story_id      TEXT,
  type          TEXT NOT NULL,
  name          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  provenance    TEXT NOT NULL DEFAULT 'authored',
  confidence    REAL NOT NULL DEFAULT 1.0,
  salience      REAL NOT NULL DEFAULT 0.5,
  depth_level   INTEGER NOT NULL DEFAULT 0,
  props         TEXT NOT NULL DEFAULT '{}',
  created_scene INTEGER NOT NULL DEFAULT 0,
  CHECK ((layer = 'canon' AND story_id IS NULL) OR (layer = 'chronicle' AND story_id IS NOT NULL)),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_pk ON entities(id, layer, COALESCE(story_id, ''));
CREATE INDEX IF NOT EXISTS idx_entities_type     ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_salience ON entities(salience DESC);
CREATE INDEX IF NOT EXISTS idx_entities_depth    ON entities(depth_level);
CREATE INDEX IF NOT EXISTS idx_entities_name     ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_story    ON entities(story_id, id);

-- ---------------------------------------------------------------------- edges
-- Temporally scoped: nothing is deleted, relations expire. valid_to IS NULL
-- means still in force. Querying "who is an ally now" is a time-filtered walk.
-- Same canon/chronicle split as entities: canon edges are story_id NULL and
-- shared; chronicle edges belong to one story.

CREATE TABLE IF NOT EXISTS edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  predicate   TEXT NOT NULL,
  object      TEXT NOT NULL,
  layer       TEXT NOT NULL CHECK (layer IN ('canon','chronicle')),
  story_id    TEXT,
  valid_from  INTEGER NOT NULL DEFAULT 0,
  valid_to    INTEGER,
  weight      REAL NOT NULL DEFAULT 0.5,
  provenance  TEXT NOT NULL DEFAULT 'authored',
  confidence  REAL NOT NULL DEFAULT 1.0,
  evidence    TEXT,
  CHECK ((layer = 'canon' AND story_id IS NULL) OR (layer = 'chronicle' AND story_id IS NOT NULL)),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_edges_subject ON edges(subject, valid_to);
CREATE INDEX IF NOT EXISTS idx_edges_object  ON edges(object, valid_to);
CREATE INDEX IF NOT EXISTS idx_edges_pred    ON edges(predicate);
CREATE INDEX IF NOT EXISTS idx_edges_story   ON edges(story_id);
-- "Live" uniqueness is scoped per story for chronicle edges (two stories may
-- each assert the same relation independently) but global for canon (there is
-- only ever one canon). A generated column folds NULL story_id to a constant
-- so the partial index can still express "one live edge per (subject,
-- predicate, object, layer, story)" without two separate indexes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique_live
  ON edges(subject, predicate, object, layer, COALESCE(story_id, '')) WHERE valid_to IS NULL;

-- ------------------------------------------------------------------- sheets
-- Same canon/chronicle split as entities: ingest (or custom-world authoring)
-- writes a canon baseline sheet once, shared by every story; play-time
-- mutation (vows breaking, condition, locks, who is the player) copies it
-- forward into a chronicle row scoped to that story.

-- Same NULL-uniqueness caveat as entities (checked directly, not assumed):
-- no composite PRIMARY KEY on the nullable story_id column.
CREATE TABLE IF NOT EXISTS sheets (
  rowid_pk  INTEGER PRIMARY KEY,
  entity_id TEXT NOT NULL,
  layer     TEXT NOT NULL CHECK (layer IN ('canon','chronicle')),
  story_id  TEXT,
  identity  TEXT NOT NULL DEFAULT '{}',
  contract  TEXT NOT NULL DEFAULT '{}',
  voice     TEXT NOT NULL DEFAULT '{}',
  condition TEXT NOT NULL DEFAULT '{}',
  locks     TEXT NOT NULL DEFAULT '[]',
  is_player INTEGER NOT NULL DEFAULT 0,
  CHECK ((layer = 'canon' AND story_id IS NULL) OR (layer = 'chronicle' AND story_id IS NOT NULL)),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sheets_pk ON sheets(entity_id, layer, COALESCE(story_id, ''));
CREATE INDEX IF NOT EXISTS idx_sheets_story ON sheets(story_id, entity_id);

-- Directional and asymmetric: A trusts B while B despises A is the normal
-- case. Only ever written at play time, so this is story-scoped outright —
-- there is no canon-layer relationship to overlay.
CREATE TABLE IF NOT EXISTS relationships (
  story_id  TEXT NOT NULL,
  from_id   TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  trust     REAL NOT NULL DEFAULT 0,
  affection REAL NOT NULL DEFAULT 0,
  respect   REAL NOT NULL DEFAULT 0,
  note      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (story_id, from_id, to_id),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

-- --------------------------------------------------------------- epistemics
-- Facts are true in the world; knowledge of them is per-entity. Without this
-- NPCs react to information they cannot possess. Facts are only ever written
-- at play time (or custom-world authoring, which is itself one story), so
-- these are story-scoped outright, with no canon layer to overlay.

CREATE TABLE IF NOT EXISTS facts (
  id       TEXT PRIMARY KEY,
  story_id TEXT NOT NULL,
  text     TEXT NOT NULL,
  scene    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_facts_story ON facts(story_id);

CREATE TABLE IF NOT EXISTS fact_knowledge (
  fact_id     TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('knows','suspects','wrong')),
  since_scene INTEGER NOT NULL DEFAULT 0,
  distortion  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (fact_id, entity_id),
  FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fk_entity ON fact_knowledge(entity_id);

-- ------------------------------------------------------------------- threads

CREATE TABLE IF NOT EXISTS threads (
  id            TEXT PRIMARY KEY,
  story_id      TEXT NOT NULL,
  title         TEXT NOT NULL,
  stakes        TEXT NOT NULL DEFAULT '',
  tension       REAL NOT NULL DEFAULT 0.5,
  parties       TEXT NOT NULL DEFAULT '[]',
  resolutions   TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'open',
  created_scene INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(story_id, status, tension DESC);

-- -------------------------------------------------------------------- events

CREATE TABLE IF NOT EXISTS events (
  id                  TEXT PRIMARY KEY,
  story_id            TEXT NOT NULL,
  scene               INTEGER NOT NULL,
  turn                INTEGER NOT NULL,
  text                TEXT NOT NULL,
  participants        TEXT NOT NULL DEFAULT '[]',
  location_id         TEXT,
  significance        REAL NOT NULL DEFAULT 0.5,
  visibility          TEXT NOT NULL DEFAULT 'onscreen',
  from_consequence_id TEXT,
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_scene ON events(story_id, scene, turn);

-- -------------------------------------------------------------- consequences
-- A propagation queue, not a world simulation: only the neighbourhood that was
-- actually disturbed gets processed.

CREATE TABLE IF NOT EXISTS consequences (
  id             TEXT PRIMARY KEY,
  story_id       TEXT NOT NULL,
  cause_event_id TEXT NOT NULL,
  trigger        TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  action         TEXT NOT NULL,
  visibility     TEXT NOT NULL,
  maturity       TEXT NOT NULL DEFAULT 'pending',
  depth          INTEGER NOT NULL DEFAULT 1,
  significance   REAL NOT NULL DEFAULT 0.5,
  created_scene  INTEGER NOT NULL,
  fired_scene    INTEGER,
  superseded_by  TEXT,
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cons_maturity ON consequences(story_id, maturity, created_scene);
CREATE INDEX IF NOT EXISTS idx_cons_actor    ON consequences(story_id, actor_id);

-- --------------------------------------------------------------------- turns

CREATE TABLE IF NOT EXISTS turns (
  id         TEXT PRIMARY KEY,
  story_id   TEXT NOT NULL,
  scene      INTEGER NOT NULL,
  turn       INTEGER NOT NULL,
  raw_input  TEXT NOT NULL,
  intent     TEXT,
  delta      TEXT,
  book_prose TEXT NOT NULL DEFAULT '',
  pinned     INTEGER NOT NULL DEFAULT 0,
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_turns_order ON turns(story_id, scene, turn);

-- ------------------------------------------------------------------- scenes
-- Hierarchical compaction: only the current scene stays verbatim, everything
-- above becomes a summary that keeps entity references intact.

CREATE TABLE IF NOT EXISTS scenes (
  story_id    TEXT NOT NULL,
  scene       INTEGER NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  location_id TEXT,
  chapter     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (story_id, scene),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chapters (
  story_id TEXT NOT NULL,
  chapter  INTEGER NOT NULL,
  title    TEXT NOT NULL DEFAULT '',
  summary  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (story_id, chapter),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- directives

CREATE TABLE IF NOT EXISTS directives (
  id              TEXT PRIMARY KEY,
  story_id        TEXT NOT NULL,
  text            TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'chapter',
  strength        TEXT NOT NULL DEFAULT 'hint',
  lifetime_scenes INTEGER,
  status          TEXT NOT NULL DEFAULT 'active',
  created_scene   INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_directives_story ON directives(story_id, status);

-- ----------------------------------------------------------- divergence log
-- Explicit list of departures from canon, so the Referee never quietly
-- reverts to the source material. Per-story: two stories diverge from the
-- same canon independently.

CREATE TABLE IF NOT EXISTS divergences (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id TEXT NOT NULL,
  scene    INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  detail   TEXT NOT NULL,
  canon    TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_divergences_story ON divergences(story_id);

-- ------------------------------------------------------------- style anchors
-- Passages the player liked, re-injected to stop prose homogenising toward
-- generic model voice. Per-story: what reads well in one playthrough's voice
-- is not necessarily what another story, in the same world, wants echoed.

CREATE TABLE IF NOT EXISTS style_anchors (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id TEXT NOT NULL,
  text     TEXT NOT NULL,
  note     TEXT NOT NULL DEFAULT '',
  scene    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_style_anchors_story ON style_anchors(story_id);

-- Personal prose blocklist that grows with use; becomes the most valuable
-- file in the project within a month. Kept world-level (not story-scoped): a
-- phrase you are tired of is tired-of regardless of which story surfaced it,
-- and starting a new story with a clean blocklist would be a regression.
CREATE TABLE IF NOT EXISTS prose_blocklist (
  pattern TEXT PRIMARY KEY,
  note    TEXT NOT NULL DEFAULT '',
  added   TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------- ingest log
-- World-level: which pages were read is a property of the ingest (canon),
-- not of any one story built on top of it.

CREATE TABLE IF NOT EXISTS ingest_pages (
  page_id    TEXT PRIMARY KEY,
  wiki       TEXT NOT NULL,
  title      TEXT NOT NULL,
  revision   TEXT NOT NULL DEFAULT '',
  depth      INTEGER NOT NULL DEFAULT 0,
  hops       INTEGER NOT NULL DEFAULT 0,
  score      REAL NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL DEFAULT ''
);

-- -------------------------------------------------------------- illustration
-- One row per generated image. Scene and portrait subjects are distinguished
-- by `kind` rather than split into two tables, because they share every other
-- column and a caller almost always wants "illustrations for this turn" or
-- "illustrations for this entity" without a UNION.
--
-- Portraits double as the character-consistency anchor: `sheets.appearance`
-- (an additive column, see `db.ts`'s migration step — this table postdates the
-- original schema and `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS` in
-- this SQLite version, confirmed directly rather than assumed) stores the
-- winning image's path once one exists, and every later prompt for that
-- entity is conditioned on it.

CREATE TABLE IF NOT EXISTS illustrations (
  id               TEXT PRIMARY KEY,
  story_id         TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('scene','portrait')),
  turn_id          TEXT,
  entity_id        TEXT,
  location_id      TEXT,
  visual_style     TEXT NOT NULL DEFAULT 'painterly',
  prompt           TEXT NOT NULL DEFAULT '',
  negative_prompt  TEXT NOT NULL DEFAULT '',
  seed             INTEGER,
  provider         TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  path             TEXT,
  error            TEXT,
  created_scene    INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_illustrations_turn   ON illustrations(story_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_illustrations_entity ON illustrations(story_id, entity_id, created_at DESC);
