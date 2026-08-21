CREATE INDEX IF NOT EXISTS idx_responses_user_status_id
  ON survey_responses(user_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_responses_survey_status_id
  ON survey_responses(survey_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_answers_response_id_id
  ON answers(response_id, id);
CREATE INDEX IF NOT EXISTS idx_answer_media_asset_id
  ON answer_media(media_asset_id);
CREATE INDEX IF NOT EXISTS idx_question_media_asset_id
  ON question_media(media_asset_id);
CREATE INDEX IF NOT EXISTS idx_option_media_asset_id
  ON option_media(media_asset_id);
CREATE INDEX IF NOT EXISTS idx_users_updated_at
  ON users(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_render_jobs_retention
  ON render_jobs(status, completed_at, created_at);
CREATE INDEX IF NOT EXISTS idx_image_generator_jobs_retention
  ON image_generator_jobs(status, completed_at, created_at);
CREATE INDEX IF NOT EXISTS idx_export_jobs_retention
  ON export_jobs(status, completed_at, created_at);
CREATE INDEX IF NOT EXISTS idx_surveys_draft_retention
  ON surveys(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_visual_templates_draft_retention
  ON visual_templates(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_image_generators_draft_retention
  ON image_generators(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_report_results_retention
  ON report_results(created_at, id);

CREATE TABLE IF NOT EXISTS visual_template_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  template_version INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'static',
  created_at TEXT NOT NULL,
  FOREIGN KEY (template_id) REFERENCES visual_templates(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES media_assets(id) ON DELETE RESTRICT,
  UNIQUE (template_id, template_version, asset_id, role)
);
CREATE INDEX IF NOT EXISTS idx_visual_template_assets_template
  ON visual_template_assets(template_id, template_version);
CREATE INDEX IF NOT EXISTS idx_visual_template_assets_asset
  ON visual_template_assets(asset_id);

INSERT OR IGNORE INTO visual_template_assets
  (template_id, template_version, asset_id, role, created_at)
SELECT template_id, version, json_extract(definition_json, '$.background.assetId'), 'background', created_at
FROM visual_template_versions
WHERE json_extract(definition_json, '$.background.type') = 'telegram_asset'
  AND CAST(json_extract(definition_json, '$.background.assetId') AS INTEGER) > 0;
