DROP INDEX IF EXISTS idx_image_generator_questions_generator;
ALTER TABLE image_generator_questions RENAME TO image_generator_questions_legacy;

CREATE TABLE image_generator_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generator_id INTEGER NOT NULL,
  variable_name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'long_text', 'number', 'single', 'multiple', 'rating', 'image', 'boolean', 'date')),
  required INTEGER NOT NULL DEFAULT 1,
  options_json TEXT NOT NULL DEFAULT '[]',
  settings_json TEXT NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (generator_id) REFERENCES image_generators(id) ON DELETE CASCADE,
  UNIQUE(generator_id, variable_name)
);

INSERT INTO image_generator_questions (
  id, generator_id, variable_name, prompt, type, required, options_json, settings_json, sort_order, created_at
)
SELECT id, generator_id, variable_name, prompt, type, required, '[]', '{}', sort_order, created_at
FROM image_generator_questions_legacy;

DROP TABLE image_generator_questions_legacy;
CREATE INDEX IF NOT EXISTS idx_image_generator_questions_generator ON image_generator_questions(generator_id, sort_order);

CREATE TABLE IF NOT EXISTS report_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generator_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  answers_json TEXT NOT NULL,
  media_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (generator_id) REFERENCES image_generators(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_report_results_generator_user ON report_results(generator_id, user_id, created_at);

ALTER TABLE image_generator_jobs ADD COLUMN report_result_id INTEGER REFERENCES report_results(id) ON DELETE SET NULL;
