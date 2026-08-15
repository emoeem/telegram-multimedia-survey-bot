import type { MediaType, QuestionType } from "../db/schema";
import {
  createSurvey,
  deleteSurvey,
} from "../db/repositories/survey.repository";
import { legacyToUnified } from "../survey/converters/legacy-to-unified";
import { validateUnifiedSurvey } from "../survey/validator";

export interface ImportedMedia {
  id?: string;
  type: MediaType;
  source?: "telegram" | "r2" | "url";
  telegramFileId?: string;
  telegramFileUniqueId?: string;
  url?: string;
  storageKey?: string;
  mimeType?: string;
  fileName?: string;
  caption?: string;
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
}

export interface ImportedOption {
  label: string;
  value: string;
  media: ImportedMedia[];
}

export interface ImportedQuestion {
  type: QuestionType;
  title: string;
  description?: string;
  required?: boolean | null;
  options?: ImportedOption[];
  media?: ImportedMedia[];
}

export interface ImportedSurvey {
  title: string;
  description?: string;
  questions: ImportedQuestion[];
  importWarnings?: string[];
  settings?: {
    anonymous: boolean;
    allowMultipleResponses: boolean;
    maxResponsesPerUser: number;
  };
}

export type ImportedMediaResolver = (
  media: ImportedMedia,
) => Promise<ImportedMedia | null>;

const QUESTION_TYPES = new Set<QuestionType>([
  "single",
  "multiple",
  "text",
  "long_text",
  "number",
  "yes_no",
  "rating",
  "date",
  "time",
  "image",
  "video",
  "audio",
  "file",
]);

const MEDIA_TYPES = new Set<MediaType>([
  "photo",
  "video",
  "audio",
  "voice",
  "animation",
  "gif",
  "sticker",
  "document",
]);

function nonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeQuestionType(value: unknown): QuestionType {
  if (value === "boolean") {
    return "yes_no";
  }
  return QUESTION_TYPES.has(value as QuestionType)
    ? (value as QuestionType)
    : "text";
}

function normalizeMedia(value: unknown): ImportedMedia | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const mediaType = raw["type"];
  if (!MEDIA_TYPES.has(mediaType as MediaType)) {
    return null;
  }

  const media: ImportedMedia = { type: mediaType as MediaType };
  const id = nonEmptyString(raw["id"]);
  const telegramFileId = nonEmptyString(raw["telegram_file_id"]);
  const telegramFileUniqueId = nonEmptyString(
    raw["telegram_file_unique_id"],
  );
  const url = nonEmptyString(raw["url"]);
  const storageKey = nonEmptyString(raw["storage_key"]);
  const mimeType = nonEmptyString(raw["mime_type"]);
  const fileName = nonEmptyString(raw["file_name"]);
  const caption = nonEmptyString(raw["caption"]);

  if (id) media.id = id;
  if (
    raw["source"] === "telegram" ||
    raw["source"] === "r2" ||
    raw["source"] === "url"
  ) {
    media.source = raw["source"];
  }
  if (telegramFileId) media.telegramFileId = telegramFileId;
  if (telegramFileUniqueId) {
    media.telegramFileUniqueId = telegramFileUniqueId;
  }
  if (url) media.url = url;
  if (storageKey) media.storageKey = storageKey;
  if (mimeType) media.mimeType = mimeType;
  if (fileName) media.fileName = fileName;
  if (caption) media.caption = caption;
  if (typeof raw["width"] === "number") media.width = raw["width"];
  if (typeof raw["height"] === "number") media.height = raw["height"];
  if (typeof raw["duration"] === "number") {
    media.duration = raw["duration"];
  }
  if (typeof raw["size"] === "number") media.size = raw["size"];

  return media;
}

function normalizeMediaList(value: unknown): ImportedMedia[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .map(normalizeMedia)
    .filter((media): media is ImportedMedia => media !== null);
}

function normalizeOptions(value: unknown): ImportedOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((option) => {
    if (typeof option === "string") {
      const label = option.trim();
      return label ? [{ label, value: label, media: [] }] : [];
    }
    if (!option || typeof option !== "object") {
      return [];
    }

    const raw = option as Record<string, unknown>;
    const label = nonEmptyString(raw["text"], raw["label"], raw["value"]);
    if (!label) {
      return [];
    }
    return [
      {
        label,
        value: nonEmptyString(raw["value"], raw["text"], raw["label"]) ?? label,
        media: normalizeMediaList(raw["media"]),
      },
    ];
  });
}

