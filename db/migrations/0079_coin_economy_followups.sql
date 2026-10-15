-- 0079 · 金币经济补全：投稿缩略图与音频时长
--
-- 缩略图由客户端在上传时生成（Workers 免费额度没有图像解码管线），与原图
-- 一样走 media_assets/KV 随机键；列表与奖池预览一律用缩略图，避免原始大图
-- 进列表页。duration 为客户端探测的秒数——服务端没有音频解码能力，只能作
-- 展示与软限制用途（硬限制是字节大小 + 魔数校验，见 submission.service）。

ALTER TABLE submissions ADD COLUMN thumb_media_asset_id INTEGER;
ALTER TABLE submissions ADD COLUMN media_duration_seconds INTEGER;
