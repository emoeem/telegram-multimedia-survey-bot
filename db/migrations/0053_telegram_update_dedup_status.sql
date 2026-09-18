-- Idempotency hardening for the Telegram webhook.
--
-- 0052 stores a claim row as soon as an update is received. If the Worker is
-- evicted between the claim and the end of processing (a deploy, an isolate
-- recycle, an OOM), the row stayed behind forever and every later redelivery
-- of that update_id was dropped — the user's button press was permanently
-- swallowed with no way to retry.
--
-- `status` separates an in-flight claim from a finished one:
--   * 'processing' — claimed, side effects not known to be complete;
--   * 'done'       — handled; redeliveries must be skipped.
-- A redelivery may atomically take over a 'processing' row whose claim is
-- older than the stale window, but never a 'done' row. The takeover is part of
-- the claim statement's ON CONFLICT DO UPDATE ... WHERE, so two concurrent
-- redeliveries cannot both win it.
ALTER TABLE telegram_update_dedup ADD COLUMN status TEXT NOT NULL DEFAULT 'processing';

-- Bounded scan for the stale-claim takeover and the retention sweep.
CREATE INDEX IF NOT EXISTS idx_telegram_update_dedup_status_received
  ON telegram_update_dedup(status, received_at);
