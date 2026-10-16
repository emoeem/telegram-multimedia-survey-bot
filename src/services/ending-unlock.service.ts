import { nowIso } from "../db/client";
import { HASH_SET_SQL } from "./identity-link.service";
import { prepareResultProfileForResponse } from "./result-visual.service";
import { getSurveyResultRuleSet } from "../db/repositories/result-profile.repository";

/**
 * 单卷结局图鉴（0086）：完成答卷 → 结果引擎判定 → 解锁行落库。
 *
 * 多路线问卷（规则集里定义多个 resultTypes）由此获得「已解锁 n/total」的
 * 复玩钩子。解锁行只存 resultType + 标题快照——结局的判定文案留在规则里，
 * 图鉴展示不需要重算。
 */

export interface EndingUnlockRow {
  resultType: string;
  title: string | null;
  unlockedAt: string;
}

/** 完成答卷时判定并落解锁行。规则集不存在 → null（问卷没有结局定义）。 */
export async function recordEndingUnlock(
  db: D1Database,
  input: { participantHash: string; surveyId: number; responseId: number },
): Promise<{ resultType: string; title: string | null } | null> {
  const prepared = await prepareResultProfileForResponse(db, input.responseId).catch(() => null);
  if (!prepared) return null;
  const resultType = prepared.profile.resultType;
  const title = prepared.profile.title;
  await db
    .prepare(
      `INSERT INTO ending_unlocks (participant_hash, survey_id, result_type, result_title, unlocked_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(participant_hash, survey_id, result_type) DO NOTHING`,
    )
    .bind(input.participantHash, input.surveyId, resultType, title, nowIso())
    .run();
  return { resultType, title };
}

/** 该参与者在某卷上已解锁的结局（并集读取）。 */
export async function listUnlockedEndings(db: D1Database, participantHash: string, surveyId: number): Promise<EndingUnlockRow[]> {
  const rows = await db
    .prepare(
      `SELECT result_type AS resultType, result_title AS title, unlocked_at AS unlockedAt
       FROM ending_unlocks
       WHERE participant_hash ${HASH_SET_SQL} AND survey_id = ?
       ORDER BY unlocked_at ASC`,
    )
    .bind(participantHash, participantHash, surveyId)
    .all<EndingUnlockRow>();
  return rows.results ?? [];
}

/** 图鉴总数：规则集里定义的 resultTypes 数。没有规则集 = 没有图鉴。 */
export async function endingTotal(db: D1Database, surveyId: number): Promise<number | null> {
  const ruleSet = await getSurveyResultRuleSet(db, surveyId);
  if (!ruleSet) return null;
  try {
    const parsed = JSON.parse(ruleSet.rulesJson) as { resultTypes?: unknown };
    if (!Array.isArray(parsed.resultTypes)) return null;
    return parsed.resultTypes.length > 0 ? parsed.resultTypes.length : null;
  } catch {
    return null;
  }
}
