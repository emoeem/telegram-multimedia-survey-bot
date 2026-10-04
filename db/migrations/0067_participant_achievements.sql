-- 成就 / 徽章（Achievements）
--
-- Unlocks are recorded per participant identity, exactly like every other
-- per-user record on the platform (survey_responses.participant_hash): the
-- anonymous / email / Telegram identities each keep their own set, and the
-- catalog itself lives in code (src/services/achievement.service.ts) so a new
-- badge never needs a schema change.
--
-- seen = 0 powers the "new" dot in 「我的」: unlocking is written as a side
-- effect of submitting a survey / finishing a challenge, and the next visit to
-- /me marks them seen.
CREATE TABLE IF NOT EXISTS participant_achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_hash TEXT NOT NULL,
  code TEXT NOT NULL,
  unlocked_at TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  UNIQUE (participant_hash, code)
);

CREATE INDEX IF NOT EXISTS idx_participant_achievements_hash
  ON participant_achievements(participant_hash, unlocked_at DESC);
