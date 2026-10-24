import type { SurveyCondition, SurveyMedia, SurveyOption, SurveyQuestion, UnifiedSurveyImport } from "../schema";
import { surveyOptionId, surveyQuestionId } from "../id-mapping";
import type { ImportedMedia, ImportedSurvey } from "../../services/import.service";

function normalizeMedia(media: ImportedMedia, fallbackId: string): SurveyMedia {
  return {
    id: media.id ?? fallbackId,
    type: media.type,
    source: media.source ?? (media.telegramFileId ? "telegram" : media.storageKey ? "r2" : "url"),
    ...(media.telegramFileId ? { telegram_file_id: media.telegramFileId } : {}),
    ...(media.telegramFileUniqueId ? { telegram_file_unique_id: media.telegramFileUniqueId } : {}),
    ...(media.url ? { url: media.url } : {}),
    ...(media.storageKey ? { storage_key: media.storageKey } : {}),
    ...(media.mimeType ? { mime_type: media.mimeType } : {}),
    ...(media.fileName ? { file_name: media.fileName } : {}),
    ...(media.caption ? { caption: media.caption } : {}),
    ...(media.width !== undefined ? { width: media.width } : {}),
    ...(media.height !== undefined ? { height: media.height } : {}),
    ...(media.duration !== undefined ? { duration: media.duration } : {}),
    ...(media.size !== undefined ? { size: media.size } : {}),
  };
}

/**
 * Rewrites a source-format condition into the generated unified id space
 * (q1 / q1_o1) so validateUnifiedSurvey can check it. This is a pure id-space
 * remap: entries with unknown question targets or backward jumps are kept as
 * they are so the validator rejects them with a precise path — the Forms
 * importer filters those at the source, so only hand-authored JSON hits this.
 * Unknown option ids are also kept (same reasoning); saveImportedSurvey's
 * remap skips anything unresolvable as a final safety net.
 */
function mapCondition(
  condition: Record<string, unknown>,
  questionIndexBySource: Map<string, number>,
  optionIdBySource: Map<string, string>,
  generatedIdOfIndex: (index: number) => string,
): SurveyCondition {
  const mappedQuestion = (sourceId: unknown): string =>
    generatedIdOfIndex(questionIndexBySource.get(String(sourceId)) ?? -1);
  const mappedOption = (sourceId: unknown): string => optionIdBySource.get(String(sourceId)) ?? String(sourceId);

  const result: SurveyCondition = { kind: "option_equals" };
  const rules: Array<{ optionId: string; targetQuestionId: string }> = [];
  for (const rule of Array.isArray(condition.rules) ? condition.rules : []) {
    if (!rule || typeof rule !== "object") continue;
    const entry = rule as Record<string, unknown>;
    rules.push({
      optionId: mappedOption(entry.optionId),
      targetQuestionId: mappedQuestion(entry.targetQuestionId),
    });
  }
  const answerRules: Array<{ questionId: string; equals: number | string; targetQuestionId: string }> = [];
  for (const rule of Array.isArray(condition.answerRules) ? condition.answerRules : []) {
    if (!rule || typeof rule !== "object") continue;
    const entry = rule as Record<string, unknown>;
    answerRules.push({
      questionId: mappedQuestion(entry.questionId),
      equals: typeof entry.equals === "number" ? entry.equals : mappedOption(entry.equals),
      targetQuestionId: mappedQuestion(entry.targetQuestionId),
    });
  }
  if (rules.length) result.rules = rules;
  if (answerRules.length) result.answerRules = answerRules;

  if (condition.optionId !== undefined || condition.targetQuestionId !== undefined) {
    result.optionId = mappedOption(condition.optionId);
    result.targetQuestionId = mappedQuestion(condition.targetQuestionId);
  }
  if (condition.skipToQuestionId !== undefined && condition.skipToQuestionId !== null) {
    result.skipToQuestionId = mappedQuestion(condition.skipToQuestionId);
  }
  return result;
}

function normalizeQuestion(
  question: ImportedSurvey["questions"][number],
  index: number,
  questionIndexBySource: Map<string, number>,
  optionIdBySource: Map<string, string>,
): SurveyQuestion {
  const options: SurveyOption[] = (question.options ?? []).map((option, optionIndex) => ({
    id: surveyOptionId(index, optionIndex),
    label: option.label,
    value: option.value,
    order: optionIndex + 1,
    ...(option.media.length > 0
      ? {
          media: option.media.map((media, mediaIndex) =>
            normalizeMedia(media, `q${index + 1}_o${optionIndex + 1}_media${mediaIndex + 1}`),
          ),
        }
      : {}),
  }));

  return {
    id: surveyQuestionId(index),
    type: question.type,
    title: question.title,
    ...(question.description ? { description: question.description } : {}),
    required: question.required ?? true,
    order: index + 1,
    options,
    media: (question.media ?? []).map((media, mediaIndex) =>
      normalizeMedia(media, `q${index + 1}_media${mediaIndex + 1}`),
    ),
    ...(question.condition
      ? {
          condition: mapCondition(question.condition, questionIndexBySource, optionIdBySource, surveyQuestionId),
        }
      : {}),
  };
}

export function legacyToUnified(imported: ImportedSurvey): UnifiedSurveyImport {
  // Source ids -> generated unified ids, so jump rules can be validated in
  // the same id space the validator understands.
  const questionIndexBySource = new Map<string, number>();
  const optionIdBySource = new Map<string, string>();
  imported.questions.forEach((question, index) => {
    if (question.id) questionIndexBySource.set(question.id, index);
    (question.options ?? []).forEach((option, optionIndex) => {
      if (option.id) optionIdBySource.set(option.id, surveyOptionId(index, optionIndex));
    });
  });

  return {
    schema_version: 1,
    survey: {
      title: imported.title,
      ...(imported.description ? { description: imported.description } : {}),
      pages: [],
      questions: imported.questions.map((question, index) =>
        normalizeQuestion(question, index, questionIndexBySource, optionIdBySource),
      ),
      settings: {
        anonymous: imported.settings?.anonymous ?? false,
        allow_multiple: imported.settings?.allowMultipleResponses ?? false,
        max_responses: imported.settings?.maxResponsesPerUser ?? 1,
        shuffle_questions: false,
        shuffle_options: false,
        show_progress: true,
        allow_back: true,
        allow_resume: true,
      },
      metadata: {
        source: "json",
      },
    },
  };
}
