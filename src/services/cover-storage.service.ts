import { decodeDataUrl } from "./import.service";
import { KVMediaStore } from "./media/temporary-media-store";

/**
 * One-shot self-heal: survey covers backfilled as base64 data URLs live inside
 * D1 rows and bloat the database. Move them into MEDIA_KV through the Worker's
 * own runtime binding — the only KV path guaranteed to match what
 * buildMediaResponse reads. Idempotent: once a cover row is `temporary` it is
 * skipped, so the scheduled task becomes a cheap no-op afterwards.
 */
export async function migrateDataUrlCoversToKv(db: D1Database, env: { MEDIA_KV: KVNamespace }): Promise<number> {
  const store = new KVMediaStore(env.MEDIA_KV);
  const rows = await db
    .prepare(
      `SELECT m.id, m.url, m.mime_type mimeType, m.file_name fileName,
              m.width, m.height
       FROM media_assets m
       JOIN surveys s ON s.cover_media_id = m.id
       WHERE m.storage_kind = 'url' AND m.url LIKE 'data:%'`,
    )
    .all<{
      id: number;
      url: string;
      mimeType: string | null;
      fileName: string | null;
      width: number | null;
      height: number | null;
    }>();

  let migrated = 0;
  for (const row of rows.results ?? []) {
    const decoded = decodeDataUrl(row.url);
    if (!decoded) continue;
    const storageKey = `media:import:${crypto.randomUUID()}`;
    const contentType = row.mimeType ?? decoded.mimeType;
    await store.put({
      storageKey,
      bytes: decoded.bytes,
      contentType,
    });
    await db
      .prepare(
        `UPDATE media_assets
         SET storage_kind = 'temporary', storage_key = ?, url = NULL,
             mime_type = ?, file_size = ?, width = ?, height = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        storageKey,
        contentType,
        decoded.bytes.byteLength,
        row.width ?? null,
        row.height ?? null,
        new Date().toISOString(),
        row.id,
      )
      .run();
    migrated += 1;
  }
  return migrated;
}
