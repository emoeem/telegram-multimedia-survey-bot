CREATE TABLE IF NOT EXISTS survey_result_rule_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL DEFAULT 1,
  rules_json TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS visual_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER,
  survey_id INTEGER,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  current_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS visual_template_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  template_schema_version INTEGER NOT NULL DEFAULT 1,
  definition_json TEXT NOT NULL,
  variables_json TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (template_id) REFERENCES visual_templates(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (template_id, version)
);

CREATE TABLE IF NOT EXISTS survey_result_visual_settings (
  survey_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  auto_generate INTEGER NOT NULL DEFAULT 0,
  template_id INTEGER,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES visual_templates(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS result_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL,
  response_id INTEGER NOT NULL,
  result_type TEXT NOT NULL DEFAULT 'custom',
  schema_version INTEGER NOT NULL DEFAULT 1,
  title TEXT,
  subtitle TEXT,
  fields_json TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  images_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE,
  FOREIGN KEY (response_id) REFERENCES survey_responses(id) ON DELETE CASCADE,
  UNIQUE (response_id)
);

CREATE TABLE IF NOT EXISTS render_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  result_profile_id INTEGER NOT NULL,
  template_id INTEGER NOT NULL,
  template_version INTEGER NOT NULL,
  chat_id INTEGER,
  requested_by INTEGER,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  force_regenerate INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (result_profile_id) REFERENCES result_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES visual_templates(id) ON DELETE RESTRICT,
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_visual_templates_owner_id
  ON visual_templates(owner_id);
CREATE INDEX IF NOT EXISTS idx_visual_templates_survey_id
  ON visual_templates(survey_id);
CREATE INDEX IF NOT EXISTS idx_visual_template_versions_template_id
  ON visual_template_versions(template_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_result_profiles_survey_id
  ON result_profiles(survey_id);
CREATE INDEX IF NOT EXISTS idx_render_jobs_status_created_at
  ON render_jobs(status, created_at);
