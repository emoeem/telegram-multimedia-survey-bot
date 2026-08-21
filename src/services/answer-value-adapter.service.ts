import type { Answer, QuestionType } from "../db/schema";
import type { ResultJsonValue } from "../result/schema";

/** A single answer shape consumed by the Result Engine, independent of how a
 * Telegram question happened to persist its value. */
export interface NormalizedAnswerValue {
  questionId: number;
  type: QuestionType | "custom";
  value: ResultJsonValue;
  media: Array<{ mediaAssetId: number }>;
}

function parsedJson(answer: Answer): ResultJsonValue | null {
  if (answer.jsonValue === null) return null;
  try { return JSON.parse(answer.jsonValue) as ResultJsonValue; } catch { return answer.jsonValue; }
}

function mediaFrom(value: ResultJsonValue): Array<{ mediaAssetId: number }> {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const assetId = entry.mediaAssetId;
    return typeof assetId === "number" && Number.isSafeInteger(assetId) && assetId > 0 ? [{ mediaAssetId: assetId }] : [];
  });
}

export function normalizeAnswer(
  answer: Answer,
  questionType: QuestionType | "custom" = "custom",
): NormalizedAnswerValue {
  const json = parsedJson(answer);
  const value: ResultJsonValue = answer.textValue ?? answer.numberValue ?? answer.booleanValue ??
    answer.ratingValue ?? answer.dateValue ?? answer.timeValue ?? json ?? null;
  return { questionId: answer.questionId, type: questionType, value, media: mediaFrom(value) };
}
