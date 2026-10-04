-- 树洞图片帖 + #话题#（0068）
--
-- ⚠️ 这个迁移**故意不重建 media_assets**（第一版那样做在生产 D1 上直接失败）：
-- D1 把每个迁移文件当作一次原子批处理执行，事务内的 `PRAGMA foreign_keys=OFF`
-- 是 no-op（SQLite 规定 FK 只能在事务外开关），于是远端 DROP TABLE media_assets
-- 会做一次隐式 DELETE 并触发外键动作，报：
--   FOREIGN KEY constraint failed: SQLITE_CONSTRAINT_TRIGGER [code: 7500]
-- `PRAGMA defer_foreign_keys` 也救不了：它只推迟「检查」，DROP 引发的
-- ON DELETE CASCADE / SET NULL 动作照样会波及子表数据（question_media /
-- answer_media / gallery_profile_media …），所以「重建父表来放宽 CHECK」这条路
-- 在 D1 上不可用。树洞配图因此复用 CHECK 已允许的 scope，识别靠 KV key 前缀，
-- 详见 src/services/plaza-media.service.ts。
ALTER TABLE plaza_posts ADD COLUMN image_asset_id INTEGER;
ALTER TABLE plaza_posts ADD COLUMN topic TEXT;

CREATE INDEX IF NOT EXISTS idx_plaza_posts_topic ON plaza_posts(topic, id DESC);
-- 孤儿媒体清理拿它做反连接；同时它也是「迁移是否已落地」的探针：列不存在时
-- 建索引会失败，维护任务会因此跳过整轮清理（见 database-maintenance.service.ts）。
CREATE INDEX IF NOT EXISTS idx_plaza_posts_image_asset ON plaza_posts(image_asset_id);
