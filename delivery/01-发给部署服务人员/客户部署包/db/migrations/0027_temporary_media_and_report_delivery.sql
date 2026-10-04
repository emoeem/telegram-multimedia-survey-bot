-- Phase 1 (media lifecycle): temporary response media + report delivery state.
--
-- media_assets.storage_kind makes the storage provider explicit:
--   'telegram'   -> telegram_file_id (legacy and bot media)
--   'temporary'  -> transient KV-backed blob, storage_key holds the KV key
--   'r2'         -> R2 object, storage_key (or legacy r2_key) holds the key
--   'url'        -> direct external URL
-- Legacy rows keep 'telegram'; new temporary uploads are always written with
-- 'temporary' plus an expires_at so the semantic never relies on defaults.

ALTER TABLE media_assets ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'telegram';
ALTER TABLE media_assets ADD COLUMN storage_key TEXT;
ALTER TABLE media_assets ADD COLUMN expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_media_assets_temp_expiry
  ON media_assets(storage_kind, expires_at);

-- One archived report per response. delivery_id is the idempotency key used
-- by the queue worker so retries can never double-archive a report.
CREATE TABLE IF NOT EXISTS report_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL UNIQUE,
  report_version INTEGER NOT NULL DEFAULT 1,
  delivery_id TEXT NOT NULL UNIQUE,
  telegram_chat_id INTEGER,
  pdf_message_id INTEGER,
  image_message_ids_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (response_id) REFERENCES survey_responses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_report_deliveries_status
  ON report_deliveries(status, next_retry_at);
