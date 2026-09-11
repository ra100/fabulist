-- One authenticated ciphertext envelope per private story field. The
-- plaintext is deliberately not duplicated in this table.
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
