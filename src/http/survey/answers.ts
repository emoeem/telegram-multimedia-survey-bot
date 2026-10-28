import type { Env } from "../../index";
import type { Answer, QuestionType, SurveyQuestion } from "../../db/schema";
import { getMediaAssetById } from "../../db/repositories/media.repository";
import { getTaskRunById, toTrialRun } from "../../db/repositories/task-run.repository";
import {
  clearAnswerStatements,
  mediaAnswerStatements,
  optionAnswerStatements,
  upsertAnswerValueStatement,
} from "../../db/repositories/response.repository";
import type { getSurveyFlow } from "../../services/question.service";
import { getFirstQuestion, getNextQuestionAfterAnswers } from "../../survey/engine";
import { getMatrixColumns } from "../../survey/question-presentation";
import { parseHotspotSceneFromJson } from "../../survey/hotspot";
import { isGameAnswerValue, numericAnswerValue, parseGameQuestionSettings } from "../../survey/game";
import { trialGrade } from "../../trial/engine";
import { fail } from "../api-response";

type FlowQuestion = Awaited<ReturnType<typeof getSurveyFlow>>["questions"][number];

/**
 * Hard ceiling for one text answer, regardless of question configuration.
 *
 * `validationJson.max_length` is the authoring-time limit and is enforced
 * first; this ceiling only exists so a question saved WITHOUT any validation
 * still cannot absorb an arbitrarily large string (D1 rows die past 1MB and
 * the free-tier row budget is shared platform-wide). Long enough for any
 * real answer — a long_text essay at this length is ~50k Chinese characters.
 */
const MAX_TEXT_ANSWER_CHARS = 100_000;

/** 场景答案 visited 数组的输入上限（配置护栏是 12 场景 × 24 热点 = 288）。 */
const HOTSPOT_VISITED_MAX = 288;

/**
 * Reads the question's configured text-length window, tolerating malformed
 * validation JSON (an authoring bug must not break answering).
 */
function textLengthWindow(question: FlowQuestion): { min: number; max: number } {
  let min = 0;
  let max = MAX_TEXT_ANSWER_CHARS;
  if (question.validationJson) {
    try {
      const parsed = JSON.parse(question.validationJson) as { min_length?: unknown; max_length?: unknown };
      if (typeof parsed.min_length === "number" && Number.isFinite(parsed.min_length) && parsed.min_length > 0) {
        min = Math.floor(parsed.min_length);
      }
      if (typeof parsed.max_length === "number" && Number.isFinite(parsed.max_length) && parsed.max_length > 0) {
        max = Math.min(Math.floor(parsed.max_length), MAX_TEXT_ANSWER_CHARS);
      }
    } catch {
      // Unparseable validation falls back to the absolute ceiling only.
    }
  }
  return { min, max };
}

/**
 * The writes one answer needs, or the error response that replaces them.
 *
 * Answers are *planned* rather than written here because the caller runs the
 * whole interaction as a single `db.batch()` — the answer's own statements
 * together with the response's current-question update. Each standalone
 * statement costs a round trip to the database's region (~90ms from the Hong
 * Kong edge), and "next question" is the interaction a respondent performs
 * once per question, so its write path must not cost five of them.
 */
export type AnswerWritePlan = { statements: D1PreparedStatement[] } | { error: Response };

/**
 * Plans the writes for one web answer, using the same upserts as the bot.
 *
 * `participantHash` only matters for game questions: the answer is a reference
 * to a task_runs row, so the run must belong to the same participant as the
 * response (and to the configured pack) before its score is accepted.
 */
