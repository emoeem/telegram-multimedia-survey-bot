CREATE TABLE IF NOT EXISTS survey_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL,
  user_id INTEGER,
  participant_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  submitted_at TEXT,
  current_question_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (current_question_id) REFERENCES survey_questions(id) ON DELETE SET NULL,
  UNIQUE (survey_id, participant_hash)
);

CREATE TABLE IF NOT EXISTS answers (
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

CREATE TABLE IF NOT EXISTS answer_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id INTEGER NOT NULL,
  question_option_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (answer_id) REFERENCES answers(id) ON DELETE CASCADE,
  FOREIGN KEY (question_option_id) REFERENCES question_options(id) ON DELETE CASCADE,
  UNIQUE (answer_id, question_option_id)
);

CREATE TABLE IF NOT EXISTS answer_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id INTEGER NOT NULL,
  media_asset_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (answer_id) REFERENCES answers(id) ON DELETE CASCADE,
  FOREIGN KEY (media_asset_id) REFERENCES media_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_responses_survey_id ON survey_responses(survey_id);
CREATE INDEX IF NOT EXISTS idx_responses_participant ON survey_responses(survey_id, participant_hash);
CREATE INDEX IF NOT EXISTS idx_answers_response_id ON answers(response_id);
CREATE INDEX IF NOT EXISTS idx_answers_question_id ON answers(question_id);
