-- Private-story pilot key material. Browser-generated wraps only: no plaintext
-- passphrase, recovery code, master key, or per-story key is ever stored here.
CREATE TABLE IF NOT EXISTS user_encryption_keys (
  user_id                 TEXT PRIMARY KEY,
  version                 INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  passphrase_kdf          TEXT NOT NULL CHECK (passphrase_kdf = 'pbkdf2-sha256'),
  passphrase_kdf_params   JSONB NOT NULL,
  passphrase_salt         BYTEA NOT NULL,
  passphrase_nonce        BYTEA NOT NULL,
  passphrase_ciphertext   BYTEA NOT NULL,
  recovery_salt           BYTEA NOT NULL,
  recovery_nonce          BYTEA NOT NULL,
  recovery_ciphertext     BYTEA NOT NULL,
  recovery_code_hint      TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS story_encryption_keys (
  story_id                TEXT PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  owner_user_id           TEXT NOT NULL,
  version                 INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  nonce                   BYTEA NOT NULL,
  ciphertext              BYTEA NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_story_encryption_keys_owner ON story_encryption_keys (owner_user_id);
