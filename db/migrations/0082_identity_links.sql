-- 0082 · 身份统一：participant_hash 映射
--
-- 三套身份（telegram `user_{id}` / email `email_{id}` / 匿名浏览器 `web_{key}`）
-- 各有独立 participant_hash，历史数据按原 hash 存储。统一采用「映射 + 读侧并集」
-- 而不是数据搬迁：
--   * canonical 永远指向人：TG 身份是 `user_{id}`；邮箱账户若已绑定 user 也是
--     `user_{id}`，未绑定时是 `email_{id}`；匿名 key 是 source，永远不做 canonical。
--   * 写侧归一：resolveParticipant 解析出的 hash 经 canonicalizeHash 映射后返回，
--     新答卷/新流水全部落 canonical。
--   * 读侧并集：查询"我的 X"时用 hashesFor(canonical) = canonical + 全部 source，
--     历史行原地不动即可见。UNIQUE(participant_hash, day) 这类约束在并集查询下
--     天然保持"每人一行"语义。
--   * 解绑 = 删映射行，数据无损回到各自视图。
--   * 金币是唯一被搬运的数据：合并走一笔幂等 merge 交易（见 identity-link.service），
--     幂等键 `merge:{source_hash}` 保证同一 source 只被吸收一次——反复绑定/解绑
--     不能刷币。
--
-- 排行榜（task_runs 的 top20）刻意保持按身份展示，不参与并集——与既有语义一致。

CREATE TABLE IF NOT EXISTS participant_hash_links (
  source_hash TEXT PRIMARY KEY,
  canonical_hash TEXT NOT NULL,
  method TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phl_canonical ON participant_hash_links(canonical_hash);
