import { getUserByTelegramId } from "../../db/repositories/user.repository";
import { createAuditLog } from "../../db/repositories/audit.repository";
import { getSurveyById } from "../../db/repositories/survey.repository";
import { hasActiveCreatorTrial } from "../../db/repositories/creator-trial.repository";
import type { MediaAsset, MediaType, QuestionType, Survey, SurveyQuestion } from "../../db/schema";
import type { Env } from "../../index";
import { KVMediaStore } from "../../services/media/temporary-media-store";
import { REPORT_TEMPLATES } from "../../services/report/template";
import type { ImportedSurvey } from "../../services/import.service";
import { createMediaAsset } from "../../db/repositories/media.repository";
import { ProfileGalleryItem } from "../../services/profile-gallery.service";
import {
  MATRIX_COLUMN_MIN,
  SURVEY_QUESTION_TYPES,
  isMatrixQuestionType,
  isSurveyQuestionType,
  minOptionCount,
} from "../../survey/question-rules";
import { createQuestion, createQuestionOption } from "../../db/repositories/question.repository";

export const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;
export const IMPORT_MAX_BYTES = 40 * 1024 * 1024;
export const SURVEY_MEDIA_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

// Uploads are stored in MEDIA_KV through the same pipeline as imports and
// background music (scope "survey", KV-backed, no expiry). Keeping a distinct
// storage-key prefix makes these blobs easy to recognise when debugging.
export const SURVEY_MEDIA_STORAGE_PREFIX = "media:survey:";
export const SURVEY_MEDIA_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "application/pdf",
  "application/zip",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  "application/octet-stream",
  "text/plain",
  "text/csv",
]);

export const SURVEY_MEDIA_EXTENSION_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  txt: "text/plain",
  csv: "text/csv",
};

export function surveyMediaMimeForFile(file: File): string | null {
  const explicit = file.type.toLowerCase();
  if (explicit && SURVEY_MEDIA_MIME_TYPES.has(explicit)) return explicit;
  if (!explicit) {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const inferred = SURVEY_MEDIA_EXTENSION_MIME[extension];
    if (inferred) return inferred;
  }
  if (explicit === "application/octet-stream") return explicit;
  return null;
}

