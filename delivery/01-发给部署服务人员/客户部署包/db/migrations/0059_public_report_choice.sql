-- Public report publication is distinct from the profile-gallery choice.
-- The respondent's decision is persisted before asynchronous report rendering.
ALTER TABLE survey_responses ADD COLUMN report_publication_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE survey_responses ADD COLUMN report_publication_status TEXT NOT NULL DEFAULT 'private'
  CHECK(report_publication_status IN ('private','pending','published','failed'));
ALTER TABLE survey_responses ADD COLUMN report_published_at TEXT;
