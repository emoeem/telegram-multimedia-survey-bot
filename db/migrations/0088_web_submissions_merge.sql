-- 0088: 网页投稿并轨 —— 免登录投稿的后端从独立的 submission-bot Worker 迁进本站。
--
-- 旧实现:浏览器 → /api/submit/*(经代理跨 Worker)→ submission-bot 的 D1
-- (另一个 Cloudflare 账号)。两套身份、两张表、两条审核流。
-- 新实现:同一批路径由本 Worker 直接服务,数据落在下面这几张表里;
-- submission-bot Worker 与 cn-relay 的直达路由随后退役。
--
-- 与旧库的字段对应(数据迁移脚本 scripts/migrate-web-submissions.mjs):
--   submissions(id, status, created_at, …)     → web_submissions
--   data.__viewer / __email / __ip             → 提升为独立列(原来埋在 JSON 里)
--   web_thread_messages                        → web_submission_threads
--   discussion_comments(网页投稿的评论区)      → web_submission_comments
--   web_rate_limits                            → web_rate_limits(同构)
--
-- 附件模型有意的差异:旧流程把文件传给旧机器人换 file_id(媒体只活在
-- Telegram 里);新流程把字节存进本站媒体库(media_assets,scope =
-- 'web_submission'),data JSON 里记 mediaAssetId。旧数据保持 file_id 引用,
-- 由 SUBMISSION_BOT_LEGACY_TOKEN 只读代取(见 web-submission.ts)。

CREATE TABLE IF NOT EXISTS web_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  viewer_token TEXT,
  email TEXT,
  nickname TEXT,
  ip TEXT,
  template_id TEXT NOT NULL DEFAULT 'default',
  data TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  flags TEXT,
  content_hash TEXT,
  publish_chat_id TEXT,
  publish_message_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_web_submissions_viewer
  ON web_submissions(viewer_token, id DESC);
CREATE INDEX IF NOT EXISTS idx_web_submissions_status
  ON web_submissions(status, id DESC);

CREATE TABLE IF NOT EXISTS web_submission_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  text TEXT NOT NULL,
  seen_by_author INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_threads_submission
  ON web_submission_threads(submission_id, id);

CREATE TABLE IF NOT EXISTS web_submission_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  telegram_chat_id TEXT,
  telegram_message_id INTEGER,
  author_name TEXT,
  text TEXT,
  kind TEXT NOT NULL DEFAULT 'user',
  parent_author TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_comments_submission
  ON web_submission_comments(submission_id, created_at DESC);

CREATE TABLE IF NOT EXISTS web_rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
