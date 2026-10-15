import type { MediaStorageKind, MediaType, QuestionType } from "../db/schema";
import { createSurvey, deleteSurvey } from "../db/repositories/survey.repository";
import { legacyToUnified } from "../survey/converters/legacy-to-unified";
import { validateUnifiedSurvey } from "../survey/validator";
import { surveyPageId } from "../survey/id-mapping";
import { cleanImportText } from "./text-cleaner";

export interface ImportedMedia {
  id?: string;
  type: MediaType;
  source?: "telegram" | "r2" | "url";
  /** Explicit storage provider override (e.g. imported data URLs stored in KV). */
  storageKind?: MediaStorageKind;
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
  /** Source-format option id (e.g. "q3_o2"), referenced by jump rules. */
  id?: string;
  label: string;
  value: string;
  media: ImportedMedia[];
}

export interface ImportedQuestion {
  /** Source-format question id (e.g. "q3"), referenced by jump rules. */
  id?: string;
  type: QuestionType;
  title: string;
  description?: string;
  required?: boolean | null;
  pageId?: string;
  options?: ImportedOption[];
  media?: ImportedMedia[];
  settings?: Record<string, unknown>;
  /**
   * Jump rules in the runtime condition shape but with source ids (see
   * SurveyCondition). Validated against the survey's own ids and remapped to
   * numeric row ids on save.
   */
  condition?: Record<string, unknown>;
  /** Parser-produced per-question warnings (e.g. layout/association issues). */
  warnings?: string[];
  /** Parser confidence for type/required detection; surfaced in import preview. */
  confidence?: { type?: number; required?: number };
}

export interface ImportedPage {
  id?: string;
  title?: string;
  description?: string;
}

export interface ImportedSurvey {
  title: string;
  description?: string;
  cover?: ImportedMedia;
  pages?: ImportedPage[];
  questions: ImportedQuestion[];
  importWarnings?: string[];
  settings?: {
    anonymous: boolean;
    allowMultipleResponses: boolean;
    maxResponsesPerUser: number;
    reportTemplateId?: string;
    /** Reserved for the Phase-3 SurveyTheme system; persisted to settings_json. */
    theme?: unknown;
  };
}

export type ImportedMediaResolver = (media: ImportedMedia) => Promise<ImportedMedia | null>;

export interface ImportIssue {
  path: string;
  message: string;
  /** 1-based question number derived from the validation path. */
  questionNumber?: number;
  questionTitle?: string;
  /** Field within the question (e.g. type, options, media) when applicable. */
  field?: string;
}

/**
 * Structured import validation failure. The message stays human-readable for
 * legacy callers while issues carry per-field detail for the admin preview.
 */
export class ImportValidationError extends Error {
  readonly issues: ImportIssue[];

  constructor(issues: ImportIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "ImportValidationError";
    this.issues = issues;
  }
}

function enrichImportIssues(
  issues: Array<{ path: string; message: string }>,
  questions: ImportedQuestion[],
): ImportIssue[] {
  return issues.map((issue) => {
    const match = /questions\[(\d+)\]/.exec(issue.path);
    if (!match) return { ...issue };
    const index = Number(match[1]);
    const question = questions[index];
    if (!question) return { ...issue };
    const marker = `questions[${index}]`;
    const field = issue.path.slice(issue.path.indexOf(marker) + marker.length).replace(/^\./, "") || "question";
    return {
      ...issue,
      questionNumber: index + 1,
      questionTitle: question.title,
      field,
    };
  });
}

/**
 * Decodes a `data:` URL into bytes and mime type. Returns null for anything
 * that is not a valid data URL so callers can fall back gracefully.
 */
export function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mimeType: string } | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const meta = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  const match = /^([^;,]*)(;base64)?$/i.exec(meta);
  if (!match) return null;
  const mimeType = match[1] || "application/octet-stream";
  try {
    if (match[2]) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return { bytes, mimeType };
    }
    return {
      bytes: new TextEncoder().encode(decodeURIComponent(payload)),
      mimeType,
    };
  } catch {
    return null;
  }
}

