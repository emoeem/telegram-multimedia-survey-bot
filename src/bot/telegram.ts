import type { TelegramMediaFile } from "./types";

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

async function assertTelegramResponse(
  response: Response,
  method: string,
): Promise<Response> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram ${method} failed: ${response.status} ${body}`);
  }

  return response;
}

export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<Response> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
    }),
  });

  return assertTelegramResponse(response, "sendMessage");
}

export function splitTelegramText(
  text: string,
  maxLength = 3900,
): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength + 1);
    let splitAt = window.lastIndexOf("\n\n");
    if (splitAt < Math.floor(maxLength * 0.5)) {
      splitAt = window.lastIndexOf("\n");
    }
    if (splitAt < Math.floor(maxLength * 0.5)) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export async function sendLongMessage(
  botToken: string,
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
  const chunks = splitTelegramText(text);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk) continue;
    await sendMessage(
      botToken,
      chatId,
      chunk,
      index === chunks.length - 1 ? replyMarkup : undefined,
    );
  }
}

export async function editMessageReplyMarkup(
  botToken: string,
  chatId: number,
  messageId: number,
  replyMarkup: InlineKeyboardMarkup,
): Promise<Response> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    }),
  });

  return assertTelegramResponse(response, "editMessageReplyMarkup");
}

export async function sendDocument(
  botToken: string,
  chatId: number,
  fileName: string,
  content: Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<Response> {
  const formData = new FormData();
  formData.append("chat_id", String(chatId));
  formData.append(
    "document",
    new Blob([content as BlobPart], { type: contentType }),
    fileName,
  );

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    body: formData,
  });

  return assertTelegramResponse(response, "sendDocument");
}

export async function sendDocumentByFileId(
  botToken: string,
  chatId: number,
  document: string,
  caption?: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<Response> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      document,
      caption,
      reply_markup: replyMarkup,
    }),
  });

  return assertTelegramResponse(response, "sendDocument");
}

async function getTelegramFilePath(
  botToken: string,
  fileId: string,
): Promise<string> {
  const infoResponse = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );

  if (!infoResponse.ok) {
    throw new Error(`Telegram getFile failed: ${infoResponse.status}`);
  }

  const info = (await infoResponse.json()) as {
    ok?: boolean;
    result?: { file_path?: string };
  };

  const filePath = info.result?.file_path;
  if (!filePath) {
    throw new Error("Telegram file_path is missing");
  }

  return filePath;
}

export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
): Promise<{
  data: Uint8Array;
  contentType: string;
  filePath: string;
}> {
  const filePath = await getTelegramFilePath(botToken, fileId);
  const fileResponse = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${filePath}`,
  );

  if (!fileResponse.ok) {
    throw new Error(`Telegram file download failed: ${fileResponse.status}`);
  }

  return {
    data: new Uint8Array(await fileResponse.arrayBuffer()),
    contentType:
      fileResponse.headers.get("Content-Type") ?? "application/octet-stream",
    filePath,
  };
}

export async function getTelegramFileText(
  botToken: string,
  fileId: string,
): Promise<string> {
  const downloaded = await downloadTelegramFile(botToken, fileId);
  return new TextDecoder().decode(downloaded.data);
}

export interface ImportedTelegramMedia {
  type:
    | "photo"
    | "video"
    | "audio"
    | "voice"
    | "animation"
    | "gif"
    | "document";
  url?: string;
  telegramFileId?: string;
  telegramFileUniqueId?: string;
  mimeType?: string;
  fileName?: string;
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
}

export interface UploadedTelegramMedia {
  messageId: number | null;
  file: TelegramMediaFile;
}

function decodeDataUrl(url: string): {
  bytes: Uint8Array;
  mimeType: string;
} {
  const match = url.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) {
    throw new Error("图片数据格式无效");
  }

  const mimeType = match[1] || "application/octet-stream";
  const payload = match[3] ?? "";
  if (match[2]) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return { bytes, mimeType };
  }

  return {
    bytes: new TextEncoder().encode(decodeURIComponent(payload)),
    mimeType,
  };
}

