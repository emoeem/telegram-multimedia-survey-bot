PRAGMA foreign_keys=OFF;
CREATE TABLE media_assets_scope_migration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_scope TEXT NOT NULL DEFAULT 'legacy'
    CHECK (asset_scope IN ('survey', 'response', 'template', 'generated_result', 'template_preview', 'identity_card', 'legacy')),
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
INSERT INTO media_assets_scope_migration
  (id, asset_scope, media_type, telegram_file_id, telegram_file_unique_id, mime_type, file_name, file_size, width, height, duration, r2_key, created_at, updated_at)
SELECT id, asset_scope, media_type, telegram_file_id, telegram_file_unique_id, mime_type, file_name, file_size, width, height, duration, r2_key, created_at, updated_at
FROM media_assets;
DROP TABLE media_assets;
ALTER TABLE media_assets_scope_migration RENAME TO media_assets;
CREATE INDEX IF NOT EXISTS idx_media_assets_scope ON media_assets(asset_scope, id);
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS identity_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  nickname TEXT,
  age INTEGER,
  identity_label TEXT,
  description TEXT,
  front_asset_id INTEGER NOT NULL,
  back_asset_id INTEGER,
  template_style TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identity_profiles_user ON identity_profiles(user_id, id DESC);
