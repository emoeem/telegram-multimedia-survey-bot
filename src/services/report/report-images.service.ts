import type { MediaAsset } from "../../db/schema";
import { getMediaAssetById } from "../../db/repositories/media.repository";
import { downloadTelegramFile } from "../../bot/telegram";
import { KVMediaStore } from "../media/temporary-media-store";
import type { ResultProfileSnapshot, ResultJsonValue } from "../../result/schema";

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

async function resolveAssetDataUrl(
  env: ReportImagesEnv,
  asset: MediaAsset,
): Promise<string | null> {
  if (asset.storageKind === "temporary") {
    if (!env.MEDIA_KV) return null;
    const bytes = await new KVMediaStore(env.MEDIA_KV).get(asset.storageKey ?? "");
    if (!bytes) return null;
    return bytesToDataUrl(bytes, asset.mimeType ?? "image/jpeg");
  }
  if (asset.telegramFileId) {
    try {
      const downloaded = await downloadTelegramFile(env.BOT_TOKEN, asset.telegramFileId);
      return bytesToDataUrl(
        downloaded.data,
        asset.mimeType ?? downloaded.contentType ?? "image/jpeg",
      );
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

async function resolveImageValue(
  env: ReportImagesEnv,
  value: unknown,
): Promise<string | null> {
  if (typeof value === "string" && value.startsWith("data:image/")) return value;
  const assetId = mediaAssetIdFromValue(value);
  if (assetId !== null) {
    const asset = await getMediaAssetById(env.DB, assetId);
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

/**
 * Resolves every image referenced by a ResultProfile into embeddable data
 * URLs for PDF/archive rendering, covering temporary KV, Telegram and future
 * R2 storage. Unavailable images are skipped so archiving never fails.
 */
export async function resolveReportProfileImages(
  env: ReportImagesEnv,
  profile: ResultProfileSnapshot,
): Promise<Record<string, string>> {
  const images: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile.images)) {
    if (key.startsWith("template.")) continue;
    const resolved = await resolveImageValue(env, value);
    if (resolved) images[key] = resolved;
  }
  const gallery = Array.isArray(profile.metadata.gallery)
    ? profile.metadata.gallery
    : [];
  for (const item of gallery as ResultJsonValue[]) {
    const resolved = await resolveImageValue(env, item);
    if (resolved && !Object.values(images).includes(resolved)) {
      images[`gallery.${Object.keys(images).length}`] = resolved;
    }
  }
  return images;
}