function normalizeQuestions(value: unknown): ImportedQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((question): ImportedQuestion => {
    const raw =
      question && typeof question === "object"
        ? (question as Record<string, unknown>)
        : {};
    const required = raw["required"];
    const importedQuestion: ImportedQuestion = {
      type: normalizeQuestionType(raw["type"]),
      title: nonEmptyString(raw["title"]) ?? "",
      required:
        typeof required === "boolean" || required === null ? required : true,
      options: normalizeOptions(raw["options"]),
      media: normalizeMediaList(raw["media"]),
    };
    const description = nonEmptyString(raw["description"]);
    if (description) {
      importedQuestion.description = description;
    }
    return importedQuestion;
  });
}

function isOtherOnlyOption(option: ImportedOption): boolean {
  const value = option.label
    .trim()
    .toLowerCase()
    .replace(/[\s_.:：\-—,，。、()（）[\]【】]+/g, "");
  return (
    value === "其他" ||
    value === "其它" ||
    value === "other" ||
    value === "otheroption" ||
    value === "其他选项"
  );
}

function repairOtherOnlyQuestions(
  questions: ImportedQuestion[],
): string[] {
  const warnings: string[] = [];
  questions.forEach((question, index) => {
    const isChoice =
      question.type === "single" || question.type === "multiple";
    const options = question.options ?? [];
    if (!isChoice || options.length !== 1 || !isOtherOnlyOption(options[0]!)) {
      return;
    }

    const otherMedia = options[0]?.media ?? [];
    question.type = "text";
    question.options = [];
    question.media = [...(question.media ?? []), ...otherMedia];
    warnings.push(
      `第 ${index + 1} 题“${question.title || "未命名题目"}”只有“其他”填写项，已自动转为文本题`,
    );
  });
  return warnings;
}

export function parseImportedSurvey(input: string): ImportedSurvey {
  const raw = JSON.parse(input) as Record<string, unknown>;

  let data: ImportedSurvey;

  if (typeof raw["schema_version"] === "number" && raw["survey"]) {
    const unifiedSurvey = raw["survey"] as {
      title?: string;
      description?: string;
      settings?: {
        anonymous?: boolean;
        allow_multiple?: boolean;
        max_responses?: number;
      };
      questions?: unknown[];
    };

    data = {
      title: unifiedSurvey.title ?? "",
      ...(unifiedSurvey.description ? { description: unifiedSurvey.description } : {}),
      settings: {
        anonymous: unifiedSurvey.settings?.anonymous ?? false,
        allowMultipleResponses:
          unifiedSurvey.settings?.allow_multiple ?? false,
        maxResponsesPerUser: Math.max(
          1,
          Math.floor(unifiedSurvey.settings?.max_responses ?? 1),
        ),
      },
      questions: normalizeQuestions(unifiedSurvey.questions),
    };
  } else {
    const legacy = raw as {
      title?: string;
      description?: string;
      settings?: {
        anonymous?: boolean;
        allow_multiple?: boolean;
        max_responses?: number;
      };
      questions?: unknown[];
    };

    data = {
      title: legacy.title ?? "",
      ...(legacy.description ? { description: legacy.description } : {}),
      settings: {
        anonymous: legacy.settings?.anonymous ?? false,
        allowMultipleResponses: legacy.settings?.allow_multiple ?? false,
        maxResponsesPerUser: Math.max(
          1,
          Math.floor(legacy.settings?.max_responses ?? 1),
        ),
      },
      questions: normalizeQuestions(legacy.questions),
    };
  }

  if (!data.title || !Array.isArray(data.questions) || data.questions.length === 0) {
    throw new Error("JSON 必须包含 title 和 questions 数组");
  }

  const importWarnings = repairOtherOnlyQuestions(data.questions);
  if (importWarnings.length > 0) {
    data.importWarnings = importWarnings;
  }

  const unified = legacyToUnified(data);
  const issues = validateUnifiedSurvey(unified);
  if (issues.length > 0) {
    throw new Error(
      issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("\n"),
    );
  }

  return data;
}

