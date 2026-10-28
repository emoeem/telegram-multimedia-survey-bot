-- 纸条聊天（0089）
--
-- 玩法：放纸条（性别/年龄段/地区/内容/配图）→ 他人随机抽取 → 抽中后建立
-- 一对一会话 → 双方可发文字/图片。纸条 7 天过期自动下架；每人同时只能有
-- 1 张 active 纸条（部分唯一索引保证）；抽取配额 = 每日 N 次免费 + 金币
-- 单次付费（额度在服务端决定，见 note-chat.service.ts）。
--
-- 身份锚点是 participant_hash（与金币账本同一套解析：TG / 邮箱 / 浏览器
-- key），全表不存任何可回溯的明文身份；交换联系方式属二期能力。

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_hash TEXT NOT NULL,
  gender TEXT NOT NULL,
  age_band TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  image_asset_id INTEGER,
  -- active | hidden（被举报暂隐）| withdrawn（主动下架）| expired（到期）| removed（管理移除）
  status TEXT NOT NULL DEFAULT 'active',
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- 「每人同时只能有 1 张有效纸条」由这条部分唯一索引在数据库层兜底，
-- 应用层校验只是给它一个友好文案。
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_owner_active ON notes(owner_hash) WHERE status = 'active';
-- 抽取池扫描：status + expires_at 前缀，RANDOM() 前 D1 只读这一小段。
CREATE INDEX IF NOT EXISTS idx_notes_pool ON notes(status, expires_at, id);

CREATE TABLE IF NOT EXISTS note_draws (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drawer_hash TEXT NOT NULL,
  note_id INTEGER NOT NULL,
  -- free（每日免费额）| coin（金币付费）
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- 今日已抽次数与免费额度判定走这条前缀索引；行数 ≤ 每人每天上限。
CREATE INDEX IF NOT EXISTS idx_draws_drawer_day ON note_draws(drawer_hash, created_at);

CREATE TABLE IF NOT EXISTS note_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  drawer_hash TEXT NOT NULL,
  -- active | closed
  status TEXT NOT NULL DEFAULT 'active',
  last_message_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  -- 同一张纸条同一抽中者只有一条会话；重复抽到自己的旧目标直接复用。
  UNIQUE(note_id, drawer_hash)
);
CREATE INDEX IF NOT EXISTS idx_threads_drawer ON note_threads(drawer_hash, last_message_at);

CREATE TABLE IF NOT EXISTS note_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES note_threads(id) ON DELETE CASCADE,
  sender_hash TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  image_asset_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON note_messages(thread_id, id);

-- 已读水位：会话列表的未读数 = 对方消息中 id 大于此水位的条数。
-- 一行一会话一人，GET 消息时顺手推进（搭车计数，不新增轮询写）。
CREATE TABLE IF NOT EXISTS note_thread_reads (
  thread_id INTEGER NOT NULL REFERENCES note_threads(id) ON DELETE CASCADE,
  participant_hash TEXT NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(thread_id, participant_hash)
);

-- 举报去重：同一人对同一张纸条只计一次。
CREATE TABLE IF NOT EXISTS note_reports (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  reporter_hash TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(note_id, reporter_hash)
);
