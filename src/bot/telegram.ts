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
