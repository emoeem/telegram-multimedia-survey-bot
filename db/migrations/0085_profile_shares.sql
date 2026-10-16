-- 0085 · 个人画像分享（Wrapped）
--
-- 参与者把跨问卷的累计数据（完成卷数、成就、结局收藏、挑战战绩）生成一张
-- 可分享的公开画像页 /u/:token。快照在创建/刷新时刻定格——公开路径零重查询，
-- 数据过期了重新生成即可。归属按 participant_hash（0082 canonical），
-- 换设备/换身份（认领）后重新生成就是最新视角。

CREATE TABLE IF NOT EXISTS profile_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  participant_hash TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_shares_hash ON profile_shares(participant_hash);
