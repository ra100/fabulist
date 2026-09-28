-- Allow multiple saved credentials per user and move routing out of the credential row.
ALTER TABLE user_provider_keys DROP CONSTRAINT IF EXISTS user_provider_keys_user_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'user_provider_keys'::regclass
       AND conname = 'user_provider_keys_id_user_id_key'
  ) THEN
    ALTER TABLE user_provider_keys ADD CONSTRAINT user_provider_keys_id_user_id_key UNIQUE (id, user_id);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS user_provider_model_assignments (
  user_id        TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN (
    'narrate', 'classify', 'integrity', 'referee', 'director',
    'humanize', 'summarize', 'setup', 'extract', 'passb'
  )),
  provider_key_id TEXT NOT NULL,
  model_id        TEXT NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 200),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role),
  FOREIGN KEY (provider_key_id, user_id)
    REFERENCES user_provider_keys (id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_provider_model_assignments_key
  ON user_provider_model_assignments (provider_key_id, user_id);

-- Carry forward old routing: mechanics shared seven roles, extraction covered
-- both extract and Pass B, and omitted optional models used narration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'user_provider_keys'
       AND column_name = 'models'
  ) THEN
    INSERT INTO user_provider_model_assignments (user_id, role, provider_key_id, model_id)
    SELECT user_id, 'narrate', id, models->>'narrate'
      FROM user_provider_keys
     WHERE COALESCE(models->>'narrate', '') <> ''
    ON CONFLICT (user_id, role) DO NOTHING;

    INSERT INTO user_provider_model_assignments (user_id, role, provider_key_id, model_id)
    SELECT user_id, role, id, COALESCE(NULLIF(models->>'mechanics', ''), models->>'narrate')
      FROM user_provider_keys
      CROSS JOIN unnest(ARRAY['classify','integrity','referee','director','humanize','summarize','setup']) AS role
     WHERE COALESCE(models->>'narrate', '') <> ''
    ON CONFLICT (user_id, role) DO NOTHING;

    INSERT INTO user_provider_model_assignments (user_id, role, provider_key_id, model_id)
    SELECT user_id, role, id, COALESCE(NULLIF(models->>'extract', ''), models->>'narrate')
      FROM user_provider_keys
      CROSS JOIN unnest(ARRAY['extract','passb']) AS role
     WHERE COALESCE(models->>'narrate', '') <> ''
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
END
$$;

ALTER TABLE user_provider_keys DROP COLUMN IF EXISTS models;

DO $$
DECLARE
  sch TEXT := current_schema();
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['fabulist_play', 'fabulist_ingest'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.user_provider_model_assignments TO %I', sch, role_name);
    END IF;
  END LOOP;
END
$$;
