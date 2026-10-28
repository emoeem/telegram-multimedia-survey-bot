-- 素材库：媒体内容寻址去重 + 弱引用登记。
-- 1) content_hash：上传字节 SHA-256（十六进制）。同一份素材跨问卷复用只存
--    一份 blob（media:blob:<hash>），多个 asset 行可以指向同一对象；索引
--    不加 UNIQUE——并发上传可能各插一行，读侧命中即复用，清扫兜底。
-- 2) media_refs：结构化弱引用登记（BGM、场景图这类"藏在 JSON 里的
--    /api/survey/media/<id> URL"）。ref_key 形如 "survey:123"，一条记录
--    表示"这个键当前引用这个 asset"，由每日维护任务自动同步。
ALTER TABLE media_assets ADD COLUMN content_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_media_assets_content_hash ON media_assets(content_hash) WHERE content_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS media_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  ref_type TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(ref_type, ref_key)
);
CREATE INDEX IF NOT EXISTS idx_media_refs_asset ON media_refs(asset_id);