function mediaCacheKey(media: ImportedMedia): string {
  return (
    media.telegramFileId ??
    media.id ??
    media.url ??
    media.storageKey ??
    JSON.stringify(media)
  );
}

async function resolveImportedMedia(
  survey: ImportedSurvey,
  resolver?: ImportedMediaResolver,
): Promise<ImportedSurvey> {
  const cache = new Map<string, ImportedMedia | null>();

  const resolveOne = async (
    media: ImportedMedia,
  ): Promise<ImportedMedia | null> => {
    if (media.telegramFileId) {
      return media;
    }
    const key = mediaCacheKey(media);
    if (cache.has(key)) {
      return cache.get(key) ?? null;
    }
    if (!resolver) {
      cache.set(key, null);
      return null;
    }
    const resolved = await resolver(media);
    cache.set(key, resolved);
    return resolved;
  };

  const resolveList = async (
    mediaList: ImportedMedia[],
  ): Promise<ImportedMedia[]> => {
    const resolved: ImportedMedia[] = [];
    for (const media of mediaList) {
      const item = await resolveOne(media);
      if (item) {
        resolved.push(item);
      }
    }
    return resolved;
  };

  const questions: ImportedQuestion[] = [];
  for (const question of survey.questions) {
    const options: ImportedOption[] = [];
    for (const option of question.options ?? []) {
      options.push({
        ...option,
        media: await resolveList(option.media),
      });
    }
    questions.push({
      ...question,
      media: await resolveList(question.media ?? []),
      options,
    });
  }

  return { ...survey, questions };
}

