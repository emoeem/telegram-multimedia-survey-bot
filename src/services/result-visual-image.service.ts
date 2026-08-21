import { downloadTelegramFile } from "../bot/telegram";
import { getMediaAssetById } from "../db/repositories/media.repository";
import type { ResultJsonValue, ResultProfileSnapshot } from "../result/schema";
import type { VisualTemplateDefinition } from "../visual-template/schema";
export const TEMPLATE_BACKGROUND_IMAGE_KEY = "template.background_asset";

const maxVisualImageBytes = 8 * 1024 * 1024;
const maxVisualImagePixels = 64_000_000;
const expression = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/;

function bytesToDataUrl(bytes: Uint8Array, contentType: string): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

function detectedImageContentType(
  data: Uint8Array,
  responseContentType: string,
  filePath: string,
): string | null {
  const contentType = responseContentType.toLowerCase().split(";", 1)[0]!.trim();
  if (contentType.startsWith("image/")) return contentType;

  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6 && String.fromCharCode(...data.subarray(0, 6)) === "GIF87a") return "image/gif";
  if (data.length >= 6 && String.fromCharCode(...data.subarray(0, 6)) === "GIF89a") return "image/gif";
  if (data.length >= 12 && String.fromCharCode(...data.subarray(0, 4)) === "RIFF" && String.fromCharCode(...data.subarray(8, 12)) === "WEBP") {
    return "image/webp";
  }

  const extension = filePath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return null;
}

function resolveProfileValue(
  profile: ResultProfileSnapshot,
  path: string,
): ResultJsonValue | undefined {
  const segments = path.split(".");
  if (segments[0] !== "result") return undefined;
  let value: unknown;
  switch (segments[1]) {
    case "title": value = profile.title; break;
    case "subtitle": value = profile.subtitle; break;
    case "images": value = profile.images; break;
    case "fields":
      value = Object.fromEntries(Object.entries(profile.fields).map(([key, field]) => [key, field.value]));
      break;
    case "metadata": value = profile.metadata; break;
    default: return undefined;
  }
  for (const segment of segments.slice(2)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value as ResultJsonValue | undefined;
}

function telegramFileId(value: ResultJsonValue): string | null {
  if (typeof value === "string") {
    return value.startsWith("data:image/") || value.includes("://") ? null : value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value.telegramFileId;
  return typeof candidate === "string" ? candidate : null;
}

function mediaAssetId(value: ResultJsonValue): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value.mediaAssetId;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0
    ? candidate
    : null;
}

async function downloadImageDataUrl(botToken: string, fileId: string): Promise<string> {
  const downloaded = await downloadTelegramFile(botToken, fileId);
  if (downloaded.data.byteLength > maxVisualImageBytes) {
    throw new Error("视觉模板图片超过 8 MB 限制");
  }
  const contentType = detectedImageContentType(
    downloaded.data,
    downloaded.contentType,
    downloaded.filePath,
  );
  if (!contentType) {
    throw new Error("视觉模板资源必须是图片");
  }
  return bytesToDataUrl(downloaded.data, contentType);
}

async function resolveAssetImage(
  db: D1Database,
  botToken: string,
  assetId: number,
  allowedScopes: readonly string[] = ["survey", "response", "template", "identity_card", "legacy"],
): Promise<string> {
  const asset = await getMediaAssetById(db, assetId);
  if (!asset?.telegramFileId) throw new Error("视觉模板背景资源不存在或没有 Telegram file_id");
  if (!allowedScopes.includes(asset.scope ?? "legacy")) throw new Error("该媒体属于问卷/答卷素材，不能作为模板背景使用");
  if (asset.mediaType !== "photo" && !asset.mimeType?.toLowerCase().startsWith("image/")) {
    throw new Error("视觉模板背景资源必须是图片");
  }
  if ((asset.fileSize ?? 0) > maxVisualImageBytes) {
    throw new Error("视觉模板背景资源超过 8 MB 限制");
  }
  if (asset.width && asset.height && asset.width * asset.height > maxVisualImagePixels) {
    throw new Error("视觉模板图片像素过大，请上传不超过 6400 万像素的图片");
  }
  return downloadImageDataUrl(botToken, asset.telegramFileId);
}

export async function resolveResultVisualImages(
  db: D1Database,
  botToken: string,
  template: VisualTemplateDefinition,
  profile: ResultProfileSnapshot,
): Promise<Record<string, string>> {
  const images: Record<string, string> = {};
  const cache = new Map<string, Promise<string>>();
  const loadFile = (fileId: string): Promise<string> => {
    const existing = cache.get(fileId);
    if (existing) return existing;
    const loading = downloadImageDataUrl(botToken, fileId);
    cache.set(fileId, loading);
    return loading;
  };

  if (template.background.type === "telegram_asset") {
    try {
      images[TEMPLATE_BACKGROUND_IMAGE_KEY] = await resolveAssetImage(
      db,
      botToken,
      template.background.assetId,
      profile.resultType === "identity_card" ? ["identity_card", "template", "legacy"] : ["template", "legacy"],
      );
    } catch (error) {
      // A background should never prevent delivery of the user's report.
      // The renderer will retain its readable content card without the photo.
      console.warn("Skipping unavailable visual report background image", { error });
    }
  }

  for (const element of template.elements) {
    if (element.type !== "image" || !element.source) continue;
    const path = expression.exec(element.source)?.[1];
    if (!path || images[path]) continue;
    const value = resolveProfileValue(profile, path);
    if (typeof value === "string" && value.startsWith("data:image/")) {
      images[path] = value;
      continue;
    }
    const assetId = value === undefined ? null : mediaAssetId(value);
    if (assetId !== null) {
      images[path] = await resolveAssetImage(db, botToken, assetId);
      continue;
    }
    const fileId = value === undefined ? null : telegramFileId(value);
    if (fileId) images[path] = await loadFile(fileId);
  }

  for (const section of template.sections ?? []) {
    if (section.type !== "gallery" || !section.source) continue;
    const path = expression.exec(section.source)?.[1];
    if (!path) continue;
    const value = resolveProfileValue(profile, path);
    const items = Array.isArray(value)
      ? value
      : value && typeof value === "object"
        ? Object.values(value)
        : [];
    for (const [index, item] of items.entries()) {
      const key = `${path}.${index}`;
      if (images[key]) continue;
      if (typeof item === "string" && item.startsWith("data:image/")) {
        images[key] = item;
        continue;
      }
      const assetId = mediaAssetId(item);
      try {
        if (assetId !== null) {
          images[key] = await resolveAssetImage(db, botToken, assetId);
          continue;
        }
        const fileId = telegramFileId(item);
        if (fileId) images[key] = await loadFile(fileId);
      } catch (error) {
        console.warn("Skipping unavailable visual report gallery image", { path: key, error });
      }
    }
  }
  return images;
}