const QUESTION_TYPES = new Set<QuestionType>([
  "single",
  "multiple",
  "text",
  "long_text",
  "number",
  "yes_no",
  "rating",
  "matrix",
  "date",
  "time",
  "image",
  "video",
  "audio",
  "file",
  "note",
]);

const MEDIA_TYPES = new Set<MediaType>(["photo", "video", "audio", "voice", "animation", "gif", "sticker", "document"]);

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
  return QUESTION_TYPES.has(value as QuestionType) ? (value as QuestionType) : "text";
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
  const telegramFileUniqueId = nonEmptyString(raw["telegram_file_unique_id"]);
  const url = nonEmptyString(raw["url"]);
  const storageKey = nonEmptyString(raw["storage_key"]);
  const mimeType = nonEmptyString(raw["mime_type"]);
  const fileName = nonEmptyString(raw["file_name"]);
  const caption = nonEmptyString(raw["caption"]);

  if (id) media.id = id;
  if (raw["source"] === "telegram" || raw["source"] === "r2" || raw["source"] === "url") {
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
  return values.map(normalizeMedia).filter((media): media is ImportedMedia => media !== null);
}

function normalizeOptions(value: unknown): ImportedOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  return value.flatMap((option) => {
    if (typeof option === "string") {
      const label = cleanImportText(option);
      if (!label) return [];
      const key = label.toLowerCase();
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ label, value: label, media: [] }];
    }
    if (!option || typeof option !== "object") {
      return [];
    }

    const raw = option as Record<string, unknown>;
    const rawLabel = nonEmptyString(raw["text"], raw["label"], raw["value"]);
    if (!rawLabel) {
      return [];
    }
    const label = cleanImportText(rawLabel);
    if (!label) return [];
    const key = label.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    const rawValue = nonEmptyString(raw["value"], raw["text"], raw["label"]) ?? label;
    const optionId = nonEmptyString(raw["id"]);
    return [
      {
        ...(optionId ? { id: optionId } : {}),
        label,
        value: cleanImportText(rawValue) || label,
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
    const raw = question && typeof question === "object" ? (question as Record<string, unknown>) : {};
    const required = raw["required"];
    const questionId = nonEmptyString(raw["id"], raw["question_id"]);
    const importedQuestion: ImportedQuestion = {
      ...(questionId ? { id: questionId } : {}),
      type: normalizeQuestionType(raw["type"]),
      title: cleanImportText(nonEmptyString(raw["title"]) ?? "") || "",
      required: typeof required === "boolean" || required === null ? required : true,
      options: normalizeOptions(raw["options"]),
      media: normalizeMediaList(raw["media"]),
    };
    if (raw["condition"] && typeof raw["condition"] === "object" && !Array.isArray(raw["condition"])) {
      importedQuestion.condition = raw["condition"] as Record<string, unknown>;
    }
    const warnings = raw["warnings"];
    if (Array.isArray(warnings)) {
      const strings = warnings.filter((item): item is string => typeof item === "string");
      if (strings.length) importedQuestion.warnings = strings;
    }
    const confidence: { type?: number; required?: number } = {};
    const typeConfidence = raw["type_confidence"];
    const requiredConfidence = raw["required_confidence"];
    if (typeof typeConfidence === "number") confidence.type = typeConfidence;
    if (typeof requiredConfidence === "number") confidence.required = requiredConfidence;
    if (Object.keys(confidence).length) importedQuestion.confidence = confidence;
    const description = nonEmptyString(raw["description"]);
    if (description) {
      const cleaned = cleanImportText(description);
      if (cleaned) importedQuestion.description = cleaned;
    }
    if (raw["settings"] && typeof raw["settings"] === "object" && !Array.isArray(raw["settings"])) {
      importedQuestion.settings = raw["settings"] as Record<string, unknown>;
    }
    const pageId = nonEmptyString(raw["page_id"], raw["pageId"]);
    if (pageId) {
      importedQuestion.pageId = pageId;
    }
    return importedQuestion;
  });
}