export async function planWebAnswer(
  env: Env,
  responseId: number,
  question: FlowQuestion,
  value: unknown,
  participantHash?: string,
): Promise<AnswerWritePlan> {
  const type = question.type as QuestionType;
  // 剧情文段不收集答案；正常流程客户端不会为它发请求，这里兜底为成功，
  // 让"必答检查/续答重放"等路径不会因叙述节点而失败。
  if (type === "note") return { statements: [] };
  if (type === "single" || type === "yes_no" || type === "rating") {
    const optionId = Number(value);
    if (!Number.isInteger(optionId) || !question.options.some((option) => option.id === optionId)) {
      return { error: fail(400, "invalid_answer", "选项无效") };
    }
    return {
      statements: optionAnswerStatements(env.DB, {
        responseId,
        questionId: question.id,
        selectedOptionIds: [optionId],
        ...(type === "yes_no" ? { booleanValue: question.options[0]?.id === optionId } : {}),
        ...(type === "rating" ? { ratingValue: ratingOptionValue(question, optionId) } : {}),
      }),
    };
  }

  if (type === "multiple") {
    if (!Array.isArray(value) || value.some((entry) => !Number.isInteger(Number(entry)))) {
      return { error: fail(400, "invalid_answer", "多选答案必须是选项 ID 数组") };
    }
    const selectedOptionIds = value
      .map(Number)
      .filter((optionId) => question.options.some((option) => option.id === optionId));
    if (selectedOptionIds.length === 0) {
      return { statements: clearAnswerStatements(env.DB, responseId, question.id) };
    }
    return {
      statements: optionAnswerStatements(env.DB, {
        responseId,
        questionId: question.id,
        selectedOptionIds,
      }),
    };
  }

  if (type === "matrix") {
    const selections =
      value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const columns = getMatrixColumns(question);
    const normalized: Record<string, number> = {};
    for (const row of question.options) {
      const raw = selections[String(row.id)];
      if (raw === undefined || raw === null) continue;
      const columnIndex = Number(raw);
      if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= columns.length) {
        return { error: fail(400, "invalid_answer", `矩阵题 ${row.label} 的列无效`) };
      }
      normalized[String(row.id)] = columnIndex;
    }
    if (Object.keys(normalized).length === 0) {
      return { statements: clearAnswerStatements(env.DB, responseId, question.id) };
    }
    return {
      statements: [
        upsertAnswerValueStatement(env.DB, {
          responseId,
          questionId: question.id,
          values: { jsonValue: JSON.stringify({ kind: "matrix", selections: normalized }) },
        }),
      ],
    };
  }

  if (type === "scene") {
    // 场景答案 = 探索过的热点 id 列表，存成 matrix 同款的 kind-tagged JSON。
    // 形状错误（非数组/非字符串项）是客户端 bug，直接拒绝；已失效的热点 id
    // （内容更新后不再存在）则静默丢弃，旧答卷仍可无损重放。
    const config = parseHotspotSceneFromJson(question.settingsJson);
    if (!config) return { error: fail(400, "invalid_answer", "场景配置无效") };
    const visited =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as { visited?: unknown }).visited
        : undefined;
    if (!Array.isArray(visited) || visited.length > HOTSPOT_VISITED_MAX) {
      return { error: fail(400, "invalid_answer", "场景答案无效") };
    }
    const known = new Set(Object.values(config.scenes).flatMap((scene) => scene.hotspots.map((hotspot) => hotspot.id)));
    const normalized: string[] = [];
    for (const entry of visited) {
      // 非字符串项 = 客户端 bug，拒绝；未知 id / 重复探索 = 内容漂移，丢弃。
      if (typeof entry !== "string") {
        return { error: fail(400, "invalid_answer", "场景答案无效") };
      }
      if (known.has(entry) && !normalized.includes(entry)) normalized.push(entry);
    }
    if (normalized.length === 0) {
      return { statements: clearAnswerStatements(env.DB, responseId, question.id) };
    }
    return {
      statements: [
        upsertAnswerValueStatement(env.DB, {
          responseId,
          questionId: question.id,
          values: { jsonValue: JSON.stringify({ kind: "scene", visited: normalized }) },
        }),
      ],
    };
  }

  if (type === "text" || type === "long_text") {
    if (typeof value !== "string") return { error: fail(400, "invalid_answer", "文本答案必须是字符串") };
    const window = textLengthWindow(question);
    const length = Array.from(value).length;
    if (length > window.max) {
      return { error: fail(400, "answer_too_long", `文本答案最多 ${window.max} 字`) };
    }
    if (length < window.min) {
      return { error: fail(400, "answer_too_short", `文本答案至少 ${window.min} 字`) };
    }
    return {
      statements: [
        upsertAnswerValueStatement(env.DB, {
          responseId,
          questionId: question.id,
          values: { textValue: value },
        }),
      ],
    };
  }

  if (type === "number") {
    const numberValue = Number(value);
    if (typeof value !== "number" || !Number.isFinite(numberValue)) {
      return { error: fail(400, "invalid_answer", "数字答案必须是数字") };
    }
    return {
      statements: [
        upsertAnswerValueStatement(env.DB, {
          responseId,
          questionId: question.id,
          values: { numberValue },
        }),
      ],
    };
  }

  if (type === "date") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return { error: fail(400, "invalid_answer", "日期格式必须为 YYYY-MM-DD") };
    }
    return {
      statements: [
        upsertAnswerValueStatement(env.DB, {
          responseId,
          questionId: question.id,
          values: { dateValue: value },
        }),
      ],
    };
  }

  if (type === "time") {
    if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) {
      return { error: fail(400, "invalid_answer", "时间格式必须为 HH:MM") };
    }
    return {
      statements: [
        upsertAnswerValueStatement(env.DB, {
          responseId,
          questionId: question.id,
          values: { timeValue: value },
        }),
      ],
    };
  }

  if (type === "image" || type === "video" || type === "audio" || type === "file") {
    const mediaAssetId =
      value && typeof value === "object" && !Array.isArray(value)
        ? Number((value as { mediaAssetId?: unknown }).mediaAssetId)
        : Number(value);
    if (!Number.isInteger(mediaAssetId) || mediaAssetId <= 0) {
      return { error: fail(400, "invalid_answer", "媒体答案无效") };
    }
    const asset = await getMediaAssetById(env.DB, mediaAssetId);
    if (!asset || asset.scope !== "response") {
      return { error: fail(404, "media_not_found", "媒体不存在") };
    }
    // Ownership: response media is stored under "media:temp:<responseId>:…";
    // refuse assets uploaded for a different response so a participant cannot
    // attach (and thereby read) someone else's upload by enumerating ids.
    if (!asset.storageKey?.startsWith(`media:temp:${responseId}:`)) {
      return { error: fail(403, "media_forbidden", "媒体不属于当前答卷") };
    }
    return {
      statements: mediaAnswerStatements(env.DB, {
        responseId,
        questionId: question.id,
        mediaAssetId,
      }),
    };
  }

  if (type === "game") {
    // 小游戏答案 = 一条已结算的挑战局引用。客户端只交 runId；分数/评级/
    // 是否通关一律从 task_runs 记录推导，伪造的分数在这里被丢弃。
    const settings = parseGameQuestionSettings(question.settingsJson);
    if (!settings) return { error: fail(400, "invalid_answer", "小游戏题配置无效") };
    const runId =
      value && typeof value === "object" && !Array.isArray(value)
        ? Number((value as { runId?: unknown }).runId)
        : Number(value);
    if (!Number.isInteger(runId) || runId <= 0) {
      return { error: fail(400, "invalid_answer", "挑战记录无效") };
    }
    const run = await getTaskRunById(env.DB, runId);
    if (!run || run.packId !== settings.packId) {
      return { error: fail(400, "invalid_answer", "挑战记录无效") };
    }
    if (participantHash && run.participantHash !== participantHash) {
      return { error: fail(403, "forbidden", "挑战记录不属于当前答卷") };
    }
    if (run.status === "active") {
      return { error: fail(409, "run_not_finished", "这一局还没结束，先完成或放弃") };
    }
    const completed = run.status === "completed";
    // 插件局的评级由插件引擎在结算时写进信封；爬塔局实时算。
    const grade = completed ? (run.plugin?.grade ?? trialGrade(toTrialRun(run))) : null;
    return {
      statements: [
        upsertAnswerValueStatement(env.DB, {
          responseId,
          questionId: question.id,
          values: {
            jsonValue: JSON.stringify({
              kind: "game",
              runId,
              score: run.score,
              grade,
              completed,
            }),
          },
        }),
      ],
    };
  }

  return { error: fail(400, "unsupported_type", `不支持的题型：${type}`) };
}

