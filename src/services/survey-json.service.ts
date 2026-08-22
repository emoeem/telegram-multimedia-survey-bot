import type { UnifiedSurveyImport } from "../survey/schema";
import { getSurveyById } from "../db/repositories/survey.repository";
import {
  listOptionsForQuestions,
  listQuestionsBySurvey,
} from "../db/repositories/question.repository";
import { getMediaAssetById } from "../db/repositories/media.repository";
import type { SurveyMedia, SurveyOption, SurveyValidation } from "../survey/schema";
import {
  surveyMediaId,
  surveyOptionId,
  surveyPageId,
  surveyQuestionId,
} from "../survey/id-mapping";

interface QuestionMediaRow {
  questionId: number;
  mediaAssetId: number;
  mediaType: string;
  telegramFileId: string | null;
  telegramFileUniqueId: string | null;
  url: string | null;
  r2Key: string | null;
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
}

interface OptionMediaRow extends QuestionMediaRow {
  optionId: number;
}

interface PageRow {
  id: number;
  title: string | null;
  description: string | null;
  order: number;
}

function mediaFromRow(row: QuestionMediaRow): SurveyMedia {
  const media: SurveyMedia = {
    id: surveyMediaId(row.mediaAssetId),
    type: row.mediaType as SurveyMedia["type"],
    source: row.telegramFileId ? "telegram" : row.r2Key ? "r2" : "url",
  };
  if (row.telegramFileId) {
    media.telegram_file_id = row.telegramFileId;
  }
  if (row.telegramFileUniqueId) {
    media.telegram_file_unique_id = row.telegramFileUniqueId;
  }
  if (row.url) media.url = row.url;
  if (row.r2Key) media.storage_key = row.r2Key;
  if (row.mimeType) media.mime_type = row.mimeType;
  if (row.fileName) media.file_name = row.fileName;
  if (row.fileSize !== null) media.size = row.fileSize;
  if (row.width !== null) media.width = row.width;
  if (row.height !== null) media.height = row.height;
  if (row.duration !== null) media.duration = row.duration;
  return media;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function exportUnifiedSurveyJson(
  db: D1Database,
  surveyId: number,
): Promise<UnifiedSurveyImport | null> {
  const survey = await getSurveyById(db, surveyId);
  if (!survey) {
    return null;
  }

  const questions = await listQuestionsBySurvey(db, surveyId);
  const options = await listOptionsForQuestions(
    db,
    questions.map((question) => question.id),
  );
  const optionsByQuestion = new Map<number, typeof options>();

  for (const option of options) {
    const list = optionsByQuestion.get(option.questionId) ?? [];
    list.push(option);
    optionsByQuestion.set(option.questionId, list);
  }

  const [questionMediaRows, optionMediaRows, pageRows] = (await db.batch([
    db.prepare(
      `SELECT qm.question_id questionId, m.id mediaAssetId,
              m.media_type mediaType, m.telegram_file_id telegramFileId,
              m.telegram_file_unique_id telegramFileUniqueId, m.url url,
              m.r2_key r2Key, m.mime_type mimeType, m.file_name fileName,
              m.file_size fileSize, m.width width, m.height height,
              m.duration duration
       FROM question_media qm
       JOIN media_assets m ON m.id = qm.media_asset_id
       WHERE qm.question_id IN (SELECT id FROM survey_questions WHERE survey_id = ?)
       ORDER BY qm.question_id ASC, qm.sort_order ASC, qm.id ASC`,
    ).bind(surveyId),
    db.prepare(
      `SELECT om.question_option_id optionId, m.id mediaAssetId,
              m.media_type mediaType, m.telegram_file_id telegramFileId,
              m.telegram_file_unique_id telegramFileUniqueId, m.url url,
              m.r2_key r2Key, m.mime_type mimeType, m.file_name fileName,
              m.file_size fileSize, m.width width, m.height height,
              m.duration duration
       FROM option_media om
       JOIN media_assets m ON m.id = om.media_asset_id
       WHERE om.question_option_id IN (
         SELECT id FROM question_options WHERE question_id IN (
           SELECT id FROM survey_questions WHERE survey_id = ?
         )
       )
       ORDER BY om.question_option_id ASC, om.sort_order ASC, om.id ASC`,
    ).bind(surveyId),
    db.prepare(
      `SELECT id, title, description, "order"
       FROM survey_pages
       WHERE survey_id = ?
       ORDER BY "order" ASC, id ASC`,
    ).bind(surveyId),
  ])) as [
    D1Result<QuestionMediaRow>,
    D1Result<OptionMediaRow>,
    D1Result<PageRow>,
  ];

  const questionMediaByQuestion = new Map<number, SurveyMedia[]>();
  for (const row of questionMediaRows.results ?? []) {
    const list = questionMediaByQuestion.get(row.questionId) ?? [];
    list.push(mediaFromRow(row));
    questionMediaByQuestion.set(row.questionId, list);
  }

  const optionMediaByOption = new Map<number, SurveyMedia[]>();
  for (const row of optionMediaRows.results ?? []) {
    const list = optionMediaByOption.get(row.optionId) ?? [];
    list.push(mediaFromRow(row));
    optionMediaByOption.set(row.optionId, list);
  }

  const pageIdMap = new Map<number, string>();
  const pages = (pageRows.results ?? []).map((page, index) => {
    const id = surveyPageId(index);
    pageIdMap.set(page.id, id);
    return {
      id,
      order: index + 1,
      ...(page.title ? { title: page.title } : {}),
      ...(page.description ? { description: page.description } : {}),
    };
  });

  let cover: SurveyMedia | null = null;
  if (survey.coverMediaId !== null) {
    const coverAsset = await getMediaAssetById(db, survey.coverMediaId);
    if (coverAsset) {
      cover = mediaFromRow({
        questionId: 0,
        mediaAssetId: coverAsset.id,
        mediaType: coverAsset.mediaType,
        telegramFileId: coverAsset.telegramFileId,
        telegramFileUniqueId: coverAsset.telegramFileUniqueId,
        url: coverAsset.url,
        r2Key: coverAsset.r2Key,
        mimeType: coverAsset.mimeType,
        fileName: coverAsset.fileName,
        fileSize: coverAsset.fileSize,
        width: coverAsset.width,
        height: coverAsset.height,
        duration: coverAsset.duration,
      });
    }
  }

  return {
    schema_version: 1,
    survey: {
      title: survey.title,
      ...(survey.description ? { description: survey.description } : {}),
      ...(cover ? { cover } : {}),
      pages,
      questions: questions.map((question, index) => {
        const questionOptions: Array<{
          id: number;
          label: string;
          value: string;
          order: number;
        }> = optionsByQuestion.get(question.id) ?? [];
        const questionId = surveyQuestionId(index);
        const pageIdValue =
          question.pageId !== null ? pageIdMap.get(question.pageId) : undefined;
        const validation = parseJsonObject(question.validationJson);
        const settings = parseJsonObject(question.settingsJson);
        return {
          id: questionId,
          type: question.type,
          title: question.title,
          ...(question.description ? { description: question.description } : {}),
          required: question.required,
          order: index + 1,
          ...(pageIdValue ? { page_id: pageIdValue } : {}),
          ...(settings ? { settings } : {}),
          ...(validation ? { validation: validation as SurveyValidation } : {}),
          options: questionOptions.map((option, optionIndex): SurveyOption => {
            const optionMedia = optionMediaByOption.get(option.id) ?? [];
            return {
              id: surveyOptionId(index, optionIndex),
              label: option.label,
              value: option.value,
              order: optionIndex + 1,
              ...(optionMedia.length > 0 ? { media: optionMedia } : {}),
            };
          }),
          media: questionMediaByQuestion.get(question.id) ?? [],
        };
      }),
      settings: {
        anonymous: survey.anonymous,
        allow_multiple: survey.allowMultipleResponses,
        max_responses: survey.maxResponsesPerUser,
        shuffle_questions: false,
        shuffle_options: false,
        show_progress: true,
        allow_back: true,
        allow_resume: true,
      },
      metadata: {
        source: "telegram",
      },
    },
  };
}
