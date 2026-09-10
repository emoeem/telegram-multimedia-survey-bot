import type { Answer, QuestionType } from "../db/schema";
import { createMediaAsset, expireMediaAsset } from "../db/repositories/media.repository";
import { listAnswersByResponseId, setResponseGalleryPublished } from "../db/repositories/response.repository";
import { normalizeAnswer } from "./answer-value-adapter.service";
import { KVMediaStore } from "./media/temporary-media-store";
import { getSurveyFlow } from "./question.service";
import { getMatrixColumns } from "../survey/question-presentation";

/**
 * Personal-profile gallery backed by a designated survey. A completed
 * response becomes a public profile only when its owner publishes it; the
 * uploaded photos are copied into long-lived gallery assets so the 7-day
 * temporary media cleanup cannot remove published profile pictures.
 */

export interface ProfileGalleryEnvironment {
  DB: D1Database;
  MEDIA_KV?: KVNamespace;
}

export interface ProfileGalleryMediaRef {
  mediaAssetId: number;
  questionId: number;
}

export interface ProfileGalleryField {
  questionId: number;
  title: string;
  value: string;
}

export interface ProfileGalleryItem {
  responseId: number;
  surveyId: number;
  owner: {
    telegramUserId: number;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
  showUsername: boolean;
  publishedAt: string | null;
  createdAt: string;
  images: ProfileGalleryMediaRef[];
  fields: ProfileGalleryField[];
}

export interface ProfileGalleryPreferences {
  coverMediaId?: number | null;
  visibleQuestionIds?: number[];
  showUsername?: boolean;
}

export interface ProfileAnswerQuestion {
  type: QuestionType;
  options: Array<{ id: number; label: string }>;
  settingsJson: string | null;
}

interface AnswerMediaRow {
  mediaAssetId: number;
  questionId: number;
  sortOrder: number;
  mediaType: string;
  mimeType: string | null;
  storageKey: string | null;
  fileName: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
}

interface ResponseRow {
  responseId: number;
  surveyId: number;
  userId: number | null;
  publishedAt: string | null;
  createdAt: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  telegramUserId: number | null;
  galleryCoverMediaId?: number | null;
  galleryVisibleQuestionIdsJson?: string | null;
  galleryShowUsername?: number;
}

function galleryStorageKey(responseId: number): string {
  return `media:gallery:${responseId}:${crypto.randomUUID()}`;
}

function isImageAsset(row: Pick<AnswerMediaRow, "mediaType" | "mimeType">): boolean {
  return row.mediaType === "photo" || (row.mimeType?.startsWith("image/") ?? false);
}

async function listSourceAnswerMedia(db: D1Database, responseId: number): Promise<AnswerMediaRow[]> {
  const result = await db
    .prepare(
      `SELECT m.id mediaAssetId, m.media_type mediaType, m.mime_type mimeType,
              m.storage_key storageKey, m.file_name fileName, m.file_size fileSize,
              m.width width, m.height height,
              a.question_id questionId, am.sort_order sortOrder
       FROM answer_media am
       JOIN media_assets m ON m.id = am.media_asset_id
       JOIN answers a ON a.id = am.answer_id
       WHERE a.response_id = ? AND m.asset_scope = 'response'
       ORDER BY a.id ASC, am.sort_order ASC, am.id ASC`,
    )
    .bind(responseId)
    .all<AnswerMediaRow>();
  return result.results ?? [];
}

async function listGalleryMedia(db: D1Database, responseId: number): Promise<ProfileGalleryMediaRef[]> {
  const result = await db
    .prepare(
      `SELECT media_asset_id mediaAssetId, question_id questionId
       FROM gallery_profile_media
       WHERE response_id = ?
       ORDER BY sort_order ASC, id ASC`,
    )
    .bind(responseId)
    .all<ProfileGalleryMediaRef>();
  return result.results ?? [];
}

async function listPublishedSourceAssetIds(db: D1Database, responseId: number): Promise<Set<number>> {
  const result = await db
    .prepare(
      `SELECT source_asset_id sourceAssetId
       FROM gallery_profile_media
       WHERE response_id = ? AND source_asset_id IS NOT NULL`,
    )
    .bind(responseId)
    .all<{ sourceAssetId: number }>();
  return new Set((result.results ?? []).map((row) => Number(row.sourceAssetId)));
}

/**
 * Publishes a completed/in-progress response to the profile gallery: copies
 * its uploaded photo assets into long-lived gallery assets and links them.
 * Safe to retry — already-copied sources are skipped.
 */
export async function publishProfileResponse(
  env: ProfileGalleryEnvironment,
  responseId: number,
  preferences: ProfileGalleryPreferences = {},
): Promise<{ images: ProfileGalleryMediaRef[] }> {
  if (!env.MEDIA_KV) {
    throw new Error("个人画廊需要 MEDIA_KV 存储，当前环境未配置");
  }
  const store = new KVMediaStore(env.MEDIA_KV);
  const existingMedia = await listGalleryMedia(env.DB, responseId);
  if (existingMedia.length > 0) {
    if (
      preferences.coverMediaId !== undefined ||
      preferences.visibleQuestionIds !== undefined ||
      preferences.showUsername !== undefined
    ) {
      const cover = existingMedia.find((image) => image.mediaAssetId === preferences.coverMediaId);
      await env.DB.prepare(
        `UPDATE survey_responses
         SET gallery_cover_media_id = ?, gallery_visible_question_ids_json = ?, gallery_show_username = ?, updated_at = ?
         WHERE id = ?`,
      )
        .bind(
          cover?.mediaAssetId ?? null,
          preferences.visibleQuestionIds?.length ? JSON.stringify(preferences.visibleQuestionIds) : null,
          preferences.showUsername === true ? 1 : 0,
          new Date().toISOString(),
          responseId,
        )
        .run();
    }
    await setResponseGalleryPublished(env.DB, responseId, true);
    return { images: existingMedia };
  }

  const sources = (await listSourceAnswerMedia(env.DB, responseId)).filter(isImageAsset);
  const preferredCover = preferences.coverMediaId ?? null;
  const orderedSources = preferredCover
    ? [
        ...sources.filter((source) => source.mediaAssetId === preferredCover),
        ...sources.filter((source) => source.mediaAssetId !== preferredCover),
      ]
    : sources;
  const visibleQuestionIds = preferences.visibleQuestionIds?.filter((id) => Number.isInteger(id) && id > 0) ?? [];
  await env.DB.prepare(
    `UPDATE survey_responses
    SET gallery_visible_question_ids_json = ?, gallery_cover_source_asset_id = ?, gallery_show_username = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      visibleQuestionIds.length > 0 ? JSON.stringify(visibleQuestionIds) : null,
      preferredCover,
      preferences.showUsername === true ? 1 : 0,
      new Date().toISOString(),
      responseId,
    )
    .run();
  const copiedSources = await listPublishedSourceAssetIds(env.DB, responseId);
  const images: ProfileGalleryMediaRef[] = [];
  let galleryCoverMediaId: number | null = null;
  const timestamp = new Date().toISOString();

  for (const source of orderedSources) {
    if (copiedSources.has(source.mediaAssetId)) continue;
    if (!source.storageKey) continue;
    const bytes = await store.get(source.storageKey);
    if (!bytes) {
      throw new Error("上传的图片已过期或已被清理，请重新填写后发布");
    }
    const storageKey = galleryStorageKey(responseId);
    await store.put({ storageKey, bytes, contentType: source.mimeType ?? "image/jpeg" });
    const asset = await createMediaAsset(env.DB, {
      scope: "response",
      mediaType: "photo",
      storageKind: "temporary",
      storageKey,
      mimeType: source.mimeType ?? "image/jpeg",
      fileName: source.fileName,
      fileSize: source.fileSize ?? bytes.byteLength,
      width: source.width,
      height: source.height,
    });
    await env.DB.prepare(
      `INSERT INTO gallery_profile_media (
         response_id, media_asset_id, question_id, source_asset_id, sort_order, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(responseId, asset.id, source.questionId, source.mediaAssetId, images.length, timestamp)
      .run();
    images.push({ mediaAssetId: asset.id, questionId: source.questionId });
    if (source.mediaAssetId === preferredCover) galleryCoverMediaId = asset.id;
  }

  await env.DB.prepare("UPDATE survey_responses SET gallery_cover_media_id = ? WHERE id = ?")
    .bind(galleryCoverMediaId, responseId)
    .run();

  await setResponseGalleryPublished(env.DB, responseId, true);
  return { images };
}

/** Hides a profile from the gallery; copied images are retained so it can be restored. */
export async function unpublishProfileResponse(db: D1Database, responseId: number): Promise<void> {
  await setResponseGalleryPublished(db, responseId, false);
}

/** Hard-removes gallery copies (used when a gallery entry is deleted). */
export async function deleteProfileGalleryMedia(env: ProfileGalleryEnvironment, responseId: number): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT gpm.id mappingId, gpm.media_asset_id mediaAssetId, m.storage_key storageKey
     FROM gallery_profile_media gpm
     LEFT JOIN media_assets m ON m.id = gpm.media_asset_id
     WHERE gpm.response_id = ?`,
  )
    .bind(responseId)
    .all<{ mappingId: number; mediaAssetId: number; storageKey: string | null }>();
  const store = env.MEDIA_KV ? new KVMediaStore(env.MEDIA_KV) : null;
  for (const row of rows.results ?? []) {
    if (row.storageKey && store) await store.delete(row.storageKey).catch(() => undefined);
    await expireMediaAsset(env.DB, row.mediaAssetId);
    await env.DB.prepare("DELETE FROM gallery_profile_media WHERE id = ?").bind(row.mappingId).run();
  }
}

/** Converts a single stored answer into its display text for the profile card. */
export function formatProfileAnswerText(question: ProfileAnswerQuestion, answer: Answer): string | null {
  if (question.type === "image" || question.type === "video" || question.type === "audio" || question.type === "file") {
    return null;
  }
  const normalized = normalizeAnswer(answer, question.type);
  const value = normalized.value;

  if (question.type === "matrix") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const selections = (value as { selections?: Record<string, number> }).selections ?? {};
    const columns = getMatrixColumns(question);
    const lines: string[] = [];
    for (const option of question.options) {
      const columnIndex = selections[String(option.id)];
      if (columnIndex === undefined) continue;
      const column = columns[columnIndex];
      if (column !== undefined) lines.push(`${option.label}：${column}`);
    }
    return lines.length > 0 ? lines.join("；") : null;
  }
  if (question.type === "single" || question.type === "multiple" || question.type === "yes_no") {
    if (question.type === "yes_no" && (value === true || value === false)) {
      return value ? "是" : "否";
    }
    const ids = Array.isArray(value)
      ? value.flatMap((entry) => {
          const id = typeof entry === "number" ? entry : Number(entry);
          return Number.isInteger(id) && id > 0 ? [id] : [];
        })
      : [];
    const labels = ids
      .map((id) => question.options.find((option) => option.id === id)?.label)
      .filter((label): label is string => Boolean(label));
    if (labels.length > 0) return labels.join("、");
    if (typeof value === "string" || typeof value === "number") return String(value);
    return null;
  }
  if (question.type === "rating") {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text.length > 0 ? `${text} 分` : null;
  }
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value.trim() : String(value);
  return text.length > 0 ? text : null;
}

async function responseToProfileItem(
  db: D1Database,
  response: ResponseRow,
  flow: Awaited<ReturnType<typeof getSurveyFlow>>,
): Promise<ProfileGalleryItem> {
  const [answers, images] = await Promise.all([
    listAnswersByResponseId(db, response.responseId),
    listGalleryMedia(db, response.responseId),
  ]);
  const answerByQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  const fields: ProfileGalleryField[] = [];
  let visibleQuestionIds: number[] | null = null;
  if (response.galleryVisibleQuestionIdsJson) {
    try {
      const parsed = JSON.parse(response.galleryVisibleQuestionIdsJson) as unknown;
      if (Array.isArray(parsed)) {
        visibleQuestionIds = parsed.filter(
          (id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0,
        );
      }
    } catch {
      visibleQuestionIds = null;
    }
  }
  for (const question of flow.questions) {
    const answer = answerByQuestion.get(question.id);
    if (!answer) continue;
    const value = formatProfileAnswerText(question, answer);
    if (value === null) continue;
    if (visibleQuestionIds !== null && !visibleQuestionIds.includes(question.id)) continue;
    fields.push({ questionId: question.id, title: question.title, value });
  }
  if (response.galleryCoverMediaId !== null && response.galleryCoverMediaId !== undefined) {
    images.sort(
      (left, right) =>
        Number(right.mediaAssetId === response.galleryCoverMediaId) -
        Number(left.mediaAssetId === response.galleryCoverMediaId),
    );
  }
  return {
    responseId: response.responseId,
    surveyId: response.surveyId,
    owner:
      response.userId !== null && response.telegramUserId !== null
        ? {
            telegramUserId: response.telegramUserId,
            username: response.username,
            firstName: response.firstName,
            lastName: response.lastName,
          }
        : null,
    showUsername: response.galleryShowUsername === 1,
    publishedAt: response.publishedAt,
    createdAt: response.createdAt,
    images,
    fields,
  };
}

export async function listProfileGalleryItems(
  db: D1Database,
  options: {
    surveyId: number;
    publishedOnly: boolean;
    limit: number;
    offset: number;
    search?: string;
  },
): Promise<{ items: ProfileGalleryItem[]; total: number; publishedTotal: number }> {
  const conditions = ["r.survey_id = ?", "r.status = 'completed'"];
  const binds: unknown[] = [options.surveyId];
  if (options.publishedOnly) {
    conditions.push("r.gallery_published = 1");
  }
  const search = options.search?.trim() ?? "";
  if (search) {
    conditions.push("(CAST(r.id AS TEXT) LIKE ? OR u.username LIKE ? OR u.first_name LIKE ?)");
    const pattern = `%${search}%`;
    binds.push(pattern, pattern, pattern);
  }
  const where = conditions.join(" AND ");
  const [rows, count, publishedCount] = (await db.batch([
    db
      .prepare(
        `SELECT r.id responseId, r.survey_id surveyId, r.user_id userId,
                r.gallery_published_at publishedAt, r.created_at createdAt,
                r.gallery_cover_media_id galleryCoverMediaId,
                r.gallery_visible_question_ids_json galleryVisibleQuestionIdsJson,
                r.gallery_show_username galleryShowUsername,
                u.username, u.first_name firstName, u.last_name lastName, u.telegram_user_id telegramUserId
         FROM survey_responses r
         LEFT JOIN users u ON u.id = r.user_id
         WHERE ${where}
         ORDER BY r.gallery_published_at DESC, r.id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds, options.limit, options.offset),
    db
      .prepare(`SELECT COUNT(*) AS count FROM survey_responses r LEFT JOIN users u ON u.id = r.user_id WHERE ${where}`)
      .bind(...binds),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM survey_responses r
         WHERE r.survey_id = ? AND r.status = 'completed' AND r.gallery_published = 1`,
      )
      .bind(options.surveyId),
  ])) as [D1Result<ResponseRow>, D1Result<{ count: number }>, D1Result<{ count: number }>];

  const responseRows = rows.results ?? [];
  const flow = await getSurveyFlow(db, options.surveyId);
  const items: ProfileGalleryItem[] = [];
  for (const row of responseRows) {
    items.push(await responseToProfileItem(db, row, flow));
  }
  return {
    items,
    total: Number(count.results?.[0]?.count ?? 0),
    publishedTotal: Number(publishedCount.results?.[0]?.count ?? 0),
  };
}

export async function getPublishedGalleryMedia(
  db: D1Database,
  responseId: number,
  mediaAssetId: number,
): Promise<{ surveyId: number } | null> {
  const row = await db
    .prepare(
      `SELECT r.survey_id surveyId
       FROM survey_responses r
       JOIN gallery_profile_media gpm ON gpm.response_id = r.id
       WHERE r.id = ? AND r.gallery_published = 1 AND gpm.media_asset_id = ?
       LIMIT 1`,
    )
    .bind(responseId, mediaAssetId)
    .first<{ surveyId: number }>();
  return row ?? null;
}

/** Number of persisted gallery photos for a response (used by the admin toggle). */
export async function countProfileGalleryMedia(db: D1Database, responseId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM gallery_profile_media WHERE response_id = ?`)
    .bind(responseId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}
