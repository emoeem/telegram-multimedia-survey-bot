import type { MediaAsset, MediaAssetScope, MediaStorageKind, MediaType } from "../schema";

const OPTION_ID_BATCH_SIZE = 90;

interface MediaAssetRow {
  id: number;
  asset_scope?: string;
  media_type: string;
  telegram_file_id: string | null;
  telegram_file_unique_id: string | null;
  url: string | null;
  storage_kind: string;
  storage_key: string | null;
  expires_at: string | null;
  mime_type: string | null;
  file_name: string | null;
  file_size: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  r2_key: string | null;
  created_at: string;
  updated_at: string;
}

function mapMediaAsset(row: MediaAssetRow): MediaAsset {
  return {
    id: row.id,
    scope: (row.asset_scope ?? "legacy") as MediaAssetScope,
    mediaType: row.media_type as MediaType,
    telegramFileId: row.telegram_file_id,
    telegramFileUniqueId: row.telegram_file_unique_id,
    url: row.url,
    storageKind: (row.storage_kind ?? "telegram") as MediaStorageKind,
    storageKey: row.storage_key,
    expiresAt: row.expires_at,
    mimeType: row.mime_type,
    fileName: row.file_name,
    fileSize: row.file_size,
    width: row.width,
    height: row.height,
    duration: row.duration,
    r2Key: row.r2_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createMediaAsset(
  db: D1Database,
  input: {
    scope?: MediaAssetScope;
    mediaType: MediaType;
    telegramFileId?: string | null;
    telegramFileUniqueId?: string | null;
    url?: string | null;
    storageKind?: MediaStorageKind;
    storageKey?: string | null;
    expiresAt?: string | null;
    mimeType?: string | null;
    fileName?: string | null;
    fileSize?: number | null;
    width?: number | null;
    height?: number | null;
    duration?: number | null;
    r2Key?: string | null;
  },
): Promise<MediaAsset> {
  const timestamp = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO media_assets (
        asset_scope, media_type, telegram_file_id, telegram_file_unique_id,
        url, storage_kind, storage_key, expires_at,
        mime_type, file_name, file_size, width, height, duration,
        r2_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.scope ?? "survey",
      input.mediaType,
      input.telegramFileId ?? null,
      input.telegramFileUniqueId ?? null,
      input.url ?? null,
      input.storageKind ?? "telegram",
      input.storageKey ?? null,
      input.expiresAt ?? null,
      input.mimeType ?? null,
      input.fileName ?? null,
      input.fileSize ?? null,
      input.width ?? null,
      input.height ?? null,
      input.duration ?? null,
      input.r2Key ?? null,
      timestamp,
      timestamp,
    )
    .run();

  const id = result.meta?.last_row_id;
  if (typeof id !== "number") {
    throw new Error("Failed to create media asset");
  }

  const asset = await getMediaAssetById(db, id);
  if (!asset) {
    throw new Error("Failed to load media asset");
  }

  return asset;
}

export async function getMediaAssetById(
  db: D1Database,
  id: number,
): Promise<MediaAsset | null> {
  const row = await db
    .prepare("SELECT * FROM media_assets WHERE id = ? LIMIT 1")
    .bind(id)
    .first<MediaAssetRow>();

  return row ? mapMediaAsset(row) : null;
}

export async function createQuestionMedia(
  db: D1Database,
  input: {
    questionId: number;
    mediaAssetId: number;
    sortOrder?: number;
  },
): Promise<void> {
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO question_media (
        question_id, media_asset_id, sort_order, created_at
      ) VALUES (?, ?, ?, ?)`,
    )
    .bind(
      input.questionId,
      input.mediaAssetId,
      input.sortOrder ?? 0,
      timestamp,
    )
    .run();
}

export async function getQuestionMediaByQuestionId(
  db: D1Database,
  questionId: number,
): Promise<Array<{ id: number; mediaAssetId: number; sortOrder: number }>> {
  const result = await db
    .prepare(
      `SELECT id, media_asset_id, sort_order
       FROM question_media
       WHERE question_id = ?
       ORDER BY sort_order ASC, id ASC`,
    )
    .bind(questionId)
    .all<{ id: number; media_asset_id: number; sort_order: number }>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    mediaAssetId: row.media_asset_id,
    sortOrder: row.sort_order,
  }));
}

export async function deleteQuestionMedia(
  db: D1Database,
  questionMediaId: number,
): Promise<void> {
  await db
    .prepare("DELETE FROM question_media WHERE id = ?")
    .bind(questionMediaId)
    .run();
}

export async function createAnswerMedia(
  db: D1Database,
  input: {
    answerId: number;
    mediaAssetId: number;
    sortOrder?: number;
  },
): Promise<void> {
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO answer_media (
        answer_id, media_asset_id, sort_order, created_at
      ) VALUES (?, ?, ?, ?)`,
    )
    .bind(input.answerId, input.mediaAssetId, input.sortOrder ?? 0, timestamp)
    .run();
}

export async function getAnswerMediaByAnswerId(
  db: D1Database,
  answerId: number,
): Promise<Array<{ id: number; mediaAssetId: number; sortOrder: number }>> {
  const result = await db
    .prepare(
      `SELECT id, media_asset_id, sort_order
       FROM answer_media
       WHERE answer_id = ?
       ORDER BY sort_order ASC, id ASC`,
    )
    .bind(answerId)
    .all<{ id: number; media_asset_id: number; sort_order: number }>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    mediaAssetId: row.media_asset_id,
    sortOrder: row.sort_order,
  }));
}

