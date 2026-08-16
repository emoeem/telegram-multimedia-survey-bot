CREATE TABLE IF NOT EXISTS survey_completion_posters (
  survey_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  style TEXT NOT NULL DEFAULT 'clean',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE
);
