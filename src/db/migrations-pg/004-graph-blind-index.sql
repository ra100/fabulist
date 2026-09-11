-- Keyed lookup tokens for encrypted chronicle entity names and logical ids.
-- Tokens are per-story HMAC output; neither source text nor unkeyed hashes are
-- persisted. Entity ids remain the stable cross-store references.
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
