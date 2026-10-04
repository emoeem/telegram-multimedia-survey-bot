-- Atomic one-time redemption for browser-to-Telegram admin login requests.
-- KV stores the short-lived state, but cannot perform a compare-and-swap.
-- The primary key below makes concurrent status polls single-use.
CREATE TABLE IF NOT EXISTS admin_login_consumptions (
  login_request_id TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL,
  consumed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_login_consumptions_consumed_at
  ON admin_login_consumptions(consumed_at);
