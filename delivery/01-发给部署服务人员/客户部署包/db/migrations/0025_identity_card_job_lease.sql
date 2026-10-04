ALTER TABLE identity_card_jobs ADD COLUMN processing_started_at TEXT;
CREATE INDEX IF NOT EXISTS idx_identity_card_jobs_processing_lease
  ON identity_card_jobs(status, processing_started_at, created_at);
