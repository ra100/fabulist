-- Display scene numbers are derived; range ownership is the durable key.
CREATE TABLE IF NOT EXISTS scene_metadata (
  story_id    TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  identity    TEXT NOT NULL,
  scene       INTEGER NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  location_id TEXT,
  chapter     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (story_id, identity)
);

ALTER TABLE divergences ADD COLUMN IF NOT EXISTS turn INTEGER;

INSERT INTO scene_metadata (story_id, identity, scene, title, summary, location_id, chapter)
SELECT story_id, 'raw:' || scene, scene, title, summary, location_id, chapter FROM scenes
ON CONFLICT (story_id, identity) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabulist_play') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scene_metadata TO fabulist_play;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabulist_ingest') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scene_metadata TO fabulist_ingest;
  END IF;
END $$;
