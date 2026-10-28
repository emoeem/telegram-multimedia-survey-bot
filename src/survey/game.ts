/**
 * 小游戏题（type="game"）的共享语义：配置解析 + 答案的数值投影。
 *
 * 配置：settings_json.game = { packId }（指向 task_packs 一行）。
 * 答案：json_value = { kind:"game", runId, score, grade, completed }——
 * 分数/评级一律由服务端从 task_runs 记录推导，客户端只交 runId。
 *
 * 引擎侧（flag/answerRules 数值比较）把 game 答案投影成一个数：
 * 已通关且得分 > 0 → 得分本身；玩过但没通关 → 0；未答 → 视同缺失。
 * 这让既有的 flagRules/answerRules 数值语义对 game 题直接可用。
 */

export interface SurveyGameQuestionSettings {
  packId: number;
  /** 玩法类型快照（tower / 插件 id）。服务端以 task_packs.game_type 为准，
   *  这里只服务答题端"选哪个渲染器"，缺失时按 tower 处理。 */
  gameType?: string;
}

export interface SurveyGameAnswer {
  kind: "game";
  runId: number;
  score: number;
  /** 结算评级（S/A/B/C），未通关为 null。 */
  grade: string | null;
  completed: boolean;
}

/** 解析 settings_json 里的 game 配置；缺失/脏数据返回 null（视为配置未完成）。 */
export function parseGameQuestionSettings(raw: unknown): SurveyGameQuestionSettings | null {
  if (!raw) return null;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const game = (parsed as Record<string, unknown>).game;
  if (!game || typeof game !== "object" || Array.isArray(game)) return null;
  const gameRaw = game as Record<string, unknown>;
  const packId = Number(gameRaw.packId);
  if (!Number.isInteger(packId) || packId <= 0) return null;
  const gameType = typeof gameRaw.gameType === "string" && gameRaw.gameType ? gameRaw.gameType : undefined;
  return { packId, ...(gameType ? { gameType } : {}) };
}

/** 判断一个答案值是不是 game 答案对象（形状正确即可，数值在读取处校验）。 */
export function isGameAnswerValue(value: unknown): value is SurveyGameAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "game") return false;
  return Number.isInteger(Number(raw.runId)) && Number(raw.runId) > 0;
}

/**
 * game 答案的数值投影，供 flag/跳转比较：
 * 通关且得分 > 0 → score；有答案但没通关 → 0；其余（含非 game 值）→ null。
 */
export function gameAnswerScore(value: unknown): number | null {
  if (!isGameAnswerValue(value)) return null;
  const completed = (value as { completed?: unknown }).completed === true;
  const score = Number((value as { score?: unknown }).score);
  if (!completed) return 0;
  return Number.isFinite(score) && score > 0 ? score : 0;
}

/**
 * 通用答案数值投影（flagRules/answerRules 的比较口径，服务端与前端同构）：
 * game 答案按 gameAnswerScore 投影；其它类型保持原 Number() 行为
 * （选项 id / 数字答案直接比较，无法数值化的值得到 NaN → 不命中）。
 */
export function numericAnswerValue(value: unknown): number {
  const gameScore = gameAnswerScore(value);
  if (gameScore !== null) return gameScore;
  return Number(value);
}
