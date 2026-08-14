CREATE TABLE IF NOT EXISTS media_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_type TEXT NOT NULL,
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  mime_type TEXT,
  file_name TEXT,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  duration INTEGER,
  r2_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  media_asset_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (question_id) REFERENCES survey_questions(id) ON DELETE CASCADE,
  FOREIGN KEY (media_asset_id) REFERENCES media_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_media_assets_type ON media_assets(media_type);
CREATE INDEX IF NOT EXISTS idx_media_assets_unique_id ON media_assets(telegram_file_unique_id);
CREATE INDEX IF NOT EXISTS idx_question_media_question_id ON question_media(question_id);
