-- Telegram webhook idempotency + read-path indexes for the hottest queries.
--
-- Idempotency: Telegram redelivers an update whenever the webhook response is
-- slow or lost. Without a dedup key, a redelivered "publish" / "submit" /
-- "export" / "reward" callback runs its side effects twice (duplicate version
-- snapshots, duplicated cards, double rewards). update_id is globally unique
-- per bot and stable across redeliveries, so it is the natural idempotency key.
--
-- The row is claimed with a single INSERT ... ON CONFLICT DO NOTHING, so the
-- steady-state cost is one write and zero reads. Rows are pruned by the daily
-- maintenance job; idx_telegram_update_dedup_received_at keeps that DELETE
-- bounded.
CREATE TABLE IF NOT EXISTS telegram_update_dedup (
  update_id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_update_dedup_received_at
  ON telegram_update_dedup(received_at);

-- Analytics: completion-time buckets filter one survey by status/completed_at.
CREATE INDEX IF NOT EXISTS idx_responses_survey_status_completed
  ON survey_responses(survey_id, status, completed_at DESC);

-- Option/numeric statistics aggregate answers per question across a survey.
-- The existing single-column index forces a rowid lookup per answer; this
-- covering-ish pair lets the planner read the grouping columns from the index.
CREATE INDEX IF NOT EXISTS idx_answers_question_response
  ON answers(question_id, response_id);

-- Survey definition loads order options per question on every open.
CREATE INDEX IF NOT EXISTS idx_question_options_question_order
  ON question_options(question_id, "order", id);

-- Audit log views sort newest-first and can filter by action or entity.
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_id
  ON audit_logs(action, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_id
  ON audit_logs(entity_type, entity_id, id DESC);

-- Admin job centers page export jobs newest-first.
CREATE INDEX IF NOT EXISTS idx_export_jobs_status_created
  ON export_jobs(status, created_at DESC, id DESC);
