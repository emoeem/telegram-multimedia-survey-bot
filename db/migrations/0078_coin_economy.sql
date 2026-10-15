-- 0078 · 金币经济：账户/流水/签到/挑战/问卷解锁/报告抽卡/投稿
--
-- 设计要点：
-- 1. 身份沿用平台既有语义：一切按 participant_hash 归属（匿名/邮箱/Telegram
--    三种身份各自独立，与成就、挑战 task_runs 一致），Telegram 用户额外记录
--    user_id 便于管理端按用户查找。金币不要求用户重复注册。
-- 2. 账本权威：coin_transactions 是唯一事实来源；余额只是 coin_accounts 上的
--    缓存，任何变动都随一条流水在同一 D1 batch（隐式事务）内发生。幂等靠
--    idempotency_key 上的唯一约束：同一业务重复提交会撞唯一键、整批回滚。
-- 3. 默认免费：survey_coin_access 缺行 = 免费问卷；只有作者显式启用金币解锁
--    的问卷才有定价。密码问卷的密码流程不受影响（金币解锁不绕过密码）。
-- 4. 抽卡公平性：gacha_pool_versions 保存每次配置变更的完整快照，每次抽取
--    记录所用版本与消耗，事后可审计"当时概率是什么"。
-- 5. 投稿隐私：授权信息存 authorization_json（明示勾选，非默认），撤回/下架
--    只改状态；已被抽走的内容按授权约定保留必要的审计记录。

-- 金币账户：余额缓存 + 累计值。CHECK 保证余额不为负。
CREATE TABLE IF NOT EXISTS coin_accounts (
  participant_hash TEXT PRIMARY KEY,
  user_id INTEGER,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  total_earned INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coin_accounts_user ON coin_accounts(user_id) WHERE user_id IS NOT NULL;

-- 金币流水：amount 正=收入 负=支出；balance_after 可重建任意时刻余额。
CREATE TABLE IF NOT EXISTS coin_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_hash TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  note TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coin_txn_hash ON coin_transactions(participant_hash, id DESC);
CREATE INDEX IF NOT EXISTS idx_coin_txn_kind_ref ON coin_transactions(kind, ref_id);

-- 每日签到：UNIQUE(participant_hash, day) 直接挡掉重复签到。
CREATE TABLE IF NOT EXISTS coin_checkins (
  participant_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  streak INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (participant_hash, day)
);

-- 挑战定义（管理员可增删改）：goal_type 由服务端用真实业务记录计算进度。
CREATE TABLE IF NOT EXISTS coin_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '🎯',
  goal_type TEXT NOT NULL,
  goal_target INTEGER NOT NULL,
  reward INTEGER NOT NULL,
  period TEXT NOT NULL DEFAULT 'once',
  start_at TEXT,
  end_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 挑战领取：UNIQUE(challenge, 参与者, 周期键) 防重复领取。
CREATE TABLE IF NOT EXISTS coin_challenge_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id INTEGER NOT NULL REFERENCES coin_challenges(id),
  participant_hash TEXT NOT NULL,
  period_key TEXT NOT NULL,
  progress INTEGER NOT NULL,
  reward INTEGER NOT NULL,
  transaction_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (challenge_id, participant_hash, period_key)
);

-- 问卷金币解锁配置：缺行 = 免费问卷（默认不变）。
CREATE TABLE IF NOT EXISTS survey_coin_access (
  survey_id INTEGER PRIMARY KEY REFERENCES surveys(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  base_price INTEGER NOT NULL DEFAULT 0,
  auto_price INTEGER NOT NULL DEFAULT 1,
  fixed_price INTEGER,
  price_cached INTEGER,
  price_computed_at TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- 解锁记录：UNIQUE(survey, participant) 保证重复购买幂等、涨价不重复收费。
CREATE TABLE IF NOT EXISTS survey_unlocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL,
  participant_hash TEXT NOT NULL,
  price_paid INTEGER NOT NULL,
  transaction_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (survey_id, participant_hash)
);
CREATE INDEX IF NOT EXISTS idx_survey_unlocks_hash ON survey_unlocks(participant_hash, id DESC);

-- 抽卡奖池与内容。
CREATE TABLE IF NOT EXISTS gacha_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cost_single INTEGER NOT NULL,
  cost_multi INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',
  start_at TEXT,
  end_at TEXT,
  pity_at INTEGER,
  default_access TEXT NOT NULL DEFAULT 'permanent',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gacha_pool_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id INTEGER NOT NULL REFERENCES gacha_pools(id) ON DELETE CASCADE,
  submission_id INTEGER,
  owner_participant_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL,
  rarity TEXT NOT NULL DEFAULT 'N',
  weight INTEGER NOT NULL DEFAULT 10,
  stock INTEGER,
  remaining INTEGER,
  preview_media_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gacha_items_pool ON gacha_pool_items(pool_id, active);

-- 每次奖池变更的完整快照（条目/权重/稀有度/保底），抽取记录版本号。
CREATE TABLE IF NOT EXISTS gacha_pool_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id INTEGER NOT NULL REFERENCES gacha_pools(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'system',
  UNIQUE (pool_id, version)
);

-- 抽取记录即收藏（access 决定查看权限）；UNIQUE 幂等键挡重复抽取。
CREATE TABLE IF NOT EXISTS gacha_pulls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id INTEGER NOT NULL,
  pool_version INTEGER NOT NULL,
  participant_hash TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  transaction_id INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  batch_id TEXT,
  access_type TEXT NOT NULL DEFAULT 'permanent',
  rarity TEXT NOT NULL DEFAULT 'N',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gacha_pulls_hash ON gacha_pulls(participant_hash, id DESC);
CREATE INDEX IF NOT EXISTS idx_gacha_pulls_pool ON gacha_pulls(pool_id, participant_hash, id DESC);

-- 投稿：状态机 pending → approved → in_pool（或 rejected/changes_requested/
-- withdrawn/removed）。去重靠部分唯一索引（同一参与者同一内容只允许一条
-- 活跃投稿）。授权明细存 authorization_json。
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_hash TEXT NOT NULL,
  user_id INTEGER,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  content_text TEXT,
  media_asset_id INTEGER,
  survey_id INTEGER,
  response_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  content_hash TEXT NOT NULL,
  authorization_json TEXT NOT NULL DEFAULT '{}',
  quality_tier INTEGER,
  reward_amount INTEGER,
  reward_transaction_id INTEGER,
  reviewer_id TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_dedup
  ON submissions(participant_hash, content_hash)
  WHERE status NOT IN ('withdrawn', 'removed', 'rejected');
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_hash ON submissions(participant_hash, id DESC);

-- 运营配置：键值 JSON，管理端可改。初始种子值由服务层 DEFAULTS 兜底，
-- 表里只存显式覆盖项。
CREATE TABLE IF NOT EXISTS coin_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TEXT NOT NULL
);
