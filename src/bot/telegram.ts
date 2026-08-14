export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
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

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
  }

  return response;
}

export async function editMessageReplyMarkup(
  botToken: string,
  chatId: number,
  messageId: number,
  replyMarkup: InlineKeyboardMarkup,
): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`, {
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

  return fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    body: formData,
  });
}

export async function getTelegramFileText(
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

  const fileResponse = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${filePath}`,
  );

  if (!fileResponse.ok) {
    throw new Error(`Telegram file download failed: ${fileResponse.status}`);
  }

  return fileResponse.text();
}

export async function sendPhoto(
  botToken: string,
  chatId: number,
  photo: string,
  caption?: string,
): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo, caption }),
  });
}

export async function sendVideo(
  botToken: string,
  chatId: number,
  video: string,
  caption?: string,
): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, video, caption }),
  });
}

export async function sendAudio(
  botToken: string,
  chatId: number,
  audio: string,
  caption?: string,
): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${botToken}/sendAudio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, audio, caption }),
  });
}

export async function sendVoice(
  botToken: string,
  chatId: number,
  voice: string,
  caption?: string,
): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${botToken}/sendVoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, voice, caption }),
  });
}

export async function sendAnimation(
  botToken: string,
  chatId: number,
  animation: string,
  caption?: string,
): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${botToken}/sendAnimation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, animation, caption }),
  });
}

export async function sendSticker(
  botToken: string,
  chatId: number,
  sticker: string,
): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${botToken}/sendSticker`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, sticker }),
  });
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

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram answerCallbackQuery failed: ${response.status} ${body}`);
  }

  return response;
}