export function surveyMediaTypeForMime(mimeType: string): MediaType {
  if (mimeType.startsWith("image/")) return "photo";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * Stores an admin-uploaded survey attachment (question/option media) into
 * MEDIA_KV and records the asset row. Throws with a user-facing message when
 * the file is rejected so callers can translate it into a 400 response.
 */
export async function storeSurveyAdminMedia(db: D1Database, kv: KVNamespace, file: File): Promise<MediaAsset> {
  const mimeType = surveyMediaMimeForFile(file);
  if (!mimeType) {
    throw new Error("不支持该文件类型，请上传图片、视频、音频或常见文档");
  }
  if (file.size <= 0) {
    throw new Error("文件为空，请重新选择");
  }
  if (file.size > SURVEY_MEDIA_UPLOAD_MAX_BYTES) {
    throw new Error(`单个附件不能超过 ${SURVEY_MEDIA_UPLOAD_MAX_BYTES / 1024 / 1024}MB`);
  }
  const store = new KVMediaStore(kv);
  const storageKey = `${SURVEY_MEDIA_STORAGE_PREFIX}${crypto.randomUUID()}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await store.put({ storageKey, bytes, contentType: mimeType });
  return createMediaAsset(db, {
    scope: "survey",
    mediaType: surveyMediaTypeForMime(mimeType),
    storageKind: store.kind,
    storageKey,
    expiresAt: null,
    mimeType,
    fileName: file.name || null,
    fileSize: bytes.byteLength,
  });
}

export function parseSettingsJson(value: string): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function adminProfileItem(item: ProfileGalleryItem) {
  return {
    id: item.responseId,
    surveyId: item.surveyId,
    owner: item.owner
      ? {
          telegramUserId: item.owner.telegramUserId,
          username: item.owner.username,
          firstName: item.owner.firstName,
          lastName: item.owner.lastName,
        }
      : null,
    showUsername: item.showUsername,
    publishedAt: item.publishedAt,
    createdAt: item.createdAt,
    images: item.images.map((image) => ({
      mediaAssetId: image.mediaAssetId,
      url: `/api/admin/profile-gallery/${item.responseId}/media/${image.mediaAssetId}`,
    })),
    fields: item.fields,
  };
}

export function buildImportSummary(imported: ImportedSurvey) {
  const typeCounts: Record<string, number> = {};
  let optionCount = 0;
  let questionMediaCount = 0;
  let optionMediaCount = 0;
  for (const question of imported.questions) {
    typeCounts[question.type] = (typeCounts[question.type] ?? 0) + 1;
    optionCount += question.options?.length ?? 0;
    questionMediaCount += question.media?.length ?? 0;
    optionMediaCount += (question.options ?? []).reduce((total, option) => total + option.media.length, 0);
  }
  const lowConfidence = imported.questions
    .map((question, index) => ({
      order: index + 1,
      title: question.title,
      type: question.type,
      confidence: question.confidence ?? null,
      warnings: question.warnings ?? [],
    }))
    .filter(
      (question) =>
        question.warnings.length > 0 ||
        (question.confidence?.type ?? 1) < 0.7 ||
        (question.confidence?.required ?? 1) < 0.7,
    )
    .slice(0, 50);

  return {
    title: imported.title,
    description: imported.description ?? null,
    cover: imported.cover?.url
      ? {
          url: imported.cover.url,
          ...(imported.cover.mimeType ? { mimeType: imported.cover.mimeType } : {}),
        }
      : null,
    questionCount: imported.questions.length,
    optionCount,
    pageCount: imported.pages?.length ?? 0,
    typeCounts,
    media: {
      question: questionMediaCount,
      option: optionMediaCount,
      total: questionMediaCount + optionMediaCount,
    },
    warnings: imported.importWarnings ?? [],
    lowConfidence,
    reportTemplateId: imported.settings?.reportTemplateId ?? null,
    reportTemplateName: imported.settings?.reportTemplateId
      ? (REPORT_TEMPLATES[imported.settings.reportTemplateId]?.name ?? null)
      : null,
  };
}

export type AdminUser = NonNullable<Awaited<ReturnType<typeof getUserByTelegramId>>>;

export interface QuestionPayload {
  type: QuestionType;
  title: string;
  description: string | null;
  required: boolean;
  pageId: number | null;
  settingsJson: string | null;
  validationJson: string | null;
  options: { label: string }[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readString(value: unknown, field: string, max: number): string | null {
  if (typeof value !== "string") return `${field}必须是字符串`;
  const trimmed = value.trim();
  if (!trimmed) return `${field}不能为空`;
  if (trimmed.length > max) return `${field}长度不能超过 ${max} 字符`;
  return null;
}

export function normalizeQuestionCondition(
  value: unknown,
): { conditionJson: string | null; skipToQuestionId: number | null } | { error: string } {
  if (value === null) {
    return { conditionJson: null, skipToQuestionId: null };
  }
  if (!isRecord(value)) {
    return { error: "condition 必须是对象或 null" };
  }
  const rules: Array<{ optionId: number; targetQuestionId: number }> = [];
  if (Array.isArray(value.rules)) {
    for (const item of value.rules) {
      if (!isRecord(item)) return { error: "rules 必须是对象数组" };
      const optionId = Number(item.optionId);
      const targetQuestionId = Number(item.targetQuestionId);
      if (
        !Number.isInteger(optionId) ||
        optionId <= 0 ||
        !Number.isInteger(targetQuestionId) ||
        targetQuestionId <= 0
      ) {
        return { error: "rules 中的 optionId / targetQuestionId 必须是正整数" };
      }
      rules.push({ optionId, targetQuestionId });
    }
  } else {
    const optionId = Number(value.optionId);
    const targetQuestionId = Number(value.targetQuestionId);
    if (!Number.isInteger(optionId) || optionId <= 0 || !Number.isInteger(targetQuestionId) || targetQuestionId <= 0) {
      return { error: "condition 需要 optionId 与 targetQuestionId" };
    }
    rules.push({ optionId, targetQuestionId });
  }
  if (rules.length === 0) {
    return { conditionJson: null, skipToQuestionId: null };
  }
  return {
    conditionJson: JSON.stringify({ kind: "option_equals", rules }),
    skipToQuestionId: rules[0]!.targetQuestionId,
  };
}

// Validates one question payload. `creating` distinguishes the full-create
// shape (type + options minimums enforced) from partial updates.
export function validateQuestionPayload(
  body: Record<string, unknown>,
  creating: boolean,
): { payload?: QuestionPayload; error?: string } {
  const type = body.type;
  if (creating || type !== undefined) {
    if (!isSurveyQuestionType(type)) {
      return { error: `题型必须是以下之一：${SURVEY_QUESTION_TYPES.join(", ")}` };
    }
  }

  let title: string | undefined;
  if (body.title !== undefined || creating) {
    const error = readString(body.title, "标题", 200);
    if (error) return { error };
    title = String(body.title).trim();
  }

  let description: string | null | undefined;
  if (body.description !== undefined) {
    if (body.description === null) description = null;
    else if (typeof body.description === "string") {
      if (body.description.length > 1000) return { error: "描述长度不能超过 1000 字符" };
      description = body.description.trim() || null;
    } else return { error: "描述必须是字符串" };
  }

  let required: boolean | undefined;
  if (body.required !== undefined) {
    if (typeof body.required !== "boolean") return { error: "必答必须是布尔值" };
    required = body.required;
  }

  let pageId: number | null | undefined;
  if (body.pageId !== undefined) {
    if (body.pageId === null) pageId = null;
    else if (Number.isInteger(body.pageId) && Number(body.pageId) > 0) pageId = Number(body.pageId);
    else return { error: "pageId 必须是正整数或 null" };
  }

  const effectiveType = creating ? (type as QuestionType) : undefined;
  const optionsInput = creating ? body.options : body.appendOptions;
  let options: { label: string }[] | undefined;
  if (optionsInput !== undefined) {
    if (!Array.isArray(optionsInput)) return { error: "选项必须是数组" };
    options = [];
    for (const item of optionsInput) {
      if (!isRecord(item)) return { error: "选项必须是对象" };
      const error = readString(item.label, "选项文本", 200);
      if (error) return { error };
      options.push({ label: String(item.label).trim() });
    }
    if (creating && effectiveType) {
      const minimum = minOptionCount(effectiveType);
      if (minimum !== null && options.length < minimum) {
        return { error: `该题型至少需要 ${minimum} 个选项` };
      }
    }
  }

  let settingsJson: string | null | undefined;
  if (body.settings !== undefined && body.settings !== null) {
    if (!isRecord(body.settings)) return { error: "settings 必须是对象" };
    const columns = body.settings.columns;
    if (!Array.isArray(columns)) return { error: "matrix 列必须是字符串数组" };
    for (const column of columns) {
      if (typeof column !== "string" || !column.trim() || column.length > 100) {
        return { error: "matrix 列必须是非空字符串（≤100 字符）" };
      }
    }
    if (columns.length < MATRIX_COLUMN_MIN) {
      return { error: `matrix 题至少需要 ${MATRIX_COLUMN_MIN} 列` };
    }
    settingsJson = JSON.stringify({ columns: columns.map((column) => column.trim()) });
  } else if (body.settings === null) {
    settingsJson = null;
  }
  if (creating && effectiveType === "matrix" && !settingsJson) {
    return { error: `matrix 题需要提供 settings.columns（至少 ${MATRIX_COLUMN_MIN} 列）` };
  }

  let validationJson: string | null | undefined;
  if (body.validation !== undefined) {
    if (body.validation === null) {
      validationJson = null;
    } else if (isRecord(body.validation)) {
      const allowed = ["min_length", "max_length", "min", "max", "min_selections", "max_selections"];
      const normalized: Record<string, number | boolean> = {};
      for (const [key, value] of Object.entries(body.validation)) {
        if (!allowed.includes(key)) return { error: `不支持的校验字段：${key}` };
        if (key === "decimal") {
          if (typeof value !== "boolean") return { error: "decimal 必须是布尔值" };
          normalized.decimal = value;
          continue;
        }
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          return { error: `${key} 必须是非负数字` };
        }
        normalized[key] = value;
      }
      validationJson = Object.keys(normalized).length ? JSON.stringify(normalized) : null;
    } else return { error: "validation 必须是对象" };
  }

  return {
    payload: {
      type: (effectiveType ?? "single") as QuestionType,
      title: title ?? "",
      description: description ?? null,
      required: required ?? true,
      pageId: pageId ?? null,
      settingsJson: settingsJson ?? null,
      validationJson: validationJson ?? null,
      options: options ?? [],
    },
  };
}

export async function touchSurvey(db: D1Database, surveyId: number): Promise<string> {
  const timestamp = new Date().toISOString();
  await db.prepare("UPDATE surveys SET updated_at = ? WHERE id = ?").bind(timestamp, surveyId).run();
  return timestamp;
}

/**
 * Dashboard widgets are whole-table COUNT/GROUP BY scans and change slowly
 * compared with how often an operator refreshes them. Five minutes keeps the
 * numbers useful while turning repeated refreshes into KV reads.
 */
export const ADMIN_DASHBOARD_CACHE_VERSION = "v1";
export const ADMIN_DASHBOARD_CACHE_TTL_SECONDS = 5 * 60;

/**
 * The community is in UTC+8, but the dashboard's "today" is computed with
 * SQLite's `date('now')`, which is UTC — the counter would otherwise reset at
 * 08:00 local time instead of midnight.
 */
export const DASHBOARD_TZ_OFFSET = "+8 hours";

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Parses a hex string into bytes; null when the text is not valid hex. */
export function hexToBytes(value: string): ArrayBuffer | null {
  if (value.length === 0 || value.length % 2 !== 0 || /[^0-9a-f]/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer as ArrayBuffer;
}

/**
 * Every admin route touches D1, so an account-level database outage would
 * otherwise surface as a bare 500 and a generic "加载失败" panel. Report the
 * real reason instead so the dashboard can explain what happened.
 */
export interface ReadContext {
  user: AdminUser;
  isAdmin: boolean;
  fail: (status: number, code: string, message: string) => Response;
  json: (body: unknown) => Response;
}

export const RESPONSE_STATUSES = ["in_progress", "completed", "abandoned", "cancelled", "archived"] as const;

export function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function loadReadableSurvey(env: Env, ctx: ReadContext, surveyId: number): Promise<Survey | Response> {
  const survey = await getSurveyById(env.DB, surveyId);
  if (!survey) return ctx.fail(404, "not_found", "问卷不存在");
  if (!ctx.isAdmin && survey.ownerId !== ctx.user.id) {
    return ctx.fail(403, "forbidden", "无权访问此问卷");
  }
  return survey;
}

export function responseStatusLabel(status: string): string {
  if (status === "completed") return "已完成";
  if (status === "in_progress") return "填写中";
  if (status === "abandoned") return "已放弃";
  if (status === "cancelled") return "已取消";
  return status;
}

export interface ResponseParticipantRow {
  userId?: unknown;
  telegramUserId?: unknown;
  username?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  participantKey?: unknown;
}

export function mapResponseParticipant(row: ResponseParticipantRow): {
  respondent: {
    userId: number;
    telegramUserId: number;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
  participantKey: string | null;
} {
  if (row.telegramUserId === null || row.telegramUserId === undefined) {
    return {
      respondent: null,
      participantKey:
        row.participantKey === null || row.participantKey === undefined ? null : String(row.participantKey),
    };
  }
  const stringOrNull = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  return {
    respondent: {
      userId: Number(row.userId ?? 0),
      telegramUserId: Number(row.telegramUserId),
      username: stringOrNull(row.username),
      firstName: stringOrNull(row.firstName),
      lastName: stringOrNull(row.lastName),
    },
    participantKey: null,
  };
}

export function parseStoredJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function formatAdminAnswer(
  answer: Record<string, unknown>,
  question: SurveyQuestion,
  selectedLabels: string[],
  optionLabels: Map<number, string>,
): string {
  if (selectedLabels.length) return selectedLabels.join("、");
  if (answer.text_value !== null && answer.text_value !== undefined) return String(answer.text_value);
  if (answer.number_value !== null && answer.number_value !== undefined) return String(answer.number_value);
  if (answer.rating_value !== null && answer.rating_value !== undefined) return String(answer.rating_value);
  if (answer.boolean_value !== null && answer.boolean_value !== undefined) {
    return Number(answer.boolean_value) === 1 ? "是" : "否";
  }
  if (answer.date_value !== null && answer.date_value !== undefined) return String(answer.date_value);
  if (answer.time_value !== null && answer.time_value !== undefined) return String(answer.time_value);

  const parsed = parseStoredJson(answer.json_value);
  if (question.type === "matrix" && isRecord(parsed)) {
    const selections = isRecord(parsed.selections) ? parsed.selections : null;
    let columns: string[] = [];
    try {
      const settings = question.settingsJson ? (JSON.parse(question.settingsJson) as { columns?: unknown }) : null;
      columns = Array.isArray(settings?.columns)
        ? settings.columns.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      columns = [];
    }
    if (selections) {
      return Object.entries(selections)
        .map(([rowId, columnIndex]) => {
          const row = optionLabels.get(Number(rowId)) ?? `行 #${rowId}`;
          const column = columns[Number(columnIndex)] ?? `列 ${Number(columnIndex) + 1}`;
          return `${row}：${column}`;
        })
        .join("；");
    }
  }
  if (Array.isArray(parsed)) {
    return parsed.map((value) => optionLabels.get(Number(value)) ?? String(value)).join("、");
  }
  if (isRecord(parsed) && typeof parsed.mediaAssetId === "number") {
    return `媒体附件 #${parsed.mediaAssetId}`;
  }
  if (parsed !== null && parsed !== undefined) {
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  }
  return "";
}