export async function createOptionMedia(
  db: D1Database,
  input: {
    questionOptionId: number;
    mediaAssetId: number;
    sortOrder?: number;
  },
): Promise<void> {
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO option_media (
        question_option_id, media_asset_id, sort_order, created_at
      ) VALUES (?, ?, ?, ?)`,
    )
    .bind(input.questionOptionId, input.mediaAssetId, input.sortOrder ?? 0, timestamp)
    .run();
}

export async function getOptionMediaByOptionId(
  db: D1Database,
  questionOptionId: number,
): Promise<Array<{ id: number; mediaAssetId: number; sortOrder: number }>> {
  const result = await db
    .prepare(
      `SELECT id, media_asset_id, sort_order
       FROM option_media
       WHERE question_option_id = ?
       ORDER BY sort_order ASC, id ASC`,
    )
    .bind(questionOptionId)
    .all<{ id: number; media_asset_id: number; sort_order: number }>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    mediaAssetId: row.media_asset_id,
    sortOrder: row.sort_order,
  }));
}

export interface TemporaryMediaRow {
  id: number;
  storageKey: string | null;
  expiresAt: string | null;
}

/** Temporary (KV-backed) media linked to a response, newest first. */
export async function listTemporaryMediaByResponse(
  db: D1Database,
  responseId: number,
): Promise<TemporaryMediaRow[]> {
  const result = await db
    .prepare(
      `SELECT m.id, m.storage_key storageKey, m.expires_at expiresAt
       FROM media_assets m
       JOIN answer_media am ON am.media_asset_id = m.id
       JOIN answers a ON a.id = am.answer_id
       JOIN survey_responses r ON r.id = a.response_id
       WHERE r.id = ? AND m.storage_kind = 'temporary'
       ORDER BY m.id DESC`,
    )
    .bind(responseId)
    .all<TemporaryMediaRow>();
  return result.results ?? [];
}

export async function sumTemporaryMediaBytesForResponse(
  db: D1Database,
  responseId: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(m.file_size), 0) AS total
       FROM media_assets m
       JOIN answer_media am ON am.media_asset_id = m.id
       JOIN answers a ON a.id = am.answer_id
       JOIN survey_responses r ON r.id = a.response_id
       WHERE r.id = ? AND m.storage_kind = 'temporary'
         AND m.storage_key IS NOT NULL`,
    )
    .bind(responseId)
    .first<{ total: number | null }>();
  return Number(row?.total ?? 0);
}

/** Marks an asset as expired and detaches its blob reference. Callers delete
 * the underlying object first; the row (and answer linkage) is preserved so
 * structured answers stay traceable after the image is gone. */
export async function expireMediaAsset(
  db: D1Database,
  id: number,
  expiredAt = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE media_assets
       SET storage_key = NULL, expires_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(expiredAt, new Date().toISOString(), id)
    .run();
}

export async function listOptionMediaByOptionIds(
  db: D1Database,
  questionOptionIds: number[],
): Promise<
  Array<{
    id: number;
    questionOptionId: number;
    mediaAssetId: number;
    sortOrder: number;
  }>
> {
  const uniqueOptionIds = [...new Set(questionOptionIds)];
  if (uniqueOptionIds.length === 0) {
    return [];
  }

  const media: Array<{
    id: number;
    questionOptionId: number;
    mediaAssetId: number;
    sortOrder: number;
  }> = [];
  for (
    let start = 0;
    start < uniqueOptionIds.length;
    start += OPTION_ID_BATCH_SIZE
  ) {
    const optionIdBatch = uniqueOptionIds.slice(start, start + OPTION_ID_BATCH_SIZE);
    const placeholders = optionIdBatch.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT id, question_option_id, media_asset_id, sort_order
         FROM option_media
         WHERE question_option_id IN (${placeholders})
         ORDER BY question_option_id ASC, sort_order ASC, id ASC`,
      )
      .bind(...optionIdBatch)
      .all<{
        id: number;
        question_option_id: number;
        media_asset_id: number;
        sort_order: number;
      }>();
    media.push(
      ...(result.results ?? []).map((row) => ({
        id: row.id,
        questionOptionId: row.question_option_id,
        mediaAssetId: row.media_asset_id,
        sortOrder: row.sort_order,
      })),
    );
  }

  return media;
}

export async function deleteOptionMedia(
  db: D1Database,
  optionMediaId: number,
): Promise<void> {
  await db.prepare("DELETE FROM option_media WHERE id = ?").bind(optionMediaId).run();
}
