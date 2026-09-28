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

/** Remote images (editor-entered URLs) are inlined, but never unbounded. */
const MAX_REMOTE_IMAGE_BYTES = 12 * 1024 * 1024;

function bytesToDataUrl(bytes: Uint8Array, contentType: string): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * Reads the media asset id out of a stored image reference.
 *
 * Report image values reach the renderer in several shapes depending on how
 * they were configured: `{ mediaAssetId: 12 }` from uploaded answers,
 * `{ mediaAssetId: "12" }` after a JSON round-trip through older snapshots,
 * and a bare id. The single parser is shared by the web report and the
 * PDF/archive renderer so both resolve identical image sets.
 */
export function reportImageAssetId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return positiveInteger((value as { mediaAssetId?: unknown }).mediaAssetId);
  }
  return positiveInteger(value);
}

function telegramFileIdFromValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("data:image/")) return null;
  return value || null;
}

function isInlineImage(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/");
}

function isRemoteHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

async function resolveAssetDataUrl(env: ReportImagesEnv, asset: MediaAsset): Promise<string | null> {
  if (asset.storageKind === "temporary") {
    // A NULL/empty storage_key means the blob was already expired or discarded
    // (the retention sweep nulls it). Passing "" to KV throws
    // "Key name cannot be empty", which used to fail the WHOLE archive instead
    // of just skipping one missing image.
    if (!env.MEDIA_KV || !asset.storageKey) return null;
    const bytes = await new KVMediaStore(env.MEDIA_KV).get(asset.storageKey);
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
    const r2Key = asset.storageKey || asset.r2Key;
    if (!r2Key) return null;
    const object = await env.MEDIA.get(r2Key);
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

async function fetchRemoteImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const declaredLength = Number(response.headers.get("Content-Length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_IMAGE_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_REMOTE_IMAGE_BYTES) return null;
    const contentType = response.headers.get("Content-Type")?.split(";")[0]?.trim();
    return bytesToDataUrl(bytes, contentType || "image/jpeg");
  } catch {
    return null;
  }
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
  if (isInlineImage(value)) return value;
  const assetId = reportImageAssetId(value);
  if (assetId !== null) {
    const asset = assets.get(assetId);
    if (!asset) return null;
    return resolveAssetDataUrl(env, asset);
  }
  // Editor-entered image URLs are not media assets, so the old code fed them
  // to the Telegram downloader and dropped them. Inline them instead.
  if (isRemoteHttpUrl(value)) return fetchRemoteImageAsDataUrl(value);
  const fileId = telegramFileIdFromValue(value);
  if (!fileId) return null;
  try {
    const downloaded = await downloadTelegramFile(env.BOT_TOKEN, fileId);
    return bytesToDataUrl(downloaded.data, downloaded.contentType ?? "image/jpeg");
  } catch {
    return null;
  }
}

export interface ReportImageEntry {
  key: string;
  value: unknown;
}

/**
 * Every image a report snapshot references, in render order: named images
 * first, then the uploaded-photo gallery. Both the web report and the
 * PDF/archive renderer start from this list so a photo can never show up in
 * one output and silently vanish from the other.
 */
export function collectReportImageEntries(profile: ResultProfileSnapshot): ReportImageEntry[] {
  const entries: ReportImageEntry[] = [];
  for (const [key, value] of Object.entries(profile.images)) {
    if (key.startsWith("template.")) continue;
    entries.push({ key, value });
  }
  const gallery = Array.isArray(profile.metadata.gallery) ? profile.metadata.gallery : [];
  gallery.forEach((item, index) => entries.push({ key: `gallery.${index}`, value: item }));
  return entries;
}

/**
 * Keeps named keys verbatim (two keys may legitimately point at the same
 * asset) while collapsing gallery entries that duplicate an image already
 * emitted, so the gallery does not repeat an uploaded answer photo.
 */
export function assembleReportImages(
  entries: readonly ReportImageEntry[],
  resolved: ReadonlyArray<string | null>,
): Record<string, string> {
  const images: Record<string, string> = {};
  entries.forEach((entry, index) => {
    const value = resolved[index];
    if (!value) return;
    if (entry.key.startsWith("gallery.")) {
      if (Object.values(images).includes(value)) return;
      images[`gallery.${Object.keys(images).length}`] = value;
      return;
    }
    images[entry.key] = value;
  });
  return images;
}

/**
 * Resolves a single report image value to a self-contained data URL, covering
 * inlined data URLs, remote URLs, Telegram file ids and media assets. Used by
 * the web report for the references it cannot rewrite into a media link.
 */
export async function resolveReportImageToDataUrl(env: ReportImagesEnv, value: unknown): Promise<string | null> {
  if (isInlineImage(value)) return value;
  const assetId = reportImageAssetId(value);
  const assets = assetId === null ? new Map<number, MediaAsset>() : await getMediaAssetsByIds(env.DB, [assetId]);
  return resolveImageValue(env, value, assets);
}

/** Resolves a single media asset to an embeddable data URL (null if gone). */
export async function resolveMediaAssetDataUrl(env: ReportImagesEnv, assetId: number): Promise<string | null> {
  const asset = await getMediaAssetById(env.DB, assetId);
  if (!asset) return null;
  return resolveAssetDataUrl(env, asset);
}

/**
 * Runs `worker` over `items` with a fixed number of concurrent tasks. Shared
 * with the web report so neither renderer fans out unbounded subrequests when
 * a report references many remote images.
 */
export async function mapWithConcurrency<T, R>(
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
  const keyedValues = collectReportImageEntries(profile);

  const assetIds = keyedValues
    .map((entry) => reportImageAssetId(entry.value))
    .filter((id): id is number => id !== null);
  const assets = await getMediaAssetsByIds(env.DB, assetIds);

  const resolvedValues = await mapWithConcurrency(keyedValues, IMAGE_RESOLVE_CONCURRENCY, async (entry) => {
    try {
      return await resolveImageValue(env, entry.value, assets);
    } catch (error) {
      // Enforce the documented contract: one unreadable image is skipped, it
      // must never fail the whole archive/PDF. A storage hiccup on a single
      // photo used to abort report archiving entirely.
      console.warn("Report image skipped", { error });
      return null;
    }
  });
  return assembleReportImages(keyedValues, resolvedValues);
}
