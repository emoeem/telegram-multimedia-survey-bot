CREATE TABLE IF NOT EXISTS survey_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  required INTEGER NOT NULL DEFAULT 1,
  "order" INTEGER NOT NULL DEFAULT 0,
  validation_json TEXT,
  settings_json TEXT,
  parent_question_id INTEGER,
  condition_json TEXT,
  skip_to_question_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_question_id) REFERENCES survey_questions(id) ON DELETE SET NULL,
  FOREIGN KEY (skip_to_question_id) REFERENCES survey_questions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS question_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,
  is_other INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (question_id) REFERENCES survey_questions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_questions_survey_id ON survey_questions(survey_id);
CREATE INDEX IF NOT EXISTS idx_questions_order ON survey_questions(survey_id, "order");
CREATE INDEX IF NOT EXISTS idx_question_options_question_id ON question_options(question_id);
