-- 0102 · task_packs 名称唯一索引改为「仅活跃行」局部唯一（0101 软删配套）。
--
-- 动机：0100 给 task_packs(name) 加的是全量唯一索引（防 0049 裸 INSERT 重放
-- 翻倍的种子守卫，见 0100:21-22）。0101 起删除改为软删墓碑（不再硬删释放
-- 资源），但墓碑行仍占着 name——删包后重建同名包会在建包 INSERT 上抛
-- UNIQUE constraint failed: task_packs.name，经管理端兜底（src/http/admin/
-- index.ts:56-66 + src/db/errors.ts:39）变成 500「服务器暂时无法处理请求」；
-- 且墓碑对管理端列表不可见（read.ts 默认排除）、回收站白名单不含 task_pack
-- （src/http/admin/trash.ts:23），没有任何 UI/API 途径释放名称。批次前硬删
-- 时代「删后重建同名」是可行操作，软删后不能悄悄变成 500。
--
-- 修正：DROP 全量唯一索引，重建为 WHERE deleted_at IS NULL 的局部唯一索引。
-- 0100 的守卫语义保持成立——0049 重放插入的是活跃行（deleted_at 为 NULL，
-- 落在局部索引内），同名裸 INSERT 照样立刻报 UNIQUE 浮出问题；墓碑行不参与
-- 唯一性约束，同名墓碑可存在多个，活跃行之间仍互斥，删包即释放名称。
--
-- 回滚：DROP INDEX idx_task_packs_name 后按 0100 原样重建全量唯一索引
-- （需先物理清除墓碑行，否则与活跃行同名会建索引失败）。

DROP INDEX IF EXISTS idx_task_packs_name;

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_packs_name
  ON task_packs(name) WHERE deleted_at IS NULL;
