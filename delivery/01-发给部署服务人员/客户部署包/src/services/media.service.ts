import type { MediaType } from "../db/schema";
import { createMediaAsset } from "../db/repositories/media.repository";
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
): Promise<number | null> {
  const picked = pickMedia(message);
  if (!picked) {
    return null;
  }

  const asset = await createMediaAsset(ctx.db, {
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
