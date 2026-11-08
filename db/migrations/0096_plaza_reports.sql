-- 广场（树洞）举报 · UGC 覆盖面补齐（0096）
--
-- docs/FEATURE-OVERVIEW.md 早已声称树洞「每帖可举报」，但 plaza-api.ts 全文
-- grep「report」零命中：广场此前只有管理端下架，用户侧没有举报链路。本迁移
-- 按 0094 纸条举报的结构平移，但**去重键换成 users.id**，不能照抄 reporter_hash：
--   广场全部写路径都要求 dbUserId（plaza-api.ts 的发帖/传图/评论/晒进度无
--   dbUserId 一律 401 identity_required，帖子/评论落 user_id，限流键也是
--   String(dbUserId)）；而同一登录用户经 TG initData / 邮箱会话 / 匿名 key
--   三种会话态解析出的 participant_hash 各不相同——按 hash 去重（0094 的
--   UNIQUE(post_id, reporter_hash)）会被同一人多身份绕过，report_count 虚高
--   误触发自动隐藏。举报者列因此为 reporter_user_id INTEGER REFERENCES
--   users(id)（users 见 0001），同人同对象只计一次。
--
--   1) plaza_post_reports / plaza_comment_reports：举报明细，UNIQUE 兜底去重，
--      与 note_reports（0089）/note_message_reports（0094）同款结构。
--   2) plaza_posts.report_count / plaza_post_comments.report_count：冗余计数，
--      达到 PLAZA_REPORT_HIDE_THRESHOLD（src/services/plaza-report.service.ts
--      的常量，3，与纸条 REPORT_HIDE_THRESHOLD 同口径）自动下架；广场没有
--      独立的 hidden 态，status 只有 published | removed，自动隐藏 = 置
--      removed，管理端用既有 /api/admin/plaza/posts/status（comments 同款）
--      复核恢复。
--
-- 回滚（全部为加表/加列，可增量应用；回滚语句按依赖反序执行）：
--   DROP TABLE IF EXISTS plaza_comment_reports;
--   DROP TABLE IF EXISTS plaza_post_reports;
--   ALTER TABLE plaza_posts DROP COLUMN report_count;
--   ALTER TABLE plaza_post_comments DROP COLUMN report_count;
--
-- ⚠️ 硬约束（与 0094 同款声明，违反则上面的回滚方案失效，必须改写为重建表）：
--   新加的两列 report_count 不得被任何索引/触发器/视图引用，也不得参与
--   主键/UNIQUE。SQLite 的 ALTER TABLE ... DROP COLUMN 仅在列未被索引/
--   触发器/视图引用（且不参与主键/UNIQUE）时合法。本迁移只加列、不重建表
--   （plaza_posts 被 plaza_post_comments 外键引用，重建父表是 0068 铁律
--   禁止的路线，见 tests/unit/db/migrations-plaza-images.test.ts）。

ALTER TABLE plaza_posts ADD COLUMN report_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plaza_post_comments ADD COLUMN report_count INTEGER NOT NULL DEFAULT 0;

-- 树洞帖子举报：UNIQUE 以 post_id 为前缀，服务层计数与管理端聚合都走它。
CREATE TABLE IF NOT EXISTS plaza_post_reports (
  post_id INTEGER NOT NULL REFERENCES plaza_posts(id) ON DELETE CASCADE,
  reporter_user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(post_id, reporter_user_id)
);

-- 树洞评论举报：同款去重。comment_id 冗余无需 post_id——评论详情页按
-- comment_id 直查即可（与 0094 message 冗余 thread_id 的场景不同）。
CREATE TABLE IF NOT EXISTS plaza_comment_reports (
  comment_id INTEGER NOT NULL REFERENCES plaza_post_comments(id) ON DELETE CASCADE,
  reporter_user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(comment_id, reporter_user_id)
);
