-- Story engine schema. See DESIGN.md §2.
--
-- Layering: canon rows are ingested and immutable at play time; chronicle rows
-- overlay them copy-on-write. Reads resolve `chronicle ?? canon`, which is what
-- lets one ingest support many playthroughs and still answer "what did the
-- source material actually say?".

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ------------------------------------------------------------------- entities

CREATE TABLE IF NOT EXISTS entities (
  id            TEXT NOT NULL,
  layer         TEXT NOT NULL CHECK (layer IN ('canon','chronicle')),
  type          TEXT NOT NULL,
  name          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  provenance    TEXT NOT NULL DEFAULT 'authored',
  confidence    REAL NOT NULL DEFAULT 1.0,
  salience      REAL NOT NULL DEFAULT 0.5,
  depth_level   INTEGER NOT NULL DEFAULT 0,
  props         TEXT NOT NULL DEFAULT '{}',
  created_scene INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, layer)
);

CREATE INDEX IF NOT EXISTS idx_entities_type     ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_salience ON entities(salience DESC);
CREATE INDEX IF NOT EXISTS idx_entities_depth    ON entities(depth_level);
CREATE INDEX IF NOT EXISTS idx_entities_name     ON entities(name);

-- ---------------------------------------------------------------------- edges
-- Temporally scoped: nothing is deleted, relations expire. valid_to IS NULL
-- means still in force. Querying "who is an ally now" is a time-filtered walk.

CREATE TABLE IF NOT EXISTS edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  predicate   TEXT NOT NULL,
  object      TEXT NOT NULL,
  layer       TEXT NOT NULL CHECK (layer IN ('canon','chronicle')),
  valid_from  INTEGER NOT NULL DEFAULT 0,
  valid_to    INTEGER,
  weight      REAL NOT NULL DEFAULT 0.5,
  provenance  TEXT NOT NULL DEFAULT 'authored',
  confidence  REAL NOT NULL DEFAULT 1.0,
  evidence    TEXT
);

CREATE INDEX IF NOT EXISTS idx_edges_subject ON edges(subject, valid_to);
CREATE INDEX IF NOT EXISTS idx_edges_object  ON edges(object, valid_to);
CREATE INDEX IF NOT EXISTS idx_edges_pred    ON edges(predicate);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique_live
  ON edges(subject, predicate, object, layer) WHERE valid_to IS NULL;

-- ------------------------------------------------------------------- sheets

CREATE TABLE IF NOT EXISTS sheets (
  entity_id TEXT PRIMARY KEY,
  identity  TEXT NOT NULL DEFAULT '{}',
  contract  TEXT NOT NULL DEFAULT '{}',
  voice     TEXT NOT NULL DEFAULT '{}',
  condition TEXT NOT NULL DEFAULT '{}',
  locks     TEXT NOT NULL DEFAULT '[]',
  is_player INTEGER NOT NULL DEFAULT 0
);

-- Directional and asymmetric: A trusts B while B despises A is the normal case.
CREATE TABLE IF NOT EXISTS relationships (
  from_id   TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  trust     REAL NOT NULL DEFAULT 0,
  affection REAL NOT NULL DEFAULT 0,
  respect   REAL NOT NULL DEFAULT 0,
  note      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (from_id, to_id)
);

-- --------------------------------------------------------------- epistemics
-- Facts are true in the world; knowledge of them is per-entity. Without this
-- NPCs react to information they cannot possess.

CREATE TABLE IF NOT EXISTS facts (
  id    TEXT PRIMARY KEY,
  text  TEXT NOT NULL,
  scene INTEGER NOT NULL DEFAULT 0,
  layer TEXT NOT NULL DEFAULT 'chronicle'
);

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
  title         TEXT NOT NULL,
  stakes        TEXT NOT NULL DEFAULT '',
  tension       REAL NOT NULL DEFAULT 0.5,
  parties       TEXT NOT NULL DEFAULT '[]',
  resolutions   TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'open',
  created_scene INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status, tension DESC);

-- -------------------------------------------------------------------- events

CREATE TABLE IF NOT EXISTS events (
  id                  TEXT PRIMARY KEY,
  scene               INTEGER NOT NULL,
  turn                INTEGER NOT NULL,
  text                TEXT NOT NULL,
  participants        TEXT NOT NULL DEFAULT '[]',
  location_id         TEXT,
  significance        REAL NOT NULL DEFAULT 0.5,
  visibility          TEXT NOT NULL DEFAULT 'onscreen',
  from_consequence_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_scene ON events(scene, turn);

-- -------------------------------------------------------------- consequences
-- A propagation queue, not a world simulation: only the neighbourhood that was
-- actually disturbed gets processed.

CREATE TABLE IF NOT EXISTS consequences (
  id             TEXT PRIMARY KEY,
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
  superseded_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_cons_maturity ON consequences(maturity, created_scene);
CREATE INDEX IF NOT EXISTS idx_cons_actor    ON consequences(actor_id);

-- --------------------------------------------------------------------- turns

CREATE TABLE IF NOT EXISTS turns (
  id         TEXT PRIMARY KEY,
  scene      INTEGER NOT NULL,
  turn       INTEGER NOT NULL,
  raw_input  TEXT NOT NULL,
  intent     TEXT,
  delta      TEXT,
  book_prose TEXT NOT NULL DEFAULT '',
  pinned     INTEGER NOT NULL DEFAULT 0,
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_order ON turns(scene, turn);

-- ------------------------------------------------------------------- scenes
-- Hierarchical compaction: only the current scene stays verbatim, everything
-- above becomes a summary that keeps entity references intact.

CREATE TABLE IF NOT EXISTS scenes (
  scene       INTEGER PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  location_id TEXT,
  chapter     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS chapters (
  chapter INTEGER PRIMARY KEY,
  title   TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------- directives

CREATE TABLE IF NOT EXISTS directives (
  id              TEXT PRIMARY KEY,
  text            TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'chapter',
  strength        TEXT NOT NULL DEFAULT 'hint',
  lifetime_scenes INTEGER,
  status          TEXT NOT NULL DEFAULT 'active',
  created_scene   INTEGER NOT NULL DEFAULT 0
);

-- ----------------------------------------------------------- divergence log
-- Explicit list of departures from canon, so the Referee never quietly
-- reverts to the source material.

CREATE TABLE IF NOT EXISTS divergences (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  scene   INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  detail  TEXT NOT NULL,
  canon   TEXT NOT NULL DEFAULT ''
);

-- ------------------------------------------------------------- style anchors
-- Passages the player liked, re-injected to stop prose homogenising toward
-- generic model voice.

CREATE TABLE IF NOT EXISTS style_anchors (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  text    TEXT NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  scene   INTEGER NOT NULL DEFAULT 0
);

-- Personal prose blocklist that grows with use; becomes the most valuable
-- file in the project within a month.
CREATE TABLE IF NOT EXISTS prose_blocklist (
  pattern TEXT PRIMARY KEY,
  note    TEXT NOT NULL DEFAULT '',
  added   TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------- ingest log

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

CREATE TABLE IF NOT EXISTS session (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  scene               INTEGER NOT NULL DEFAULT 1,
  turn                INTEGER NOT NULL DEFAULT 0,
  player_character_id TEXT NOT NULL DEFAULT '',
  current_location_id TEXT,
  style               TEXT NOT NULL DEFAULT '{}',
  knobs               TEXT NOT NULL DEFAULT '{}'
);
