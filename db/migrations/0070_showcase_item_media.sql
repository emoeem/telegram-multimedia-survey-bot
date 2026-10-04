-- 展示区作品的内容文件（图片 / 音频 / 视频）
--
-- 作品原本只有 cover_media_id（卡片缩略图）和一个外链，图片只能看到 56px 的缩略
-- 图，音频根本没有类型。这里加一个"内容文件"引用，前台点开就是看图/听音频/放视频。
--
-- 纯 ADD COLUMN + CREATE INDEX（0068 的教训：D1 一个迁移文件是一次原子批处理、事务
-- 内关不掉外键，所以绝不能重建被外键引用的表）。
ALTER TABLE showcase_items ADD COLUMN media_asset_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_showcase_items_media_asset ON showcase_items(media_asset_id);
