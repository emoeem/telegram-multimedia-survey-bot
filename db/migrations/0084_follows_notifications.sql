-- 0084 · 追更与站内通知
--
-- 关注是 Web 站内的追更订阅：关注系列后，作者发布新章节时往 notifications
-- 插一行，SPA 的铃铛入口拉取；TG push 是对绑定身份的兜底召回（发失败不影响
-- 发布）。通知归属按 participant_hash（0082 canonical），换身份不丢。

CREATE TABLE IF NOT EXISTS series_follows (
  participant_hash TEXT NOT NULL,
  series_id INTEGER NOT NULL REFERENCES survey_series(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE (participant_hash, series_id)
);
CREATE INDEX IF NOT EXISTS idx_series_follows_series ON series_follows(series_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_participant ON notifications(participant_hash, id DESC);
