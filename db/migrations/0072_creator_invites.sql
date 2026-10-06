-- 体验创作者邀请码
--
-- 管理员生成一个码（天数 / 有效期 / 可用次数），对方自己在机器人里兑换开通：
-- 不用先问出对方的 Telegram 数字 ID，也不用共享任何密码。授权仍然落到对方自己的
-- Telegram 身份上（走既有的 creator_trial_grants），到期/撤销语义完全复用。
CREATE TABLE IF NOT EXISTS creator_invites (
  code TEXT PRIMARY KEY,
  days INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  note TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_creator_invites_expires_at ON creator_invites(expires_at);
