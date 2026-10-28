-- 小游戏区（原挑战任务区）：任务包升级为多玩法框架。
-- game_type 由代码层引擎注册表（src/trial/engine-registry.ts）校验，
-- 不加 CHECK 约束——未来新增玩法只需在注册表登记，免迁移。
-- settings_json 存玩法级配置；爬塔（tower）玩法目前忽略它。
ALTER TABLE task_packs ADD COLUMN game_type TEXT NOT NULL DEFAULT 'tower';
ALTER TABLE task_packs ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';
