-- 小游戏排行榜 · 玩法聚合视角（0095）
--
-- 聚合榜（GET /api/trial/leaderboard?gameType=…&mode=…）按 (gameType, mode)
-- 分榜聚合：task_runs 侧谓词是
--   pack_id IN (SELECT id FROM task_packs WHERE game_type = ?)
-- task_packs 是小表（每玩法仅数包），但 game_type 上原本没有任何索引
-- （grep -rln "idx_task_packs" db/migrations/ 零命中），包集合解析只能全表
-- 扫。本迁移仅补这一条索引：task_runs 侧沿用 0045 的
-- idx_task_runs_leaderboard（pack_id 前导），每包一段索引范围扫描做聚合。
--
-- 回滚（可增量应用；单独一条索引，回滚即删）：
--   DROP INDEX IF EXISTS idx_task_packs_game_type;

CREATE INDEX IF NOT EXISTS idx_task_packs_game_type ON task_packs(game_type);