function normalizePages(value: unknown): ImportedPage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const pages: ImportedPage[] = [];
  for (const page of value) {
    if (!page || typeof page !== "object") continue;
    const raw = page as Record<string, unknown>;
    const title = nonEmptyString(raw["title"]);
    const description = nonEmptyString(raw["description"]);
    const id = nonEmptyString(raw["id"]);
    // Keep pages that only carry an id/order: PDF imports use these to
    // preserve pagination even when the source has no page title.
    if (!id && !title && !description) continue;
    pages.push({
      ...(id ? { id } : {}),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
    });
  }
  return pages;
}

function isOtherOnlyOption(option: ImportedOption): boolean {
  const value = option.label
    .trim()
    .toLowerCase()
    .replace(/[\s_.:：\-—,，。、()（）[\]【】]+/g, "");
  return value === "其他" || value === "其它" || value === "other" || value === "otheroption" || value === "其他选项";
}

function splitMergedShortOption(option: ImportedOption): ImportedOption[] | null {
  const parts = option.label
    .split(/\r?\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // PDF extraction sometimes joins two short options into one option with a
  // line break. Only repair the unambiguous two-line shape.
  if (
    parts.length !== 2 ||
    parts.some((part) => part.length > 24) ||
    parts.some((part) => /[，,。！？!?；;：:]/u.test(part))
  ) {
    return null;
  }

  return parts.map((part, index) => ({
    label: part,
    value: part,
    media: index === 0 ? option.media : [],
  }));
}

function appendDescription(question: ImportedQuestion, text: string): void {
  question.description = question.description ? `${question.description}\n\n${text}` : text;
}

function repairChoiceQuestions(questions: ImportedQuestion[]): string[] {
  const warnings: string[] = [];
  questions.forEach((question, index) => {
    const isChoice =
      question.type === "single" ||
      question.type === "multiple" ||
      question.type === "yes_no" ||
      question.type === "rating";
    const options = question.options ?? [];
    if (!isChoice || options.length >= 2) {
      return;
    }

    if (options.length === 1) {
      const splitOptions = splitMergedShortOption(options[0]!);
      if (splitOptions) {
        question.options = splitOptions;
        warnings.push(`第 ${index + 1} 题“${question.title || "未命名题目"}”检测到两个被换行合并的选项，已自动拆分`);
        return;
      }
    }

    if (options.length === 1 && isOtherOnlyOption(options[0]!)) {
      const otherMedia = options[0]?.media ?? [];
      question.type = "text";
      question.options = [];
      question.media = [...(question.media ?? []), ...otherMedia];
      warnings.push(`第 ${index + 1} 题“${question.title || "未命名题目"}”只有“其他”填写项，已自动转为文本题`);
      return;
    }

    const recoveredText = options[0]?.label.trim();
    if (recoveredText) {
      appendDescription(question, `导入识别到的原选项内容：\n${recoveredText}`);
    }
    question.type = "text";
    question.options = [];
    question.media = [...(question.media ?? []), ...(options[0]?.media ?? [])];
    warnings.push(
      `第 ${index + 1} 题“${question.title || "未命名题目"}”可识别选项不足两个，已自动转为文本题，请检查题目`,
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
      cover?: unknown;
      settings?: {
        anonymous?: boolean;
        allow_multiple?: boolean;
        max_responses?: number;
        report_template_id?: string;
        theme?: unknown;
      };
      pages?: unknown;
      questions?: unknown[];
    };

    data = {
      title: unifiedSurvey.title ?? "",
      ...(unifiedSurvey.description ? { description: unifiedSurvey.description } : {}),
      ...(normalizeMedia(unifiedSurvey.cover) ? { cover: normalizeMedia(unifiedSurvey.cover)! } : {}),
      pages: normalizePages(unifiedSurvey.pages),
      settings: {
        anonymous: unifiedSurvey.settings?.anonymous ?? false,
        allowMultipleResponses: unifiedSurvey.settings?.allow_multiple ?? false,
        maxResponsesPerUser: Math.max(1, Math.floor(unifiedSurvey.settings?.max_responses ?? 1)),
        ...(typeof unifiedSurvey.settings?.report_template_id === "string"
          ? { reportTemplateId: unifiedSurvey.settings.report_template_id }
          : {}),
        ...(unifiedSurvey.settings?.theme !== undefined ? { theme: unifiedSurvey.settings.theme } : {}),
      },
      questions: normalizeQuestions(unifiedSurvey.questions),
    };
  } else {
    const legacy = raw as {
      title?: string;
      description?: string;
      cover?: unknown;
      settings?: {
        anonymous?: boolean;
        allow_multiple?: boolean;
        max_responses?: number;
        report_template_id?: string;
        theme?: unknown;
      };
      questions?: unknown[];
    };

    data = {
      title: legacy.title ?? "",
      ...(legacy.description ? { description: legacy.description } : {}),
      ...(normalizeMedia(legacy.cover) ? { cover: normalizeMedia(legacy.cover)! } : {}),
      settings: {
        anonymous: legacy.settings?.anonymous ?? false,
        allowMultipleResponses: legacy.settings?.allow_multiple ?? false,
        maxResponsesPerUser: Math.max(1, Math.floor(legacy.settings?.max_responses ?? 1)),
        ...(typeof legacy.settings?.report_template_id === "string"
          ? { reportTemplateId: legacy.settings.report_template_id }
          : {}),
        ...(legacy.settings?.theme !== undefined ? { theme: legacy.settings.theme } : {}),
      },
      questions: normalizeQuestions(legacy.questions),
    };
  }

  if (!data.title || !Array.isArray(data.questions) || data.questions.length === 0) {
    throw new Error("JSON 必须包含 title 和 questions 数组");
  }

  // Media URLs must be self-contained (data:) or absolute (http/https).
  // Relative paths like assets/... come from old converter output and can
  // never be served after import; fail loudly instead of storing broken links.
  const relativeMediaIssues: ImportIssue[] = [];
  data.questions.forEach((question, questionIndex) => {
    const scan = (media: ImportedMedia, field: string) => {
      if (media.url && !/^(data:|https?:\/\/)/i.test(media.url)) {
        relativeMediaIssues.push({
          path: `questions[${questionIndex}].${field}.url`,
          message: "JSON 中的图片仍是本地路径（如 assets/...）。请使用新版 PDF 转换脚本重新生成 survey.json",
          questionNumber: questionIndex + 1,
          questionTitle: question.title,
          field: `${field}.url`,
        });
      }
    };
    (question.media ?? []).forEach((media) => scan(media, "media"));
    (question.options ?? []).forEach((option, optionIndex) =>
      option.media.forEach((media) => scan(media, `options[${optionIndex}].media`)),
    );
  });
  if (relativeMediaIssues.length > 0) {
    throw new ImportValidationError(relativeMediaIssues);
  }

  const importWarnings = repairChoiceQuestions(data.questions);
  if (importWarnings.length > 0) {
    data.importWarnings = importWarnings;
  }

  const unified = legacyToUnified(data);
  const issues = validateUnifiedSurvey(unified);
  if (issues.length > 0) {
    throw new ImportValidationError(enrichImportIssues(issues, data.questions));
  }

  return data;
}

function mediaCacheKey(media: ImportedMedia): string {
  return media.telegramFileId ?? media.id ?? media.url ?? media.storageKey ?? JSON.stringify(media);
}

async function resolveImportedMedia(survey: ImportedSurvey, resolver?: ImportedMediaResolver): Promise<ImportedSurvey> {
  const cache = new Map<string, ImportedMedia | null>();

  const resolveOne = async (media: ImportedMedia): Promise<ImportedMedia | null> => {
    if (media.telegramFileId) {
      return media;
    }
    const key = mediaCacheKey(media);
    if (cache.has(key)) {
      return cache.get(key) ?? null;
    }
    if (!resolver) {
      // Without a resolver (e.g. the web admin import path), keep URL and R2
      // media as-is so they can be persisted into media_assets.
      cache.set(key, media);
      return media;
    }
    const resolved = await resolver(media);
    cache.set(key, resolved);
    return resolved;
  };

  const resolveList = async (mediaList: ImportedMedia[]): Promise<ImportedMedia[]> => {
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

  const cover = survey.cover ? await resolveOne(survey.cover) : undefined;
  return { ...survey, ...(cover ? { cover } : {}), questions };
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
    allowMultipleResponses: resolvedSurvey.settings?.allowMultipleResponses ?? false,
    maxResponsesPerUser: resolvedSurvey.settings?.maxResponsesPerUser ?? 1,
    reportTemplateId: resolvedSurvey.settings?.reportTemplateId ?? null,
    settingsJson:
      resolvedSurvey.settings?.theme !== undefined ? JSON.stringify({ theme: resolvedSurvey.settings.theme }) : null,
  });

  const timestamp = new Date().toISOString();

  // Pages are inserted first so question rows can reference page ids inside
  // the single JSON1 batch below.
  const pageIdsBySource = new Map<string, number>();
  const pageRows = resolvedSurvey.pages ?? [];
  for (let index = 0; index < pageRows.length; index += 1) {
    const page = pageRows[index];
    if (!page) continue;
    const sourceId = page.id ?? surveyPageId(index);
    const result = await db
      .prepare(
        `INSERT INTO survey_pages (
          survey_id, title, description, "order", created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(created.id, page.title ?? null, page.description ?? null, index, timestamp, timestamp)
      .run();
    const pageId = result.meta?.last_row_id;
    if (typeof pageId !== "number") {
      throw new Error("Failed to create survey page");
    }
    pageIdsBySource.set(sourceId, pageId);
  }

  const questionRows = resolvedSurvey.questions.map((question, order) => ({
    type: question.type,
    title: question.title,
    description: question.description ?? null,
    required: question.required === false ? 0 : 1,
    order,
    pageId: question.pageId !== undefined ? (pageIdsBySource.get(question.pageId) ?? null) : null,
    settingsJson: question.settings ? JSON.stringify(question.settings) : null,
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
      storageKind: string;
      storageKey: string | null;
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
  >();
  const questionMediaRows: Array<{
    questionOrder: number;
    mediaKey: string;
    sortOrder: number;
  }> = [];
  const optionMediaRows: Array<{
    questionOrder: number;
    optionOrder: number;
    mediaKey: string;
    sortOrder: number;
  }> = [];

  const registerMedia = (media: ImportedMedia): string | null => {
    const mediaKey = media.telegramFileId ?? media.url ?? media.storageKey ?? null;
    if (!mediaKey) {
      return null;
    }
    if (!mediaRows.has(mediaKey)) {
      mediaRows.set(mediaKey, {
        mediaType: media.type,
        storageKind:
          media.storageKind ??
          (media.telegramFileId ? "telegram" : media.storageKey ? "r2" : media.url ? "url" : "telegram"),
        storageKey: media.storageKey ?? null,
        telegramFileId: media.telegramFileId ?? null,
        telegramFileUniqueId: media.telegramFileUniqueId ?? null,
        url: media.url ?? null,
        r2Key: media.storageKind === "r2" ? (media.storageKey ?? null) : null,
        mimeType: media.mimeType ?? null,
        fileName: media.fileName ?? null,
        fileSize: media.size ?? null,
        width: media.width ?? null,
        height: media.height ?? null,
        duration: media.duration ?? null,
      });
    }
    return mediaKey;
  };

  // Cover media is registered alongside question/option media so it is
  // inserted in the same batch; the survey row is updated afterwards.
  let coverMediaKey: string | null = null;
  if (resolvedSurvey.cover) {
    coverMediaKey = registerMedia(resolvedSurvey.cover);
  }

  resolvedSurvey.questions.forEach((question, questionOrder) => {
    (question.media ?? []).forEach((media, sortOrder) => {
      const mediaKey = registerMedia(media);
      if (mediaKey) {
        questionMediaRows.push({
          questionOrder,
          mediaKey,
          sortOrder,
        });
      }
    });
    (question.options ?? []).forEach((option, optionOrder) => {
      option.media.forEach((media, sortOrder) => {
        const mediaKey = registerMedia(media);
        if (mediaKey) {
          optionMediaRows.push({
            questionOrder,
            optionOrder,
            mediaKey,
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
          "order", page_id, settings_json, created_at, updated_at
        )
        SELECT
          ?,
          json_extract(item.value, '$.type'),
          json_extract(item.value, '$.title'),
          json_extract(item.value, '$.description'),
          CAST(json_extract(item.value, '$.required') AS INTEGER),
          CAST(json_extract(item.value, '$.order') AS INTEGER),
          CAST(json_extract(item.value, '$.pageId') AS INTEGER),
          json_extract(item.value, '$.settingsJson'),
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
        .bind(timestamp, timestamp, JSON.stringify(optionRows), created.id),
    );
  }

  if (mediaRows.size > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO media_assets (
            asset_scope, media_type, telegram_file_id, telegram_file_unique_id,
            url, storage_kind, storage_key, mime_type, file_name, file_size,
            width, height, duration, r2_key, created_at, updated_at
          )
          SELECT
            'survey',
            json_extract(item.value, '$.mediaType'),
            json_extract(item.value, '$.telegramFileId'),
            json_extract(item.value, '$.telegramFileUniqueId'),
            json_extract(item.value, '$.url'),
            json_extract(item.value, '$.storageKind'),
            json_extract(item.value, '$.storageKey'),
            json_extract(item.value, '$.mimeType'),
            json_extract(item.value, '$.fileName'),
            json_extract(item.value, '$.fileSize'),
            json_extract(item.value, '$.width'),
            json_extract(item.value, '$.height'),
            json_extract(item.value, '$.duration'),
            json_extract(item.value, '$.r2Key'),
            ?,
            ?
          FROM json_each(?) AS item`,
        )
        .bind(timestamp, timestamp, JSON.stringify([...mediaRows.values()])),
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
            ON media.created_at = ?
           AND (
             (media.telegram_file_id IS NOT NULL
              AND media.telegram_file_id =
                json_extract(item.value, '$.mediaKey'))
             OR (media.url IS NOT NULL
                 AND media.url = json_extract(item.value, '$.mediaKey'))
             OR (media.r2_key IS NOT NULL
                 AND media.r2_key = json_extract(item.value, '$.mediaKey'))
             OR (media.storage_key IS NOT NULL
                 AND media.storage_key = json_extract(item.value, '$.mediaKey'))
           )`,
        )
        .bind(timestamp, JSON.stringify(questionMediaRows), created.id, timestamp),
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
            ON media.created_at = ?
           AND (
             (media.telegram_file_id IS NOT NULL
              AND media.telegram_file_id =
                json_extract(item.value, '$.mediaKey'))
             OR (media.url IS NOT NULL
                 AND media.url = json_extract(item.value, '$.mediaKey'))
             OR (media.r2_key IS NOT NULL
                 AND media.r2_key = json_extract(item.value, '$.mediaKey'))
             OR (media.storage_key IS NOT NULL
                 AND media.storage_key = json_extract(item.value, '$.mediaKey'))
           )`,
        )
        .bind(timestamp, JSON.stringify(optionMediaRows), created.id, timestamp),
    );
  }

  if (coverMediaKey !== null) {
    const cover = resolvedSurvey.cover;
    const keyField = cover?.telegramFileId ? "telegram_file_id" : cover?.storageKey ? "storage_key" : "url";
    statements.push(
      db
        .prepare(
          `UPDATE surveys
           SET cover_media_id = (
             SELECT id FROM media_assets
             WHERE created_at = ? AND ${keyField} = ?
             ORDER BY id DESC LIMIT 1
           )
           WHERE id = ?`,
        )
        .bind(timestamp, coverMediaKey, created.id),
    );
  }

  try {
    await db.batch(statements);
  } catch (error) {
    await deleteSurvey(db, created.id);
    throw error;
  }

  // Jump conditions reference source-format ids; now that real rows exist,
  // remap them to numeric row ids. Runs after the main batch so the rows are
  // visible; a failure here aborts the import the same way the batch above
  // does (core rows are deleted, endpoint reports the failure).
  const conditioned = resolvedSurvey.questions
    .map((question, order) => ({ question, order }))
    .filter((entry) => entry.question.condition);
  if (conditioned.length > 0) {
    try {
      const questionOrderOfSource = new Map<string, number>();
      resolvedSurvey.questions.forEach((question, index) => {
        if (question.id) questionOrderOfSource.set(question.id, index);
      });
      const questionIdRows = await db
        .prepare(`SELECT id, "order" FROM survey_questions WHERE survey_id = ?`)
        .bind(created.id)
        .all<{ id: number; order: number }>();
      const questionIdByOrder = new Map(questionIdRows.results.map((row) => [row.order, row.id]));
      const optionIdRows = await db
        .prepare(
          `SELECT o.id AS id, q."order" AS question_order, o."order" AS option_order
           FROM question_options o
           JOIN survey_questions q ON q.id = o.question_id
           WHERE q.survey_id = ?`,
        )
        .bind(created.id)
        .all<{ id: number; question_order: number; option_order: number }>();
      const optionIdByPosition = new Map(
        optionIdRows.results.map((row) => [`${row.question_order}:${row.option_order}`, row.id]),
      );
      // Source option id -> question/option position across the whole survey
      // (answerRules.equals references the ruled question's options).
      const optionPositionBySource = new Map<string, { questionOrder: number; optionOrder: number }>();
      resolvedSurvey.questions.forEach((entry, questionOrder) => {
        (entry.options ?? []).forEach((option, optionOrder) => {
          if (option.id) optionPositionBySource.set(option.id, { questionOrder, optionOrder });
        });
      });

      const conditionStatements: D1PreparedStatement[] = [];
      for (const { question, order } of conditioned) {
        const remapped = remapImportedCondition(
          question,
          order,
          questionOrderOfSource,
          questionIdByOrder,
          optionIdByPosition,
          optionPositionBySource,
        );
        if (!remapped) continue;
        conditionStatements.push(
          db
            .prepare(
              `UPDATE survey_questions SET condition_json = ?, skip_to_question_id = ?, updated_at = ? WHERE id = ?`,
            )
            .bind(remapped.conditionJson, remapped.skipToQuestionId, timestamp, remapped.questionId),
        );
      }
      if (conditionStatements.length > 0) {
        await db.batch(conditionStatements);
      }
    } catch (error) {
      await deleteSurvey(db, created.id);
      throw error;
    }
  }

  return created.id;
}

