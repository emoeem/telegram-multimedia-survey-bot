-- 0100 · K9 任务包重复数据修正（B8 · 三端可见数据缺陷）。
--
-- 现象：GET /api/trial/packs（src/http/trial-api.ts）返回两条同名同描述的
-- 「K9 犬训 · 原典 200 题」。
--
-- 根因（已实读证实）：db/migrations/0049_k9_task_pack.sql 用裸
-- INSERT INTO task_packs（无 OR IGNORE / WHERE NOT EXISTS 守卫），而 0045
-- 建表对 name 无唯一约束——迁移文件在既有库上被重放（部署事故/手工重跑）
-- 即整包重复；且 0049 的每个 task_items 语句按
-- 「SELECT id FROM task_packs WHERE name = 'K9 犬训 · 原典 200 题'」反查，
-- 重放后同名包有两行，每个语句各插两份条目：保留包内出现逐字重复的条目
-- 对，重复包内也有一整套副本。
--
-- 修正（幂等、可重放，按序执行）：
-- 1) 把挂在重复包上的游玩历史（task_runs）改挂到保留包（保留 MIN(id)，
--    按重放顺序它是最早的原版）——避免删包连带 ON DELETE CASCADE 丢玩家
--    历史与排行数据；
-- 2) 删除重复包（task_items 随外键 CASCADE，删的是逐字重放的副本）；
-- 3) 删除保留包内「内容逐字节完全相同」的重复条目（同一语句按两个同名包
--    各插一份导致；只按全内容分组，不碰标题相同但内容不同的手工条目）；
-- 4) 加 task_packs(name) 唯一索引——既是收口也是种子守卫：0049 这类裸
--    INSERT 再被重放会立刻报错浮出问题，而不是悄悄翻倍。
--
-- 对既有部署之外的约束核对：0045/0047/0049 的种子包名互不相同（本迁移在
-- 全新库上应用时 1)-3) 均为空操作，4) 直接成立）；管理端 task-pack
-- repository 的建包路径此后撞名会收到 UNIQUE 报错（防重 guard 的预期行为）。
--
-- 回滚：DROP INDEX idx_task_packs_name 即恢复旧约束；数据去重不可逆，但
-- 被删的都是逐字重复副本、游玩历史已改挂保留包，无信息丢失。

UPDATE task_runs
   SET pack_id = (SELECT MIN(p2.id) FROM task_packs p2
                   WHERE p2.name = (SELECT p3.name FROM task_packs p3 WHERE p3.id = task_runs.pack_id))
 WHERE pack_id IN (SELECT p.id FROM task_packs p
                    WHERE p.id > (SELECT MIN(p4.id) FROM task_packs p4 WHERE p4.name = p.name));

DELETE FROM task_packs
 WHERE id NOT IN (SELECT MIN(id) FROM task_packs GROUP BY name);

DELETE FROM task_items
 WHERE id NOT IN (
   SELECT MIN(id) FROM task_items
   GROUP BY pack_id, title, description, warning, score, persona, mode,
            min_floor, max_floor, enabled, sort_order
 );

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_packs_name ON task_packs(name);
