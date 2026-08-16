CREATE TABLE IF NOT EXISTS option_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_option_id INTEGER NOT NULL,
  media_asset_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (question_option_id) REFERENCES question_options(id) ON DELETE CASCADE,
  FOREIGN KEY (media_asset_id) REFERENCES media_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_option_media_option_id ON option_media(question_option_id);
