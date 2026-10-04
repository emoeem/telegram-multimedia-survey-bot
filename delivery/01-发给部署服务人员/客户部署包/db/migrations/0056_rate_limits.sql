-- Atomic fixed-window rate limiting for brute-force-sensitive endpoints
-- (admin password login, survey access code). KV's read-modify-write is not
-- atomic, so N concurrent requests could all pass a "5 attempts / 5 minutes"
-- budget. This table backs an atomic counter (`INSERT ... ON CONFLICT DO
-- UPDATE SET count = count + 1 RETURNING count`) whose window resets when
-- `window_start` changes.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start
  ON rate_limits(window_start);
