-- "Fill again" (surveys with allow_multiple_responses and admins re-filling a
-- published survey) inserts a second survey_responses row for the same
-- (survey_id, participant_hash) pair, which the table-level UNIQUE constraint
-- from 0004 rejected with an uncaught 500.
--
-- SQLite cannot drop a table constraint in place, so the table is rebuilt
-- without it. In-progress dedupe (the resume flow) is preserved with a
-- partial unique index; completed/archived responses may repeat freely.
--
-- The rebuild uses the rename dance instead of a plain DROP because D1 keeps
-- PRAGMA foreign_keys enforced: dropping survey_responses directly would run
-- an implicit DELETE that cascades into result_visuals and report_deliveries.
-- With legacy_alter_table the rename leaves child FK clauses untouched, so
-- the copy target owns the canonical name before any child row is touched.
PRAGMA defer_foreign_keys = true;
PRAGMA legacy_alter_table = ON;
ALTER TABLE survey_responses RENAME TO survey_responses_rebuild;
CREATE TABLE survey_responses (
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
  device_fingerprint TEXT,
  browser_info TEXT,
  ip_address TEXT,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (current_question_id) REFERENCES survey_questions(id) ON DELETE SET NULL
);
INSERT INTO survey_responses (
  id, survey_id, user_id, participant_hash, status, started_at, completed_at,
  submitted_at, current_question_id, version, created_at, updated_at,
  device_fingerprint, browser_info, ip_address
)
SELECT
  id, survey_id, user_id, participant_hash, status, started_at, completed_at,
  submitted_at, current_question_id, version, created_at, updated_at,
  device_fingerprint, browser_info, ip_address
FROM survey_responses_rebuild;
DROP TABLE survey_responses_rebuild;
CREATE INDEX IF NOT EXISTS idx_responses_participant
  ON survey_responses(survey_id, participant_hash);
CREATE INDEX IF NOT EXISTS idx_responses_user_status_id
  ON survey_responses(user_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_responses_survey_status_id
  ON survey_responses(survey_id, status, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_active_participant
  ON survey_responses(survey_id, participant_hash) WHERE status = 'in_progress';
