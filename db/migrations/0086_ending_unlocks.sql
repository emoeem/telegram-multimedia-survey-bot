-- 0086 · 单卷结局图鉴
--
-- 参与者×问卷×结局的一次性解锁记录：完成答卷时按结果引擎判定落一行
-- （INSERT OR IGNORE，UNIQUE 天然幂等）。多路线问卷（多 resultTypes）由此
-- 得到「已解锁 n/total」的复玩钩子。读侧按 0082 并集——绑定前的解锁也算。

CREATE TABLE IF NOT EXISTS ending_unlocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_hash TEXT NOT NULL,
  survey_id INTEGER NOT NULL,
  result_type TEXT NOT NULL,
  result_title TEXT,
  unlocked_at TEXT NOT NULL,
  UNIQUE (participant_hash, survey_id, result_type)
);
CREATE INDEX IF NOT EXISTS idx_ending_unlocks_survey ON ending_unlocks(survey_id, participant_hash);
