import type { MediaAsset, MediaType } from "../../db/schema";
import {
  createMediaAsset,
  expireMediaAsset,
  listRetainableCompletedMedia,
  listResponseMediaForPromotion,
  listTemporaryMediaByResponse,
  markMediaAssetDurable,
  sumTemporaryMediaBytesForResponse,
  type TemporaryMediaRow,
} from "../../db/repositories/media.repository";
import type { TemporaryMediaStore } from "./temporary-media-store";

export const TEMP_MEDIA_TTL_SECONDS = 7 * 24 * 60 * 60;
/**
 * KV-side orphan backstop for temporary blobs. Deliberately much longer than
 * {@link TEMP_MEDIA_TTL_SECONDS}: a completed response's photo can only be
 * rescued by the daily retention sweep while its blob still exists, so this
 * window must absorb a backlog of un-promoted rows rather than race it.
 */
export const TEMP_MEDIA_KV_BACKSTOP_SECONDS = 30 * 24 * 60 * 60;
export const MAX_TEMP_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_RESPONSE_MEDIA_BYTES = 50 * 1024 * 1024;

/**
 * Prefix for attachments that have graduated out of the temporary namespace.
 * Unlike `media:temp:*` these keys carry no expiry, so a finished response's
 * photos stay viewable in the admin and web report long after the 7-day
 * retention window for in-progress uploads has passed.
 */
export const DURABLE_RESPONSE_MEDIA_PREFIX = "media:report:";

export const TEMP_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export function temporaryMediaKey(responseId: number): string {
  return `media:temp:${responseId}:${crypto.randomUUID()}`;
}

export function durableResponseMediaKey(responseId: number): string {
  return `${DURABLE_RESPONSE_MEDIA_PREFIX}${responseId}:${crypto.randomUUID()}`;
}