export async function saveImportedSurvey(
  db: D1Database,
  ownerId: number,
  survey: ImportedSurvey,
  mediaResolver?: ImportedMediaResolver,
): Promise<number> {
  const resolvedSurvey = await resolveImportedMedia(survey, mediaResolver);
  const created = await createSurvey(db, {
    ownerId,
    title: resolvedSurvey.title,
    description: resolvedSurvey.description ?? null,
    anonymous: resolvedSurvey.settings?.anonymous ?? false,
    allowMultipleResponses:
      resolvedSurvey.settings?.allowMultipleResponses ?? false,
    maxResponsesPerUser: resolvedSurvey.settings?.maxResponsesPerUser ?? 1,
  });

  const timestamp = new Date().toISOString();
  const questionRows = resolvedSurvey.questions.map((question, order) => ({
    type: question.type,
    title: question.title,
    description: question.description ?? null,
    required: question.required === false ? 0 : 1,
    order,
  }));
  const optionRows = resolvedSurvey.questions.flatMap((question, questionOrder) =>
    (question.options ?? []).map((option, optionOrder) => ({
      questionOrder,
      optionOrder,
      label: option.label,
      value: option.value,
    })),
  );

  const mediaRows = new Map<
    string,
    {
      mediaType: MediaType;
      telegramFileId: string;
      telegramFileUniqueId: string | null;
      mimeType: string | null;
      fileName: string | null;
      fileSize: number | null;
      width: number | null;
      height: number | null;
      duration: number | null;
    }
  >();
  const questionMediaRows: Array<{
    questionOrder: number;
    telegramFileId: string;
    sortOrder: number;
  }> = [];
  const optionMediaRows: Array<{
    questionOrder: number;
    optionOrder: number;
    telegramFileId: string;
    sortOrder: number;
  }> = [];

  const registerMedia = (media: ImportedMedia): string | null => {
    if (!media.telegramFileId) {
      return null;
    }
    if (!mediaRows.has(media.telegramFileId)) {
      mediaRows.set(media.telegramFileId, {
        mediaType: media.type,
        telegramFileId: media.telegramFileId,
        telegramFileUniqueId: media.telegramFileUniqueId ?? null,
        mimeType: media.mimeType ?? null,
        fileName: media.fileName ?? null,
        fileSize: media.size ?? null,
        width: media.width ?? null,
        height: media.height ?? null,
        duration: media.duration ?? null,
      });
    }
    return media.telegramFileId;
  };

  resolvedSurvey.questions.forEach((question, questionOrder) => {
    (question.media ?? []).forEach((media, sortOrder) => {
      const telegramFileId = registerMedia(media);
      if (telegramFileId) {
        questionMediaRows.push({
          questionOrder,
          telegramFileId,
          sortOrder,
        });
      }
    });
    (question.options ?? []).forEach((option, optionOrder) => {
      option.media.forEach((media, sortOrder) => {
        const telegramFileId = registerMedia(media);
        if (telegramFileId) {
          optionMediaRows.push({
            questionOrder,
            optionOrder,
            telegramFileId,
            sortOrder,
          });
        }
      });
    });
  });

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO survey_questions (
          survey_id, type, title, description, required,
          "order", created_at, updated_at
        )
        SELECT
          ?,
          json_extract(item.value, '$.type'),
          json_extract(item.value, '$.title'),
          json_extract(item.value, '$.description'),
          CAST(json_extract(item.value, '$.required') AS INTEGER),
          CAST(json_extract(item.value, '$.order') AS INTEGER),
          ?,
          ?
        FROM json_each(?) AS item`,
      )
      .bind(created.id, timestamp, timestamp, JSON.stringify(questionRows)),
  ];

  if (optionRows.length > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO question_options (
            question_id, label, value, "order", created_at, updated_at
          )
          SELECT
            question.id,
            json_extract(item.value, '$.label'),
            json_extract(item.value, '$.value'),
            CAST(json_extract(item.value, '$.optionOrder') AS INTEGER),
            ?,
            ?
          FROM json_each(?) AS item
          JOIN survey_questions AS question
            ON question.survey_id = ?
           AND question."order" =
             CAST(json_extract(item.value, '$.questionOrder') AS INTEGER)`,
        )
        .bind(
          timestamp,
          timestamp,
          JSON.stringify(optionRows),
          created.id,
        ),
    );
  }

  if (mediaRows.size > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO media_assets (
            media_type, telegram_file_id, telegram_file_unique_id,
            mime_type, file_name, file_size, width, height, duration,
            r2_key, created_at, updated_at
          )
          SELECT
            json_extract(item.value, '$.mediaType'),
            json_extract(item.value, '$.telegramFileId'),
            json_extract(item.value, '$.telegramFileUniqueId'),
            json_extract(item.value, '$.mimeType'),
            json_extract(item.value, '$.fileName'),
            json_extract(item.value, '$.fileSize'),
            json_extract(item.value, '$.width'),
            json_extract(item.value, '$.height'),
            json_extract(item.value, '$.duration'),
            NULL,
            ?,
            ?
          FROM json_each(?) AS item`,
        )
        .bind(
          timestamp,
          timestamp,
          JSON.stringify([...mediaRows.values()]),
        ),
    );
  }

  if (questionMediaRows.length > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO question_media (
            question_id, media_asset_id, sort_order, created_at
          )
          SELECT
            question.id,
            media.id,
            CAST(json_extract(item.value, '$.sortOrder') AS INTEGER),
            ?
          FROM json_each(?) AS item
          JOIN survey_questions AS question
            ON question.survey_id = ?
           AND question."order" =
             CAST(json_extract(item.value, '$.questionOrder') AS INTEGER)
          JOIN media_assets AS media
            ON media.telegram_file_id =
              json_extract(item.value, '$.telegramFileId')
           AND media.created_at = ?`,
        )
        .bind(
          timestamp,
          JSON.stringify(questionMediaRows),
          created.id,
          timestamp,
        ),
    );
  }

  if (optionMediaRows.length > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO option_media (
            question_option_id, media_asset_id, sort_order, created_at
          )
          SELECT
            option.id,
            media.id,
            CAST(json_extract(item.value, '$.sortOrder') AS INTEGER),
            ?
          FROM json_each(?) AS item
          JOIN survey_questions AS question
            ON question.survey_id = ?
           AND question."order" =
             CAST(json_extract(item.value, '$.questionOrder') AS INTEGER)
          JOIN question_options AS option
            ON option.question_id = question.id
           AND option."order" =
             CAST(json_extract(item.value, '$.optionOrder') AS INTEGER)
          JOIN media_assets AS media
            ON media.telegram_file_id =
              json_extract(item.value, '$.telegramFileId')
           AND media.created_at = ?`,
        )
        .bind(
          timestamp,
          JSON.stringify(optionMediaRows),
          created.id,
          timestamp,
        ),
    );
  }

  try {
    await db.batch(statements);
  } catch (error) {
    await deleteSurvey(db, created.id);
    throw error;
  }

  return created.id;
}
