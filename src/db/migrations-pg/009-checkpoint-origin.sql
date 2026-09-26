-- turn:agent, turn:server or tool:<name>; NULL for checkpoints written before origins existed.
ALTER TABLE history_checkpoints ADD COLUMN IF NOT EXISTS origin TEXT;
