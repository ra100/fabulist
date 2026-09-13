-- Repair installations that recorded migration 006 without its history schema.
-- Repeating the full additive migration is safe for healthy deployments.
ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS active_scene_segment_id TEXT;

ALTER TABLE turns
  ADD COLUMN IF NOT EXISTS history_position INTEGER,
  ADD COLUMN IF NOT EXISTS scene_segment_id TEXT;

CREATE INDEX IF NOT EXISTS idx_turns_history_position ON turns (story_id, history_position);

CREATE TABLE IF NOT EXISTS history_checkpoints (
  id         TEXT PRIMARY KEY,
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  turn_id    TEXT,
  position   INTEGER NOT NULL,
  state      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (story_id, turn_id),
  UNIQUE (story_id, position)
);

CREATE INDEX IF NOT EXISTS idx_history_checkpoints_turn ON history_checkpoints (story_id, turn_id);

CREATE TABLE IF NOT EXISTS scene_segments (
  id             TEXT PRIMARY KEY,
  story_id       TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  start_position INTEGER NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (story_id, start_position)
);

CREATE INDEX IF NOT EXISTS idx_scene_segments_start ON scene_segments (story_id, start_position);

DO $$
DECLARE
  sch TEXT := current_schema();
  history_table TEXT;
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['fabulist_play', 'fabulist_ingest'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      FOREACH history_table IN ARRAY ARRAY['history_checkpoints', 'scene_segments'] LOOP
        EXECUTE format(
          'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I',
          sch,
          history_table,
          role_name
        );
      END LOOP;
    END IF;
  END LOOP;
END
$$;
