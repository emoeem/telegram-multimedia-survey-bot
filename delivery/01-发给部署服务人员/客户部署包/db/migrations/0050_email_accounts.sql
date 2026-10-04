-- 邮箱账号：独立的账户表，不动 users（users 的 telegram_user_id 仍是
-- NOT NULL UNIQUE，重建该表会破坏所有子表外键）。邮箱账户通过可选的
-- user_id 关联 Telegram 身份（绑定功能），未绑定时以 email_{id} 作为
-- 参与者哈希参与答卷与挑战。
CREATE TABLE IF NOT EXISTS email_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_sessions_account ON email_sessions(account_id, expires_at);
