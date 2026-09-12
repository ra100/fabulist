-- Durable, owner-level checkpointing for the explicit private-storage pilot.
CREATE TABLE IF NOT EXISTS user_private_story_migrations (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('migrating', 'failed', 'complete')),
  error TEXT,
  blocklist_done BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS story_private_story_migrations (
  story_id TEXT PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('migrating', 'failed', 'complete')),
  category TEXT NOT NULL DEFAULT '',
  error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_story_private_migrations_user
  ON story_private_story_migrations (user_id, status);
