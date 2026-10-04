CREATE TABLE publication_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT 'telegram_topic' CHECK(target_type IN ('telegram_topic')),
  chat_id TEXT NOT NULL,
  thread_id INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_publication_targets_default ON publication_targets(enabled, is_default, id);

ALTER TABLE survey_responses ADD COLUMN publication_target_id INTEGER REFERENCES publication_targets(id) ON DELETE SET NULL;
