-- 纸条聊天 · UGC 安全（0094）
--
-- Apple UGC 1.2 基线缺的两件 + 举报覆盖面扩展：
--   1) note_block：会话级拉黑。用户看不到裸 hash，入口是会话（按会话解析对方
--      hash 后写入）；双向生效——任一方向存在拉黑行，抽取池互相排除、消息
--      互不可发、会话列表互相不可见。
--   2) note_message_reports：会话消息举报。同人同消息只计一次（UNIQUE 兜底，
--      与 note_reports 同款去重）。消息不设自动隐藏阈值，隐藏由管理端复核
--      处置（POST /api/note/admin/messages/:id/status）。
--   3) note_messages.status：消息软删位（active | hidden）。管理端「移除」=
--      置 hidden，可恢复；note_threads.message_count 保持原始计数不改写。
--
-- 发布前过滤不在库层：内容过滤在服务校验阶段直接 422 拒绝（不落任何行），
-- 词表在 src/services/note-content-filter.service.ts；审后隐藏层由既有纸条
-- 举报阈值（REPORT_HIDE_THRESHOLD）与本表的管理处置承担。
--
-- 回滚（全部为加表/加列，可增量应用；回滚语句按依赖反序执行）：
--   DROP TABLE IF EXISTS note_message_reports;
--   DROP TABLE IF EXISTS note_block;
--   ALTER TABLE note_messages DROP COLUMN status;
--
-- ⚠️ 硬约束（违反则上面的回滚方案失效，必须改写为重建表——而 note_messages
-- 是被 note_thread_reads 外键引用链上的父表，0068 铁律禁止重建，见
-- tests/unit/db/migrations-plaza-images.test.ts）：
--   本迁移不得对 note_messages.status 建任何索引，也不得有触发器/视图引用
--   该列。SQLite 的 ALTER TABLE ... DROP COLUMN 仅在列未被索引/触发器/视图
--   引用（且不参与主键/UNIQUE）时合法。

-- 会话级拉黑：blocker 拉黑 blocked。PK 同时是查询前缀（blocker 侧）；
-- 反向查询（「谁拉黑了我」）走全表——本表只由用户显式动作写入，量级极小。
CREATE TABLE IF NOT EXISTS note_block (
  blocker_hash TEXT NOT NULL,
  blocked_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_hash, blocked_hash)
);

-- 会话消息举报：message_id 冗余 thread_id（管理端按会话聚合时免回连）。
CREATE TABLE IF NOT EXISTS note_message_reports (
  message_id INTEGER NOT NULL REFERENCES note_messages(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL,
  reporter_hash TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(message_id, reporter_hash)
);

ALTER TABLE note_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
