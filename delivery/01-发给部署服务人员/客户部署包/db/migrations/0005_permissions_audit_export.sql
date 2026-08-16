CREATE TABLE IF NOT EXISTS survey_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  permission TEXT NOT NULL,
  granted_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (survey_id, user_id, permission)
);

CREATE TABLE IF NOT EXISTS survey_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL,
  participant_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE,
  UNIQUE (survey_id, participant_hash)
);

CREATE TABLE IF NOT EXISTS survey_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL,
  published_at TEXT,
  closed_at TEXT,
  published_by INTEGER,
  closed_by INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE,
  FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (closed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS export_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL,
  requested_by INTEGER,
  format TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  r2_key TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE,
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_permissions_survey_id ON survey_permissions(survey_id);
CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON survey_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
