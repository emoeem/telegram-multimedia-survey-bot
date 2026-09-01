-- Migration 0034 rebuilt survey_responses with a rename dance, but D1's
-- SQLite rewrote the FK clauses in child tables to point at the dropped
-- survey_responses_rebuild table.  Every INSERT into answers /
-- result_profiles / report_deliveries then fails FK validation with
-- "no such table: main.survey_responses_rebuild", surfacing as a Worker 500
-- (Cloudflare error 1101) on every report page, report delivery and new
-- answer write.
--
-- Rebuild the three affected tables with FKs pointing at the real
-- survey_responses table.  D1's migration runner renames tables with FK
-- rewriting enabled (legacy_alter_table is not sticky per statement), so a
-- direct DROP of a parent would cascade-delete its children.  Each parent is
-- therefore swapped in two phases:
--   1. children referencing the parent are rebuilt first so their FK clauses
--      point at the replacement table (these children are leaves, so the
--      DROP of their old copy cannot cascade);
--   2. only then is the old parent dropped (nothing references it) and the
--      replacement renamed to the canonical name, which bounces the rebuilt
--      children's FK clauses back to the canonical table.

PRAGMA defer_foreign_keys = true;
PRAGMA legacy_alter_table = ON;

-- ================= answers =================
CREATE TABLE answers_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  text_value TEXT,
  number_value REAL,
  boolean_value INTEGER,
  rating_value INTEGER,
  date_value TEXT,
  time_value TEXT,
  json_value TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (response_id) REFERENCES survey_responses(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES survey_questions(id) ON DELETE CASCADE,
  UNIQUE (response_id, question_id)
);
INSERT INTO answers_new SELECT * FROM answers;

CREATE TABLE answer_options_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id INTEGER NOT NULL,
  question_option_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (answer_id) REFERENCES answers_new(id) ON DELETE CASCADE,
  FOREIGN KEY (question_option_id) REFERENCES question_options(id) ON DELETE CASCADE,
  UNIQUE (answer_id, question_option_id)
);
INSERT INTO answer_options_new SELECT * FROM answer_options;
DROP TABLE answer_options;
ALTER TABLE answer_options_new RENAME TO answer_options;

CREATE TABLE answer_media_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id INTEGER NOT NULL,
  media_asset_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (answer_id) REFERENCES answers_new(id) ON DELETE CASCADE,
  FOREIGN KEY (media_asset_id) REFERENCES media_assets(id) ON DELETE CASCADE
);
INSERT INTO answer_media_new SELECT * FROM answer_media;
DROP TABLE answer_media;
ALTER TABLE answer_media_new RENAME TO answer_media;
CREATE INDEX IF NOT EXISTS idx_answer_media_asset_id
  ON answer_media(media_asset_id);

DROP TABLE answers;
ALTER TABLE answers_new RENAME TO answers;
CREATE INDEX IF NOT EXISTS idx_answers_response_id ON answers(response_id);
CREATE INDEX IF NOT EXISTS idx_answers_question_id ON answers(question_id);
CREATE INDEX IF NOT EXISTS idx_answers_response_id_id
  ON answers(response_id, id);

-- ================= result_profiles =================
CREATE TABLE result_profiles_new (
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
INSERT INTO result_profiles_new SELECT * FROM result_profiles;

CREATE TABLE render_jobs_new (
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
  FOREIGN KEY (result_profile_id) REFERENCES result_profiles_new(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES visual_templates(id) ON DELETE RESTRICT,
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO render_jobs_new SELECT * FROM render_jobs;
DROP TABLE render_jobs;
ALTER TABLE render_jobs_new RENAME TO render_jobs;
CREATE INDEX IF NOT EXISTS idx_render_jobs_status_created_at
  ON render_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_render_jobs_retention
  ON render_jobs(status, completed_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_render_jobs_active
  ON render_jobs(result_profile_id, template_id, template_version)
  WHERE status IN ('queued', 'processing');

DROP TABLE result_profiles;
ALTER TABLE result_profiles_new RENAME TO result_profiles;
CREATE INDEX IF NOT EXISTS idx_result_profiles_survey_id
  ON result_profiles(survey_id);

-- ================= report_deliveries =================
CREATE TABLE report_deliveries_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL UNIQUE,
  report_version INTEGER NOT NULL DEFAULT 1,
  delivery_id TEXT NOT NULL UNIQUE,
  telegram_chat_id INTEGER,
  pdf_message_id INTEGER,
  image_message_ids_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (response_id) REFERENCES survey_responses(id) ON DELETE CASCADE
);
INSERT INTO report_deliveries_new SELECT * FROM report_deliveries;
DROP TABLE report_deliveries;
ALTER TABLE report_deliveries_new RENAME TO report_deliveries;
CREATE INDEX IF NOT EXISTS idx_report_deliveries_status
  ON report_deliveries(status, next_retry_at);
