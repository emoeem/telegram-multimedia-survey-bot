-- 画廊答卷 → 展示页（showcase_persons.response_id 正式接通）
--
-- 参与者在「我的」里把自己已发布的资料卡生成一个展示页草稿，管理员在后台
-- 展示区审核后公开。response_id / owner_user_id 是 0065 预留的软连接字段，
-- 这里加唯一索引：一个人对一份答卷最多只有一条展示页，重复点击是更新而不是
-- 再插一条（服务层还会先查一次，索引只是最后的硬保证）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_showcase_persons_response
  ON showcase_persons(response_id)
  WHERE response_id IS NOT NULL;
