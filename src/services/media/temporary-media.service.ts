import type { MediaAsset } from "../../db/schema";
import { createMediaAsset, expireMediaAsset, listTemporaryMediaByResponse, sumTemporaryMediaBytesForResponse } from "../../db/repositories/media.repository";
import type { TemporaryMediaStore } from "./temporary-media-store";

export const TEMP_MEDIA_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MAX_TEMP_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_RESPONSE_MEDIA_BYTES = 50 * 1024 * 1024;

export const TEMP_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export function temporaryMediaKey(responseId: number): string {
  return `media:temp:${responseId}:${crypto.randomUUID()}`;
}

export function temporaryMediaExpiry(now = new Date()): string {
  return new Date(now.getTime() + TEMP_MEDIA_TTL_SECONDS * 1000).toISOString();
}

/**
 * Persists a temporary response image: blob goes to the injected store, the
 * structured reference (with expiry) goes to D1. Returns the media asset row.
 */
export async function storeTemporaryMedia(
  db: D1Database,
  store: TemporaryMediaStore,
  input: {
    responseId: number;
    bytes: Uint8Array;
    mimeType: string;
    fileName: string | null;
  },
): Promise<MediaAsset> {
  const storageKey = temporaryMediaKey(input.responseId);
  const now = new Date();
  await store.put({
    storageKey,
    bytes: input.bytes,
    contentType: input.mimeType,
  });
  return createMediaAsset(db, {
    scope: "response",
    mediaType: "photo",
    mimeType: input.mimeType,
    fileName: input.fileName,
    fileSize: input.bytes.byteLength,
    storageKind: store.kind,
    storageKey,
    expiresAt: temporaryMediaExpiry(now),
  });
}

export async function readTemporaryMedia(
  store: TemporaryMediaStore,
  asset: Pick<MediaAsset, "storageKey" | "expiresAt">,
  now = new Date(),
): Promise<Uint8Array | null> {
  if (!asset.storageKey) return null;
  if (asset.expiresAt !== null && new Date(asset.expiresAt).getTime() <= now.getTime()) {
    return null;
  }
  return store.get(asset.storageKey);
}

/**
 * Deletes every temporary blob belonging to a response and detaches the
 * references. Call this only after the final report has been archived.
 * Returns the number of blobs deleted.
 */
export async function deleteTemporaryMediaForResponse(
  db: D1Database,
  store: TemporaryMediaStore,
  responseId: number,
): Promise<number> {
  const rows = await listTemporaryMediaByResponse(db, responseId);
  let deleted = 0;
  for (const row of rows) {
    if (row.storageKey) {
      await store.delete(row.storageKey);
      deleted += 1;
    }
    await expireMediaAsset(db, row.id);
  }
  return deleted;
}

export async function countTemporaryMediaBytesForResponse(
  db: D1Database,
  responseId: number,
): Promise<number> {
  return sumTemporaryMediaBytesForResponse(db, responseId);
}

export interface ExpiredMediaSummary {
  scanned: number;
  deleted: number;
}

/** Cron safety net: removes expired temporary blobs and detaches refs. */
export async function cleanupExpiredTemporaryMedia(
  db: D1Database,
  store: TemporaryMediaStore,
  now = new Date(),
): Promise<ExpiredMediaSummary> {
  const rows = await db
    .prepare(
      `SELECT id, storage_key storageKey
       FROM media_assets
       WHERE storage_kind = 'temporary'
         AND storage_key IS NOT NULL
         AND expires_at IS NOT NULL
         AND expires_at <= ?
       ORDER BY id ASC
       LIMIT 500`,
    )
    .bind(now.toISOString())
    .all<{ id: number; storageKey: string | null }>();
  let deleted = 0;
  for (const row of rows.results ?? []) {
    if (row.storageKey) {
      await store.delete(row.storageKey);
      deleted += 1;
    }
    await expireMediaAsset(db, row.id, now.toISOString());
  }
  return { scanned: (rows.results ?? []).length, deleted };
}