function ratingOptionValue(question: FlowQuestion, optionId: number): number | null {
  const option = question.options.find((item) => item.id === optionId);
  const candidate = Number(option?.value ?? option?.label ?? optionId);
  return Number.isFinite(candidate) ? candidate : null;
}

/**
 * Walks the flow (honouring skip logic) and returns the first required
 * question that has no answer, or null when the response can be submitted.
 */
export function findMissingRequiredQuestion(
  flowQuestions: FlowQuestion[],
  answersByQuestion: Map<number, Answer>,
): SurveyQuestion | null {
  const visited = new Set<number>();
  // answerRules jump on accumulated answers, so the walker needs every
  // answered question's raw value (option id for single-type questions).
  const valueById = new Map<number, unknown>();
  const flowById = new Map(flowQuestions.map((question) => [question.id, question]));
  for (const [questionId, answer] of answersByQuestion) {
    const question = flowById.get(questionId);
    if (!question) continue;
    if (question.type === "game" && answer.jsonValue !== null) {
      // game 答案以数值投影进 flags/answerRules（通关得分 / 未通关 0）。
      try {
        valueById.set(questionId, JSON.parse(answer.jsonValue));
      } catch {
        // 脏数据视同未答。
      }
      continue;
    }
    valueById.set(questionId, selectedWebOptionId(question, answer));
  }
  let current = getFirstQuestion({ questions: flowQuestions });
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const answer = answersByQuestion.get(current.id);
    if (current.required && !isWebAnswerPresent(answer)) {
      return current;
    }
    const selectedOptionId = selectedWebOptionId(current, answer);
    current = getNextQuestionAfterAnswers({ questions: flowQuestions }, current.id, selectedOptionId, valueById);
  }
  return null;
}

