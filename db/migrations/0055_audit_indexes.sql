-- Read-path indexes identified in the 2026-09-27 code audit. Every one of
-- these removes a full-table scan (or an O(N^2) correlated probe) on a path
-- that grows without bound, which is the same failure class as the
-- 2026-09-14 D1 rows-read exhaustion incident.

-- Weekly digest filters survey_responses by started_at (twice per run).
CREATE INDEX IF NOT EXISTS idx_responses_started_at
  ON survey_responses(started_at);
CREATE INDEX IF NOT EXISTS idx_responses_status_started
  ON survey_responses(status, started_at);

-- Daily maintenance deletes stale in-progress responses by status + updated_at.
CREATE INDEX IF NOT EXISTS idx_responses_status_updated
  ON survey_responses(status, updated_at);

-- Daily maintenance prunes old audit rows by created_at.
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs(created_at);

-- Task leaderboard correlated subquery walks (pack_id, mode, status) per user.
CREATE INDEX IF NOT EXISTS idx_task_runs_user_pack_mode
  ON task_runs(user_id, pack_id, mode, status, score DESC);

-- Media answer writes/deletes filter by answer_id; only asset_id was indexed.
CREATE INDEX IF NOT EXISTS idx_answer_media_answer_id
  ON answer_media(answer_id);

-- Maintenance NOT EXISTS probes against these foreign keys.
CREATE INDEX IF NOT EXISTS idx_image_generator_jobs_report_result
  ON image_generator_jobs(report_result_id);
CREATE INDEX IF NOT EXISTS idx_image_generator_jobs_generator
  ON image_generator_jobs(generator_id);
CREATE INDEX IF NOT EXISTS idx_render_jobs_template
  ON render_jobs(template_id);
CREATE INDEX IF NOT EXISTS idx_image_generators_template
  ON image_generators(template_id);

-- "Claim my browser responses" path looks up by participant_hash alone.
CREATE INDEX IF NOT EXISTS idx_responses_participant_hash
  ON survey_responses(participant_hash);

-- Concurrent submit double-runs publishProfileResponse; this partial unique
-- index makes the gallery copy insert idempotent (the second INSERT ... ON
-- CONFLICT DO NOTHING is a no-op). NULL source_asset_id (source deleted) is
-- excluded so retained copies still count as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_profile_media_unique
  ON gallery_profile_media(response_id, source_asset_id)
  WHERE source_asset_id IS NOT NULL;
