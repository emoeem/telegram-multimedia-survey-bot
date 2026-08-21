CREATE TABLE IF NOT EXISTS feature_access_settings (
  feature TEXT PRIMARY KEY,
  access_code TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_access_grants (
  feature TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  setting_version INTEGER NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (feature, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_feature_access_grants_feature_version
  ON feature_access_grants(feature, setting_version);
