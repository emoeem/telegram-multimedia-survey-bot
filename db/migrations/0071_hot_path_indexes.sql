-- Hot-path indexes: per-user response lookups, per-submit achievement counters
-- and the admin audit filter.
--
-- survey_responses had no index on user_id, so three flows degraded into full
-- table scans of the fastest-growing table: the bot's "我的答卷" lookup
-- (getActiveResponseByUser), the ban/cancel flow (cancelActiveResponsesForUser)
-- and the admin user directory, which runs a correlated completed-count per
-- user row. plaza_posts(user_id, status) is counted on every survey submit by
-- the achievement evaluation. audit_logs(action) backs the admin audit filter
-- over an append-only log that only ever grows.

CREATE INDEX IF NOT EXISTS idx_survey_responses_user_status
  ON survey_responses(user_id, status);

CREATE INDEX IF NOT EXISTS idx_plaza_posts_user_status
  ON plaza_posts(user_id, status);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action
  ON audit_logs(action);
