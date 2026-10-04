import type { Env } from "../../index";
import type { Answer, QuestionType, SurveyQuestion } from "../../db/schema";
import {
  createAnswerMedia,
  getMediaAssetById,
} from "../../db/repositories/media.repository";
import {
  upsertDateAnswer,
  upsertJsonAnswer,
  upsertMediaAnswer,
  upsertNumberAnswer,
  upsertOptionAnswer,
  upsertTextAnswer,
  upsertTimeAnswer,
} from "../../db/repositories/response.repository";
import { getSurveyFlow } from "../../services/question.service";
import { getFirstQuestion, getNextQuestionAfterOption } from "../../survey/engine";
import { getMatrixColumns } from "../../survey/question-presentation";
import { fail } from "../api-response";

type FlowQuestion = Awaited<ReturnType<typeof getSurveyFlow>>["questions"][number];

/** Persists one web answer exactly as the bot handlers do (same upserts). */
export async function saveWebAnswer(
  env: Env,
  responseId: number,
  question: FlowQuestion,
  value: unknown,
): Promise<Response | null> {
  const type = question.type as QuestionType;
  if (type === "single" || type === "yes_no" || type === "rating") {
    const optionId = Number(value);
    if (!Number.isInteger(optionId) || !question.options.some((option) => option.id === optionId)) {
      return fail(400, "invalid_answer", "选项无效");
    }
    await upsertOptionAnswer(env.DB, {
      responseId,
      questionId: question.id,
      selectedOptionIds: [optionId],
      ...(type === "yes_no" ? { booleanValue: question.options[0]?.id === optionId } : {}),
      ...(type === "rating" ? { ratingValue: ratingOptionValue(question, optionId) } : {}),
    });
    return null;
  }

  if (type === "multiple") {
    if (!Array.isArray(value) || value.some((entry) => !Number.isInteger(Number(entry)))) {
      return fail(400, "invalid_answer", "多选答案必须是选项 ID 数组");
    }
    const selectedOptionIds = value
      .map(Number)
      .filter((optionId) => question.options.some((option) => option.id === optionId));
    if (selectedOptionIds.length === 0) {
      await deleteWebAnswer(env.DB, responseId, question.id);
    } else {
      await upsertOptionAnswer(env.DB, {
        responseId,
        questionId: question.id,
        selectedOptionIds,
      });
    }
    return null;
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
        return fail(400, "invalid_answer", `矩阵题 ${row.label} 的列无效`);
      }
      normalized[String(row.id)] = columnIndex;
    }
    if (Object.keys(normalized).length === 0) {
      await deleteWebAnswer(env.DB, responseId, question.id);
    } else {
      await upsertJsonAnswer(env.DB, {
        responseId,
        questionId: question.id,
        jsonValue: JSON.stringify({ kind: "matrix", selections: normalized }),
      });
    }
    return null;
  }

  if (type === "text" || type === "long_text") {
    if (typeof value !== "string") return fail(400, "invalid_answer", "文本答案必须是字符串");
    await upsertTextAnswer(env.DB, { responseId, questionId: question.id, textValue: value });
    return null;
  }

  if (type === "number") {
    const numberValue = Number(value);
    if (typeof value !== "number" || !Number.isFinite(numberValue)) {
      return fail(400, "invalid_answer", "数字答案必须是数字");
    }
    await upsertNumberAnswer(env.DB, { responseId, questionId: question.id, numberValue });
    return null;
  }

  if (type === "date") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return fail(400, "invalid_answer", "日期格式必须为 YYYY-MM-DD");
    }
    await upsertDateAnswer(env.DB, { responseId, questionId: question.id, dateValue: value });
    return null;
  }

  if (type === "time") {
    if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) {
      return fail(400, "invalid_answer", "时间格式必须为 HH:MM");
    }
    await upsertTimeAnswer(env.DB, { responseId, questionId: question.id, timeValue: value });
    return null;
  }

  if (type === "image" || type === "video" || type === "audio" || type === "file") {
    const mediaAssetId =
      value && typeof value === "object" && !Array.isArray(value)
        ? Number((value as { mediaAssetId?: unknown }).mediaAssetId)
        : Number(value);
    if (!Number.isInteger(mediaAssetId) || mediaAssetId <= 0) {
      return fail(400, "invalid_answer", "媒体答案无效");
    }
    const asset = await getMediaAssetById(env.DB, mediaAssetId);
    if (!asset || asset.scope !== "response") {
      return fail(404, "media_not_found", "媒体不存在");
    }
    // Ownership: response media is stored under "media:temp:<responseId>:…";
    // refuse assets uploaded for a different response so a participant cannot
    // attach (and thereby read) someone else's upload by enumerating ids.
    if (!asset.storageKey?.startsWith(`media:temp:${responseId}:`)) {
      return fail(403, "media_forbidden", "媒体不属于当前答卷");
    }
    const answerId = await upsertMediaAnswer(env.DB, {
      responseId,
      questionId: question.id,
      mediaAssetId,
    });
    await createAnswerMedia(env.DB, { answerId, mediaAssetId });
    return null;
  }

  return fail(400, "unsupported_type", `不支持的题型：${type}`);
}

function ratingOptionValue(question: FlowQuestion, optionId: number): number | null {
  const option = question.options.find((item) => item.id === optionId);
  const candidate = Number(option?.value ?? option?.label ?? optionId);
  return Number.isFinite(candidate) ? candidate : null;
}

export async function deleteWebAnswer(db: D1Database, responseId: number, questionId: number): Promise<void> {
  const answer = await db
    .prepare("SELECT id FROM answers WHERE response_id = ? AND question_id = ? LIMIT 1")
    .bind(responseId, questionId)
    .first<{ id: number }>();
  if (!answer) return;
  await db.batch([
    db.prepare("DELETE FROM answer_media WHERE answer_id = ?").bind(answer.id),
    db.prepare("DELETE FROM answer_options WHERE answer_id = ?").bind(answer.id),
    db.prepare("DELETE FROM answers WHERE id = ?").bind(answer.id),
  ]);
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
  let current = getFirstQuestion({ questions: flowQuestions });
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const answer = answersByQuestion.get(current.id);
    if (current.required && !isWebAnswerPresent(answer)) {
      return current;
    }
    const selectedOptionId = selectedWebOptionId(current, answer);
    current = getNextQuestionAfterOption({ questions: flowQuestions }, current.id, selectedOptionId);
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
