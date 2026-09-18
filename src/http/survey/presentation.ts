import type { Answer, SurveyQuestion } from "../../db/schema";

/** Public URL for a media asset; keeps the survey list payload tiny. */
export function mediaPublicUrl(mediaId: number): string {
  return `/api/survey/media/${mediaId}`;
}

export function parseValidation(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseSettings(value: string | null): Record<string, unknown> | null {
  return parseValidation(value);
}

/** Projects a stored question into the shape the web player consumes. */
export function questionView(
  question: SurveyQuestion,
  options: Array<{ id: number; label: string; media: Array<{ mediaAssetId: number }> }>,
  questionMedia: Array<{ mediaAssetId: number }>,
): Record<string, unknown> {
  return {
    id: question.id,
    type: question.type,
    title: question.title,
    ...(question.description ? { description: question.description } : {}),
    required: question.required,
    order: question.order,
    pageId: question.pageId,
    validation: parseValidation(question.validationJson),
    settings: parseSettings(question.settingsJson),
    condition: parseValidation(question.conditionJson),
    skipToQuestionId: question.skipToQuestionId,
    media: questionMedia.map((entry) => ({ url: mediaPublicUrl(entry.mediaAssetId) })),
    options: options.map((option) => ({
      id: option.id,
      label: option.label,
      media: option.media.map((entry) => ({ url: mediaPublicUrl(entry.mediaAssetId) })),
    })),
  };
}

/** Projects a stored answer into the compact value the player resumes from. */
export function answerValue(answer: Answer): unknown {
  if (answer.jsonValue !== null) {
    try {
      const parsed = JSON.parse(answer.jsonValue) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as { kind?: unknown }).kind === "matrix"
      ) {
        return (parsed as { selections?: unknown }).selections ?? null;
      }
      if (Array.isArray(parsed)) return parsed;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { mediaAssetId?: unknown }).mediaAssetId === "number"
      ) {
        return { mediaAssetId: (parsed as { mediaAssetId: number }).mediaAssetId };
      }
    } catch {
      // fall through to typed columns
    }
  }
  if (answer.textValue !== null) return answer.textValue;
  if (answer.numberValue !== null) return answer.numberValue;
  if (answer.booleanValue !== null) return answer.booleanValue;
  if (answer.ratingValue !== null) return answer.ratingValue;
  if (answer.dateValue !== null) return answer.dateValue;
  if (answer.timeValue !== null) return answer.timeValue;
  return null;
}
