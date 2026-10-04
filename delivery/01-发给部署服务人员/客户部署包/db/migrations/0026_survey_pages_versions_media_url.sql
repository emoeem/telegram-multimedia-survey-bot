-- Phase 1 (Web-first migration): survey definition versioning, page support,
-- and URL-backed media.
--
-- * survey_versions stores a full UnifiedSurvey snapshot per published
--   version so historical responses can be rebuilt even if question content
--   ever changes or is deleted.
-- * survey_pages gives questions a pagination grouping without changing the
--   existing flat question ordering.
-- * media_assets.url enables URL-backed media (previously only Telegram
--   file_id and an unused r2_key column could be stored).

CREATE TABLE IF NOT EXISTS survey_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (survey_id, version)
);

CREATE INDEX IF NOT EXISTS idx_survey_versions_survey
  ON survey_versions(survey_id, version DESC);

CREATE TABLE IF NOT EXISTS survey_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL,
  title TEXT,
  description TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_survey_pages_survey
  ON survey_pages(survey_id, "order", id);

ALTER TABLE survey_questions ADD COLUMN page_id INTEGER REFERENCES survey_pages(id) ON DELETE SET NULL;

ALTER TABLE media_assets ADD COLUMN url TEXT;

CREATE INDEX IF NOT EXISTS idx_media_assets_url ON media_assets(url);