export function isWebAnswerPresent(answer: Answer | undefined): boolean {
  if (!answer) return false;
  if (answer.jsonValue !== null) {
    try {
      const parsed = JSON.parse(answer.jsonValue) as unknown;
      if (Array.isArray(parsed)) return parsed.length > 0;
      if (parsed && typeof parsed === "object") {
        const kind = (parsed as { kind?: unknown }).kind;
        if (kind === "matrix") {
          const selections = (parsed as { selections?: Record<string, unknown> }).selections ?? {};
          return Object.keys(selections).length > 0;
        }
        if (kind === "scene") {
          const visited = (parsed as { visited?: unknown }).visited;
          return Array.isArray(visited) && visited.length > 0;
        }
        if (kind === "game") {
          // 必答的小游戏题以"通关"为作答门槛：弃坑/中断的局不算完成。
          return isGameAnswerValue(parsed) && parsed.completed === true;
        }
      }
    } catch {
      return true;
    }
    return true;
  }
  // A whitespace-only text answer counts as unanswered so required text
  // questions cannot be satisfied by an empty string.
  return (
    (answer.textValue !== null && answer.textValue.trim() !== "") ||
    answer.numberValue !== null ||
    answer.booleanValue !== null ||
    answer.ratingValue !== null ||
    answer.dateValue !== null ||
    answer.timeValue !== null
  );
}

function selectedWebOptionId(question: SurveyQuestion, answer: Answer | undefined): number | null {
  if (question.type !== "single" && question.type !== "yes_no" && question.type !== "rating") {
    return null;
  }
  if (!answer?.jsonValue) return null;
  try {
    const parsed = JSON.parse(answer.jsonValue) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const optionId = Number(parsed[0]);
      return Number.isInteger(optionId) && optionId > 0 ? optionId : null;
    }
  } catch {
    return null;
  }
  return null;
}
