-- Add external_key column for hook-based session lookup
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS external_key TEXT;

-- Partial unique index: only one active session per external key
CREATE UNIQUE INDEX IF NOT EXISTS sessions_external_key_active_idx
  ON sessions(external_key) WHERE ended_at IS NULL;
