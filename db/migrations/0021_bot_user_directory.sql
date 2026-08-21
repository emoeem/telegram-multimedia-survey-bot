ALTER TABLE users ADD COLUMN bot_started_at TEXT;
UPDATE users SET bot_started_at = created_at WHERE bot_started_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_bot_started_at
  ON users(bot_started_at DESC, id DESC);
