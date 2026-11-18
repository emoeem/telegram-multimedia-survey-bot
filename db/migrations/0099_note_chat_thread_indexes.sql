-- 0099 · 纸条会话列表 UNION 两臂改写的配套索引（B8 · D1_EXPLAIN_AUDIT Q10）。
--
-- 会话列表原来是跨表 OR「WHERE (t.drawer_hash=? OR n.owner_hash=?)」：SQLite
-- 的 multi-index OR 只适用于同表谓词，任何索引都救不了——审计在本地 D1 实测
-- EXP1/EXP2 加索引后计划仍是 SCAN t（note_threads 全表扫描，note_threads 随
-- 玩法线性增长），唯一修法是服务层改写 UNION 两臂（EXP3 验证有效，
-- docs/audits/D1_EXPLAIN_AUDIT_2026-11-14.md §四）。本迁移补齐两臂各自的
-- 访问路径：
-- - 抽中者臂：note_threads(drawer_hash, status)——审计 EXP3 同款形态；
--   既有 idx_threads_drawer(drawer_hash, last_message_at) 只有前导列可用。
-- - 纸条主人臂：notes(owner_hash) 非部分索引——既有 idx_notes_owner_active
--   是 status='active' 的部分唯一索引，主人臂不过滤 notes.status，承接不了。
--
-- 注意：Q11/Q24（lastBodies / 未读数聚合）的修法是查询两步化，不依赖本
-- 迁移；那两条已在 note-chat.service.ts 的 listThreads 内改写完毕。
--
-- 回滚：DROP INDEX idx_threads_drawer_status / idx_notes_owner_hash——会话
-- 列表退回全表扫描，功能不受影响。

CREATE INDEX IF NOT EXISTS idx_threads_drawer_status ON note_threads(drawer_hash, status);
CREATE INDEX IF NOT EXISTS idx_notes_owner_hash ON notes(owner_hash);