export function temporaryMediaExpiry(now = new Date(), ttlSeconds = TEMP_MEDIA_TTL_SECONDS): string {
  return new Date(now.getTime() + ttlSeconds * 1000).toISOString();
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
    mediaType?: MediaType;
    ttlSeconds?: number;
  },
): Promise<MediaAsset> {
  const storageKey = temporaryMediaKey(input.responseId);
  const now = new Date();
  const ttlSeconds = input.ttlSeconds ?? TEMP_MEDIA_TTL_SECONDS;
  // The KV TTL is only an orphan backstop, NOT the media lifetime — that is
  // `expires_at` in D1. It must stay comfortably longer than the media TTL,
  // because the rescue path (`retainFinishedResponseMedia`, daily, bounded
  // batch) can only promote a completed response's photo while the blob still
  // exists. Matching the two windows meant a backlog larger than one sweep lost
  // the photos for good.
  const kvBackstopSeconds = Math.max(ttlSeconds, TEMP_MEDIA_KV_BACKSTOP_SECONDS);
  await store.put({
    storageKey,
    bytes: input.bytes,
    contentType: input.mimeType,
    expirationTtl: kvBackstopSeconds,
  });
  return createMediaAsset(db, {
    scope: "response",
    mediaType: input.mediaType ?? "photo",
    mimeType: input.mimeType,
    fileName: input.fileName,
    fileSize: input.bytes.byteLength,
    storageKind: store.kind,
    storageKey,
    expiresAt: temporaryMediaExpiry(now, input.ttlSeconds),
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

export interface PromoteResponseMediaSummary {
  /** Blobs moved out of the temporary namespace into long-lived storage. */
  promoted: number;
  /** Blobs already durable (promotion re-run) — not rewritten. */
  alreadyDurable: number;
  /** Blobs that were already gone; their references were detached. */
  discarded: number;
}

/**
 * Retains a completed response's attachments.
 *
 * Response media is uploaded into the temporary namespace (`media:temp:*`,
 * 7-day TTL) because abandoning a draft must not leave blobs behind forever.
 * A *finished* response is different: its photos are part of the answer
 * record, and the web report plus the admin answer preview read them live, so
 * once the TTL lapses those previews silently lose their images. This copies
 * each blob to durable storage and re-points the existing asset row at it —
 * same asset id, so every answer reference, report snapshot and report URL
 * keeps working without any migration.
 *
 * Safe to re-run: rows already promoted (`expires_at IS NULL`) are left
 * alone, and a blob that is already gone detaches instead of throwing.
 */
export async function promoteResponseMediaToDurable(
  db: D1Database,
  store: TemporaryMediaStore,
  responseId: number,
): Promise<PromoteResponseMediaSummary> {
  const rows = await listResponseMediaForPromotion(db, responseId);
  const summary: PromoteResponseMediaSummary = { promoted: 0, alreadyDurable: 0, discarded: 0 };
  for (const row of rows) {
    await promoteMediaRow(db, store, responseId, row, summary);
  }
  return summary;
}

async function promoteMediaRow(
  db: D1Database,
  store: TemporaryMediaStore,
  responseId: number,
  row: TemporaryMediaRow,
  summary: PromoteResponseMediaSummary,
): Promise<void> {
  if (row.expiresAt === null && row.storageKey?.startsWith(DURABLE_RESPONSE_MEDIA_PREFIX)) {
    summary.alreadyDurable += 1;
    return;
  }
  const previousKey = row.storageKey;
  if (!previousKey) {
    await expireMediaAsset(db, row.id);
    summary.discarded += 1;
    return;
  }
  const bytes = await store.get(previousKey);
  if (!bytes) {
    await expireMediaAsset(db, row.id);
    summary.discarded += 1;
    return;
  }
  const durableKey = durableResponseMediaKey(responseId);
  await store.put({ storageKey: durableKey, bytes, contentType: row.mimeType ?? "application/octet-stream" });
  await markMediaAssetDurable(db, row.id, durableKey);
  if (previousKey !== durableKey) await store.delete(previousKey).catch(() => undefined);
  summary.promoted += 1;
}

/**
 * How many still-temporary attachments one scheduled sweep retains. The cleanup
 * sweep now skips completed/archived responses, so this batch only controls how
 * fast a legacy backlog drains (not whether data survives); 100 keeps the daily
 * run bounded while draining faster than the old 25.
 */
export const MEDIA_RETENTION_SWEEP_BATCH_SIZE = 100;

/**
 * Cron backfill for responses that finished before retention existed (or
 * whose submit-time promotion failed): every sweep moves a bounded batch of
 * finished responses' attachments out of the expiring namespace, so their
 * report previews stop going blank one TTL window after submission.
 * Run this *before* the expired-media cleanup so a blob that is already past
 * its expiry can still be rescued.
 */
export async function retainFinishedResponseMedia(
  db: D1Database,
  store: TemporaryMediaStore,
  limit = MEDIA_RETENTION_SWEEP_BATCH_SIZE,
): Promise<PromoteResponseMediaSummary & { responses: number; scanned: number }> {
  const rows = await listRetainableCompletedMedia(db, limit);
  const summary: PromoteResponseMediaSummary & { responses: number; scanned: number } = {
    promoted: 0,
    alreadyDurable: 0,
    discarded: 0,
    responses: 0,
    scanned: rows.length,
  };
  const responses = new Set<number>();
  for (const row of rows) {
    await promoteMediaRow(db, store, row.responseId, row, summary);
    responses.add(row.responseId);
  }
  summary.responses = responses.size;
  return summary;
}

export async function countTemporaryMediaBytesForResponse(db: D1Database, responseId: number): Promise<number> {
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
      `SELECT m.id, m.storage_key storageKey
       FROM media_assets m
       WHERE m.storage_kind = 'temporary'
         AND m.storage_key IS NOT NULL
         AND m.expires_at IS NOT NULL
         AND m.expires_at <= ?
         AND NOT EXISTS (
           SELECT 1
             FROM answer_media am
             JOIN answers a ON a.id = am.answer_id
             JOIN survey_responses r ON r.id = a.response_id
            WHERE am.media_asset_id = m.id
              AND r.status IN ('completed', 'archived')
         )
       ORDER BY m.id ASC
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
