CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  system_role TEXT NOT NULL DEFAULT 'participant',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  cover_media_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',
  anonymous INTEGER NOT NULL DEFAULT 0,
  allow_multiple_responses INTEGER NOT NULL DEFAULT 0,
  max_responses_per_user INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  closed_at TEXT,
  archived_at TEXT,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_surveys_owner_id ON surveys(owner_id);
CREATE INDEX IF NOT EXISTS idx_surveys_status ON surveys(status);