/**
 * Extracts the raw stored columns of an answer row so admins can inspect the
 * exact persisted value instead of only the formatted display string.
 */
export function rawStoredAnswer(answer: Record<string, unknown>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of [
    "text_value",
    "number_value",
    "boolean_value",
    "rating_value",
    "date_value",
    "time_value",
    "json_value",
  ] as const) {
    const value = answer[key];
    if (value !== null && value !== undefined) raw[key] = value;
  }
  return raw;
}
export interface WriteContext extends ReadContext {
  requestId: string;
}

export async function writeAudit(
  db: D1Database,
  input: {
    actorUserId: number | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  try {
    await createAuditLog(db, input);
  } catch (error) {
    // Auditing must never break the underlying operation.
    console.error("Audit log write failed", { action: input.action, error });
  }
}

export interface WritableSurvey {
  survey: Survey;
}

export async function loadManageableSurvey(
  env: Env,
  ctx: WriteContext,
  surveyId: number,
  body: Record<string, unknown>,
): Promise<WritableSurvey | Response> {
  const { user, isAdmin, fail, requestId } = ctx;
  const survey = await getSurveyById(env.DB, surveyId);
  if (!survey) return fail(404, "not_found", "问卷不存在");
  if (!isAdmin && survey.ownerId !== user.id) return fail(403, "forbidden", "无权访问此问卷");
  if (!isAdmin && !(await hasActiveCreatorTrial(env.DB, user.id))) {
    return fail(403, "creator_trial_required", "需要有效的创作者权限才能管理问卷。");
  }
  const baseUpdatedAt = typeof body.baseUpdatedAt === "string" ? body.baseUpdatedAt : null;
  if (baseUpdatedAt && baseUpdatedAt !== survey.updatedAt) {
    return Response.json(
      {
        code: "stale_write",
        message: "问卷已在其他窗口被修改，请刷新后重试。",
        requestId,
        currentUpdatedAt: survey.updatedAt,
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
  return { survey };
}

export async function loadWritableSurvey(
  env: Env,
  ctx: WriteContext,
  surveyId: number,
  body: Record<string, unknown>,
): Promise<WritableSurvey | Response> {
  const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
  if (manageable instanceof Response) return manageable;
  const { survey } = manageable;
  const { fail } = ctx;
  if (survey.status !== "draft") {
    return fail(403, "survey_locked", "仅草稿状态可编辑；已发布的问卷请复制后再修改。");
  }
  const responseCountRow = await env.DB.prepare("SELECT COUNT(*) count FROM survey_responses WHERE survey_id = ?")
    .bind(surveyId)
    .first<{ count: number }>();
  if (Number(responseCountRow?.count ?? 0) > 0) {
    return fail(403, "survey_locked", "该问卷已有答卷，题目和附件已锁定。");
  }
  return { survey };
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    // Action endpoints (close/archive/publish/delete) legitimately send an
    // empty body; treat it as an empty object and validate fields explicitly.
    if (!text.trim()) return {};
    const body = JSON.parse(text) as unknown;
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}
export async function insertQuestionWithOptions(
  db: D1Database,
  surveyId: number,
  payload: QuestionPayload,
  order: number,
): Promise<number> {
  const questionId = await createQuestion(db, {
    surveyId,
    type: payload.type,
    title: payload.title,
    description: payload.description,
    required: payload.required,
    order,
    pageId: payload.pageId,
    settingsJson: isMatrixQuestionType(payload.type) ? payload.settingsJson : null,
    validationJson: payload.validationJson,
  });
  for (let index = 0; index < payload.options.length; index += 1) {
    const option = payload.options[index]!;
    await createQuestionOption(db, {
      questionId,
      label: option.label,
      value: option.label,
      order: index,
    });
  }
  return questionId;
}
