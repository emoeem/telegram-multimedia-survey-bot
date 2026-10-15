-- 插画需要有意义的替代文本（无障碍朗读 + 图片加载失败时的语义提示）。
-- 此前 media_assets 没有任何字段可以存放，前端只能渲染 alt=""，
-- 于是 "为每个场景提供 alt 文本" 这条要求无法落地。
ALTER TABLE media_assets ADD COLUMN alt_text TEXT;
