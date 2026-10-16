-- 0080 · 内容分级与公开面隔离
--
-- 两档分级：'all'（全年龄，默认）/ 'r18'（仅限已确认年龄的查看者）。
-- 默认 'all' 保证全部存量内容行为不变；存量成人内容的标注是运营动作
-- （管理端 / SQL 批量 UPDATE），不是迁移动作。
--
-- 公开面（目录、广场、展示区、抽卡池）对未确认年龄的查看者直接过滤掉
-- r18 行；确认状态记录在 participant_preferences（按 participant_hash，
-- 匿名浏览器 key 也可确认——分级门是合规 UX 与内容隔离，不是安全边界）。
--
-- 问卷填写入口与 OG 分享卡对 r18 内容另有安全渲染，见
-- src/services/content-rating.service.ts 与 survey-og-image.service.ts。

ALTER TABLE surveys ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'all';
ALTER TABLE gacha_pools ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'all';
ALTER TABLE gacha_pool_items ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'all';
ALTER TABLE plaza_posts ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'all';
ALTER TABLE showcase_persons ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'all';

CREATE TABLE IF NOT EXISTS participant_preferences (
  participant_hash TEXT PRIMARY KEY,
  age_verified_at TEXT,
  updated_at TEXT NOT NULL
);
