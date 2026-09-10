-- Personal-profile gallery: a designated survey's responses can be published
-- by their owners and shown in the public plaza as a photo + answer feed.
-- Uploaded images are copied into long-lived gallery assets at publish time
-- (the original response media stays subject to the 7-day temp cleanup).
ALTER TABLE survey_responses ADD COLUMN gallery_published INTEGER NOT NULL DEFAULT 0;
ALTER TABLE survey_responses ADD COLUMN gallery_published_at TEXT;

CREATE TABLE IF NOT EXISTS gallery_profile_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
  media_asset_id INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
  source_asset_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gallery_profile_media_response
  ON gallery_profile_media(response_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_survey_responses_gallery
  ON survey_responses(gallery_published, gallery_published_at DESC);
