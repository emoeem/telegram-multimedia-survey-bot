import type { Env } from "../../index";
import type { Answer, QuestionType, SurveyQuestion } from "../../db/schema";
import { getMediaAssetById } from "../../db/repositories/media.repository";
import {
  clearAnswerStatements,
  mediaAnswerStatements,
  optionAnswerStatements,
  upsertAnswerValueStatement,
} from "../../db/repositories/response.repository";
import type { getSurveyFlow } from "../../services/question.service";
import { getFirstQuestion, getNextQuestionAfterAnswers } from "../../survey/engine";
import { getMatrixColumns } from "../../survey/question-presentation";
import { fail } from "../api-response";

type FlowQuestion = Awaited<ReturnType<typeof getSurveyFlow>>["questions"][number];

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

/** Plans the writes for one web answer, using the same upserts as the bot. */
export async function planWebAnswer(
  env: Env,
  responseId: number,
  question: FlowQuestion,
  value: unknown,
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

  if (type === "text" || type === "long_text") {
    if (typeof value !== "string") return { error: fail(400, "invalid_answer", "文本答案必须是字符串") };
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
    if (question) valueById.set(questionId, selectedWebOptionId(question, answer));
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
      if (parsed && typeof parsed === "object" && (parsed as { kind?: unknown }).kind === "matrix") {
        const selections = (parsed as { selections?: Record<string, unknown> }).selections ?? {};
        return Object.keys(selections).length > 0;
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
