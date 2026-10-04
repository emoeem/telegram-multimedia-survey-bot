CREATE TABLE IF NOT EXISTS identity_card_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_profile_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (identity_profile_id) REFERENCES identity_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_identity_card_jobs_status
  ON identity_card_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_identity_card_jobs_retention
  ON identity_card_jobs(status, completed_at, created_at);