export async function uploadMediaForReuse(
  botToken: string,
  chatId: number,
  media: ImportedTelegramMedia,
): Promise<UploadedTelegramMedia> {
  if (media.telegramFileId) {
    const file: TelegramMediaFile = {
      file_id: media.telegramFileId,
      file_unique_id:
        media.telegramFileUniqueId ?? media.telegramFileId,
    };
    if (media.mimeType) file.mime_type = media.mimeType;
    if (media.fileName) file.file_name = media.fileName;
    if (media.size !== undefined) file.file_size = media.size;
    if (media.width !== undefined) file.width = media.width;
    if (media.height !== undefined) file.height = media.height;
    if (media.duration !== undefined) file.duration = media.duration;
    return {
      messageId: null,
      file,
    };
  }

  if (!media.url) {
    throw new Error("媒体缺少可导入的数据");
  }
  if (
    !media.url.startsWith("data:") &&
    !media.url.startsWith("https://") &&
    !media.url.startsWith("http://")
  ) {
    throw new Error(
      "JSON 中的图片仍是本地路径，请使用新版 PDF 转换脚本重新生成 survey.json",
    );
  }

  const methodByType = {
    photo: ["sendPhoto", "photo", "photo"],
    video: ["sendVideo", "video", "video"],
    audio: ["sendAudio", "audio", "audio"],
    voice: ["sendVoice", "voice", "voice"],
    animation: ["sendAnimation", "animation", "animation"],
    gif: ["sendAnimation", "animation", "animation"],
    document: ["sendDocument", "document", "document"],
  } as const;
  const [method, formField, resultField] = methodByType[media.type];
  const decoded = media.url.startsWith("data:")
    ? decodeDataUrl(media.url)
    : null;
  type UploadPayload = {
    ok?: boolean;
    description?: string;
    parameters?: { retry_after?: number };
    result?: {
      message_id?: number;
      photo?: TelegramMediaFile[];
      video?: TelegramMediaFile;
      audio?: TelegramMediaFile;
      voice?: TelegramMediaFile;
      animation?: TelegramMediaFile;
      document?: TelegramMediaFile;
    };
  };

  let payload: UploadPayload | null = null;
  let responseStatus = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append("disable_notification", "true");
    if (decoded) {
      formData.append(
        formField,
        new Blob([decoded.bytes as BlobPart], {
          type: media.mimeType ?? decoded.mimeType,
        }),
        media.fileName ?? `imported-${media.type}`,
      );
    } else {
      formData.append(formField, media.url);
    }

    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/${method}`,
      {
        method: "POST",
        body: formData,
      },
    );
    responseStatus = response.status;
    payload = (await response.json()) as UploadPayload;
    if (response.ok && payload.ok && payload.result) {
      break;
    }

    const retryAfter = payload.parameters?.retry_after;
    if (
      response.status !== 429 ||
      attempt === 2 ||
      typeof retryAfter !== "number"
    ) {
      break;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, retryAfter) * 1000),
    );
  }

  if (!payload?.ok || !payload.result) {
    throw new Error(
      `Telegram 媒体上传失败：${payload?.description ?? responseStatus}`,
    );
  }

  const resultValue = payload.result[resultField];
  const file = Array.isArray(resultValue)
    ? resultValue[resultValue.length - 1]
    : resultValue;
  if (!file) {
    throw new Error("Telegram 没有返回可复用的媒体文件 ID");
  }

  return {
    messageId: payload.result.message_id ?? null,
    file,
  };
}

export async function deleteMessage(
  botToken: string,
  chatId: number,
  messageId: number,
): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/deleteMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
      }),
    },
  );
  if (!response.ok) {
    console.warn("Failed to delete temporary import message", response.status);
  }
}

export async function sendPhoto(
  botToken: string,
  chatId: number,
  photo: string,
  caption?: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<Response> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo,
      caption,
      reply_markup: replyMarkup,
    }),
  });

  return assertTelegramResponse(response, "sendPhoto");
}

export async function sendVideo(
  botToken: string,
  chatId: number,
  video: string,
  caption?: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<Response> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      video,
      caption,
      reply_markup: replyMarkup,
    }),
  });

  return assertTelegramResponse(response, "sendVideo");
}

export async function sendAudio(
  botToken: string,
  chatId: number,
  audio: string,
  caption?: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<Response> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendAudio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      audio,
      caption,
      reply_markup: replyMarkup,
    }),
  });

  return assertTelegramResponse(response, "sendAudio");
}

export async function sendVoice(
  botToken: string,
  chatId: number,
  voice: string,
  caption?: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<Response> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendVoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      voice,
      caption,
      reply_markup: replyMarkup,
    }),
  });

  return assertTelegramResponse(response, "sendVoice");
}

export async function sendAnimation(
  botToken: string,
  chatId: number,
  animation: string,
  caption?: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<Response> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendAnimation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      animation,
      caption,
      reply_markup: replyMarkup,
    }),
  });

  return assertTelegramResponse(response, "sendAnimation");
}

export async function sendSticker(
  botToken: string,
  chatId: number,
  sticker: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<Response> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendSticker`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      sticker,
      reply_markup: replyMarkup,
    }),
  });

  return assertTelegramResponse(response, "sendSticker");
}

export async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text?: string,
): Promise<Response> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
    }),
  });

  return assertTelegramResponse(response, "answerCallbackQuery");
}
