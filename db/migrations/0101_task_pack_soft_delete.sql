-- 0101: task_packs 软删（墓碑）——止血「硬删级联清空对局历史」。
--
-- 动机：0045_trial_tasks.sql:20（task_items.pack_id）与 :38（task_runs.pack_id）
-- 的外键均 REFERENCES task_packs(id) ON DELETE CASCADE，且 D1 强制外键
-- （0034_survey_responses_allow_refill.sql:11-16 明确记载 "D1 keeps PRAGMA
-- foreign_keys enforced"）——硬删父包会一次性级联清空该包全部 task_items 与
-- task_runs，战绩/排行/对局记录/成就/画像等查询面同时受损，且不可恢复；
-- 管理端确认文案却承诺「历史挑战记录不受影响」，与实际行为自相矛盾。
--
-- 本迁移把删除语义改为软删：deleted_at IS NOT NULL 即墓碑。仓库层
-- （task-pack.repository.ts）默认排除墓碑维持玩家可见性；成绩类查询面
-- （玩法总榜子查询、/api/trial/history 的包名映射）显式不过滤——成绩已经
-- 发生，不因包下架而消失（与 task-run 榜单既有设计意图一致）。
--
-- 模式复用 0074_soft_delete.sql：ADD COLUMN + 局部索引（只索引常见
-- 「活跃」路径，墓碑行不入索引）。

ALTER TABLE task_packs ADD COLUMN deleted_at TEXT;

-- 活跃列表局部索引：覆盖 listTaskPacks 的默认过滤（enabled + 未删）与排序
-- （sort_order, id）；墓碑行不入索引（task_packs 极小，全表扫描无碍）。
-- 注意：task_packs 不在回收站白名单内（src/http/admin/trash.ts:23），墓碑
-- 不可见且无恢复端点；名称唯一索引的软删适配见 0102_task_pack_name_reuse.sql。
CREATE INDEX IF NOT EXISTS idx_task_packs_active_list
  ON task_packs(enabled, sort_order, id) WHERE deleted_at IS NULL;
