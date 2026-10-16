-- 0083 · 系列模型（连载）
--
-- 问卷 = 一章。series 聚合同一作者名下的连续内容：
--   * 章节顺序由 surveys.series_order 决定（1 起，同系列内唯一由应用层保证）；
--   * 系列内容分级 = 章节的最高档（读侧推导，不落列）：目录/列表对未确认
--     年龄的查看者只展示含可见全年龄章节的系列（0080 的公开面规则）；
--   * 续读 = 按当前查看者的答卷状态推导（survey_responses IN 并集），
--     不落存储；关注（0084）另表。

CREATE TABLE IF NOT EXISTS survey_series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_media_id INTEGER,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE surveys ADD COLUMN series_id INTEGER REFERENCES survey_series(id) ON DELETE SET NULL;
ALTER TABLE surveys ADD COLUMN series_order INTEGER;
CREATE INDEX IF NOT EXISTS idx_surveys_series ON surveys(series_id, series_order);
