import type { MediaAsset } from "../../db/schema";
import { getMediaAssetById, getMediaAssetsByIds } from "../../db/repositories/media.repository";
import { downloadTelegramFile } from "../../bot/telegram";
import { KVMediaStore } from "../media/temporary-media-store";
import type { ResultProfileSnapshot } from "../../result/schema";

export interface ReportImagesEnv {
  DB: D1Database;
  BOT_TOKEN: string;
  MEDIA_KV?: KVNamespace;
  MEDIA?: R2Bucket;
}

function bytesToDataUrl(bytes: Uint8Array, contentType: string): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

function mediaAssetIdFromValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = (value as { mediaAssetId?: unknown }).mediaAssetId;
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return null;
}

function telegramFileIdFromValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("data:image/")) return null;
  return value || null;
}

async function resolveAssetDataUrl(env: ReportImagesEnv, asset: MediaAsset): Promise<string | null> {
  if (asset.storageKind === "temporary") {
    if (!env.MEDIA_KV) return null;
    const bytes = await new KVMediaStore(env.MEDIA_KV).get(asset.storageKey ?? "");
    if (!bytes) return null;
    return bytesToDataUrl(bytes, asset.mimeType ?? "image/jpeg");
  }
  if (asset.telegramFileId) {
    try {
      const downloaded = await downloadTelegramFile(env.BOT_TOKEN, asset.telegramFileId);
      return bytesToDataUrl(downloaded.data, asset.mimeType ?? downloaded.contentType ?? "image/jpeg");
    } catch {
      return null;
    }
  }
  if (asset.storageKind === "r2" && env.MEDIA) {
    const object = await env.MEDIA.get(asset.storageKey ?? asset.r2Key ?? "");
    if (!object) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    return bytesToDataUrl(bytes, asset.mimeType ?? "image/jpeg");
  }
  if (asset.url) {
    try {
      const response = await fetch(asset.url);
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytesToDataUrl(bytes, asset.mimeType ?? response.headers.get("Content-Type") ?? "image/jpeg");
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolves one image value against an asset map prepared by the caller.
 *
 * The map is what turns a report with N referenced images from N sequential
 * `SELECT ... WHERE id = ?` statements into a single batched lookup.
 */
async function resolveImageValue(
  env: ReportImagesEnv,
  value: unknown,
  assets: Map<number, MediaAsset>,
): Promise<string | null> {
  if (typeof value === "string" && value.startsWith("data:image/")) return value;
  const assetId = mediaAssetIdFromValue(value);
  if (assetId !== null) {
    const asset = assets.get(assetId);
    if (!asset) return null;
    return resolveAssetDataUrl(env, asset);
  }
  const fileId = telegramFileIdFromValue(value);
  if (!fileId) return null;
  try {
    const downloaded = await downloadTelegramFile(env.BOT_TOKEN, fileId);
    return bytesToDataUrl(downloaded.data, downloaded.contentType ?? "image/jpeg");
  } catch {
    return null;
  }
}

/** Resolves a single media asset to an embeddable data URL (null if gone). */
export async function resolveMediaAssetDataUrl(env: ReportImagesEnv, assetId: number): Promise<string | null> {
  const asset = await getMediaAssetById(env.DB, assetId);
  if (!asset) return null;
  return resolveAssetDataUrl(env, asset);
}

/** Runs `worker` over `items` with a fixed number of concurrent tasks. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runNext = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      const item = items[index] as T;
      results[index] = await worker(item, index);
    }
  };
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, runNext);
  await Promise.all(runners);
  return results;
}

/** How many images may be fetched from KV/Telegram/R2 at the same time. */
const IMAGE_RESOLVE_CONCURRENCY = 4;

/**
 * Resolves every image referenced by a ResultProfile into embeddable data
 * URLs for PDF/archive rendering, covering temporary KV, Telegram and future
 * R2 storage. Unavailable images are skipped so archiving never fails.
 */
export async function resolveReportProfileImages(
  env: ReportImagesEnv,
  profile: ResultProfileSnapshot,
): Promise<Record<string, string>> {
  // Collect every value that needs resolving first so the referenced media
  // rows are loaded in one batched query instead of one SELECT per image.
  const keyedValues: Array<{ key: string; value: unknown }> = [];
  for (const [key, value] of Object.entries(profile.images)) {
    if (key.startsWith("template.")) continue;
    keyedValues.push({ key, value });
  }
  const gallery = Array.isArray(profile.metadata.gallery) ? profile.metadata.gallery : [];
  gallery.forEach((item, index) => keyedValues.push({ key: `gallery.${index}`, value: item }));

  const assetIds = keyedValues
    .map((entry) => mediaAssetIdFromValue(entry.value))
    .filter((id): id is number => id !== null);
  const assets = await getMediaAssetsByIds(env.DB, assetIds);

  const images: Record<string, string> = {};
  const resolvedValues = await mapWithConcurrency(
    keyedValues as Array<{ key: string; value: unknown }>,
    IMAGE_RESOLVE_CONCURRENCY,
    (entry) => resolveImageValue(env, entry.value, assets),
  );
  keyedValues.forEach((entry, index) => {
    const resolved = resolvedValues[index];
    if (!resolved) return;
    // Named profile images always keep their key (two keys may legitimately
    // point at the same asset). Gallery entries are anonymous, so an image
    // already emitted under another key is skipped, exactly as before.
    if (entry.key.startsWith("gallery.")) {
      if (Object.values(images).includes(resolved)) return;
      images[`gallery.${Object.keys(images).length}`] = resolved;
      return;
    }
    images[entry.key] = resolved;
  });
  return images;
}
