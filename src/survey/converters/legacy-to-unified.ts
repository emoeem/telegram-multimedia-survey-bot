import type {
  SurveyMedia,
  SurveyOption,
  SurveyQuestion,
  UnifiedSurveyImport,
} from "../schema";
import { surveyOptionId, surveyQuestionId } from "../id-mapping";
import type {
  ImportedMedia,
  ImportedSurvey,
} from "../../services/import.service";

function normalizeMedia(
  media: ImportedMedia,
  fallbackId: string,
): SurveyMedia {
  return {
    id: media.id ?? fallbackId,
    type: media.type,
    source:
      media.source ??
      (media.telegramFileId
        ? "telegram"
        : media.storageKey
          ? "r2"
          : "url"),
    ...(media.telegramFileId
      ? { telegram_file_id: media.telegramFileId }
      : {}),
    ...(media.telegramFileUniqueId
      ? { telegram_file_unique_id: media.telegramFileUniqueId }
      : {}),
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

function normalizeQuestion(
  question: ImportedSurvey["questions"][number],
  index: number,
): SurveyQuestion {
  const options: SurveyOption[] = (question.options ?? []).map(
    (option, optionIndex) => ({
      id: surveyOptionId(index, optionIndex),
      label: option.label,
      value: option.value,
      order: optionIndex + 1,
      ...(option.media.length > 0
        ? {
            media: option.media.map((media, mediaIndex) =>
              normalizeMedia(
                media,
                `q${index + 1}_o${optionIndex + 1}_media${mediaIndex + 1}`,
              ),
            ),
          }
        : {}),
    }),
  );

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
  };
}

export function legacyToUnified(
  imported: ImportedSurvey,
): UnifiedSurveyImport {
  return {
    schema_version: 1,
    survey: {
      title: imported.title,
      ...(imported.description ? { description: imported.description } : {}),
      pages: [],
      questions: imported.questions.map(normalizeQuestion),
      settings: {
        anonymous: imported.settings?.anonymous ?? false,
        allow_multiple:
          imported.settings?.allowMultipleResponses ?? false,
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
