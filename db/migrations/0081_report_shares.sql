-- 0081 · 报告分享卡
--
-- 参与者主动、逐份、可撤销的报告分享。与 30 天过期的私有报告 token
-- （report-access-token.service，无状态 HMAC）语义相反：分享链接是持久
-- 内容，因此用 DB 随机 token（可撤销、可审计），不用无状态签名。
--
-- 安全边界：公开页只渲染白名单投影（结局名/卷名/tags/封面），任何答案
-- 原文、长文本与 stats 数值都不出口——见 src/http/share-api.ts 的
-- buildShareCardViewModel。r18 问卷的分享卡只有 teaser 形态。
--
-- result_type/result_title/survey_title/content_rating 是创建时刻的冗余
-- 快照：结果规则后续被作者改掉时，已分享出去的卡片语义不漂移。

CREATE TABLE IF NOT EXISTS report_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  response_id INTEGER NOT NULL UNIQUE REFERENCES survey_responses(id) ON DELETE CASCADE,
  participant_hash TEXT NOT NULL,
  survey_id INTEGER NOT NULL,
  result_type TEXT,
  result_title TEXT,
  survey_title TEXT,
  content_rating TEXT NOT NULL DEFAULT 'all',
  view_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_shares_participant ON report_shares(participant_hash);
