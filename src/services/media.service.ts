import type { MediaAssetScope, MediaType } from "../db/schema";
import { createMediaAsset, findMediaAssetByTelegramUniqueId } from "../db/repositories/media.repository";
import type { BotContext, TelegramMediaFile, TelegramMessage } from "../bot/types";

function pickMedia(message: TelegramMessage): {
  type: MediaType;
  file: TelegramMediaFile;
} | null {
  if (message.photo?.[0]) {
    const photo = message.photo[message.photo.length - 1] ?? message.photo[0];
    return { type: "photo", file: photo };
  }

  if (message.video) {
    return { type: "video", file: message.video };
  }

  if (message.audio) {
    return { type: "audio", file: message.audio };
  }

  if (message.voice) {
    return { type: "voice", file: message.voice };
  }

  if (message.animation) {
    return { type: "animation", file: message.animation };
  }

  if (message.sticker) {
    return { type: "sticker", file: message.sticker };
  }

  if (message.document) {
    return { type: "document", file: message.document };
  }

  return null;
}

export async function registerMediaAsset(
  ctx: BotContext,
  message: TelegramMessage,
  options: { scope?: MediaAssetScope } = {},
): Promise<number | null> {
  const picked = pickMedia(message);
  if (!picked) {
    return null;
  }

  // Telegram 复用（0091）：同一份文件（file_unique_id 相同）只登记一个 asset，
  // 重复发送/多处绑定不再各建一行。首个命中行即返回。
  const existing = await findMediaAssetByTelegramUniqueId(ctx.db, picked.file.file_unique_id, picked.type);
  if (existing) {
    return existing.id;
  }

  const asset = await createMediaAsset(ctx.db, {
    scope: options.scope ?? "survey",
    mediaType: picked.type,
    telegramFileId: picked.file.file_id,
    telegramFileUniqueId: picked.file.file_unique_id,
    mimeType: picked.file.mime_type ?? null,
    fileName: picked.file.file_name ?? null,
    fileSize: picked.file.file_size ?? null,
    width: picked.file.width ?? null,
    height: picked.file.height ?? null,
    duration: picked.file.duration ?? null,
    r2Key: null,
  });

  return asset.id;
}
