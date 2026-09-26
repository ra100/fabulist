-- Per-user provider keys and the usage they meter. Mirrors schema-pg.sql; the
-- grant block is here because production may never re-run schema-pg-roles.sql.
CREATE TABLE IF NOT EXISTS user_provider_keys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL DEFAULT '',
  endpoint_id   TEXT NOT NULL,
  models        JSONB NOT NULL,
  trust         TEXT NOT NULL CHECK (trust IN ('unlock', 'sealed')),
  nonce         BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext    BYTEA NOT NULL CHECK (octet_length(ciphertext) > 16),
  key_hint      TEXT NOT NULL CHECK (char_length(key_hint) <= 4),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS usage_events (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  story_id     TEXT,
  role         TEXT NOT NULL,
  provider_id  TEXT NOT NULL,
  model        TEXT NOT NULL,
  key_source   TEXT NOT NULL CHECK (key_source IN ('own', 'server')),
  tokens_in    INTEGER NOT NULL CHECK (tokens_in >= 0),
  tokens_out   INTEGER NOT NULL CHECK (tokens_out >= 0),
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_at ON usage_events (user_id, at);

DO $$
DECLARE
  sch TEXT := current_schema();
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['fabulist_play', 'fabulist_ingest'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.user_provider_keys, %I.usage_events TO %I',
        sch, sch, role_name
      );
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I.usage_events_id_seq TO %I', sch, role_name);
    END IF;
  END LOOP;
END
$$;
