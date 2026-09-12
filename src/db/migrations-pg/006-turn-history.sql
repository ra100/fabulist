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
