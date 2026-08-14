import type { MediaAsset, MediaType } from "../schema";

interface MediaAssetRow {
  id: number;
  media_type: string;
  telegram_file_id: string | null;
  telegram_file_unique_id: string | null;
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
    mediaType: row.media_type as MediaType,
    telegramFileId: row.telegram_file_id,
    telegramFileUniqueId: row.telegram_file_unique_id,
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
    mediaType: MediaType;
    telegramFileId?: string | null;
    telegramFileUniqueId?: string | null;
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
        media_type, telegram_file_id, telegram_file_unique_id,
        mime_type, file_name, file_size, width, height, duration,
        r2_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.mediaType,
      input.telegramFileId ?? null,
      input.telegramFileUniqueId ?? null,
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