/**
 * Rewrites one imported question's condition (source ids) onto numeric row
 * ids. Returns null when nothing resolvable remains. Mirrors the drops done
 * by legacyToUnified's mapCondition so validated imports never fail here:
 * unknown options/questions and backward targets are skipped.
 */
function remapImportedCondition(
  question: ImportedQuestion,
  order: number,
  questionOrderOfSource: Map<string, number>,
  questionIdByOrder: Map<number, number>,
  optionIdByPosition: Map<string, number>,
  optionPositionBySource: Map<string, { questionOrder: number; optionOrder: number }>,
): { questionId: number; conditionJson: string; skipToQuestionId: number | null } | null {
  const condition = question.condition;
  if (!condition) return null;
  const numericQuestionId = questionIdByOrder.get(order);
  if (numericQuestionId === undefined) return null;

  const numericIdOfSource = (sourceId: unknown): number | null => {
    const sourceOrder = questionOrderOfSource.get(String(sourceId));
    if (sourceOrder === undefined) return null;
    return questionIdByOrder.get(sourceOrder) ?? null;
  };
  // Jump targets are forward-only at runtime (engine.forwardTarget ignores
  // anything at or before the current question), so skip non-forward targets.
  const forwardTargetOfSource = (sourceId: unknown): number | null => {
    const sourceOrder = questionOrderOfSource.get(String(sourceId));
    if (sourceOrder === undefined || sourceOrder <= order) return null;
    return questionIdByOrder.get(sourceOrder) ?? null;
  };
  // answerRules.equals may reference an option of the RULED question (often a
  // question before this one), so option positions are resolved across the
  // whole survey, not just this question's options.
  const numericOptionIdOfSource = (sourceId: unknown): number | null => {
    const position = optionPositionBySource.get(String(sourceId));
    if (!position) return null;
    return optionIdByPosition.get(`${position.questionOrder}:${position.optionOrder}`) ?? null;
  };

  const rules: Array<{ optionId: number; targetQuestionId: number }> = [];
  for (const rule of Array.isArray(condition.rules) ? condition.rules : []) {
    if (!rule || typeof rule !== "object") continue;
    const entry = rule as Record<string, unknown>;
    const optionNumericId = numericOptionIdOfSource(entry.optionId);
    const targetQuestionId = forwardTargetOfSource(entry.targetQuestionId);
    if (optionNumericId !== null && targetQuestionId !== null) {
      rules.push({ optionId: optionNumericId, targetQuestionId });
    }
  }
  // Legacy single-rule shape (optionId + targetQuestionId).
  if (rules.length === 0 && condition.optionId !== undefined) {
    const optionNumericId = numericOptionIdOfSource(condition.optionId);
    const targetQuestionId = forwardTargetOfSource(condition.targetQuestionId);
    if (optionNumericId !== null && targetQuestionId !== null) {
      rules.push({ optionId: optionNumericId, targetQuestionId });
    }
  }

  const answerRules: Array<{ questionId: number; equals: number; targetQuestionId: number }> = [];
  for (const rule of Array.isArray(condition.answerRules) ? condition.answerRules : []) {
    if (!rule || typeof rule !== "object") continue;
    const entry = rule as Record<string, unknown>;
    const ruledQuestionId = numericIdOfSource(entry.questionId);
    const targetQuestionId = forwardTargetOfSource(entry.targetQuestionId);
    if (ruledQuestionId === null || targetQuestionId === null) continue;
    // Source-format equals references the ruled question's option id; numeric
    // values pass through (authoring against an already-imported survey).
    const equals = numericOptionIdOfSource(entry.equals) ?? Number(entry.equals);
    if (!Number.isInteger(equals) || (equals as number) <= 0) continue;
    answerRules.push({ questionId: ruledQuestionId, equals: equals as number, targetQuestionId });
  }
  if (rules.length === 0 && answerRules.length === 0) return null;

  return {
    questionId: numericQuestionId,
    conditionJson: JSON.stringify({
      kind: "option_equals",
      ...(rules.length ? { rules } : {}),
      ...(answerRules.length ? { answerRules } : {}),
    }),
    // Legacy single-rule consumers read skip_to_question_id; mirror the
    // editor's parseConditionInput behaviour of pointing it at the first
    // rule's target.
    skipToQuestionId: rules[0]?.targetQuestionId ?? null,
  };
}
