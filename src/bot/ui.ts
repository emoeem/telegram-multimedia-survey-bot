import { editMessageText, sendMessage, type InlineKeyboardMarkup } from "./telegram";
import { getUiSession, replaceUiScreen, setUiMessage } from "../services/ui-session.service";
import type { BotContext } from "./types";

export interface UiScreen {
  screen: string;
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
  state?: Record<string, string | number | boolean>;
}

function messageIdFromResponse(response: Response): Promise<number | null> {
  return response.clone().json()
    .then((body: unknown) => {
      const messageId = (body as { result?: { message_id?: unknown } })
        .result?.message_id;
      return typeof messageId === "number" ? messageId : null;
    })
    .catch(() => null);
}

export async function renderUiScreen(
  ctx: BotContext,
  chatId: number,
  userId: number,
  screen: UiScreen,
): Promise<void> {
  if (!ctx.ui) {
    await sendMessage(ctx.botToken, chatId, screen.text, screen.replyMarkup);
    return;
  }

  let session;
  try {
    session = await getUiSession(ctx.ui, userId, chatId);
  } catch (error) {
    console.warn("UI session read failed; falling back to sendMessage", error);
    await sendMessage(ctx.botToken, chatId, screen.text, screen.replyMarkup);
    return;
  }
  if (session.messageId !== null) {
    try {
      await editMessageText(
        ctx.botToken,
        chatId,
        session.messageId,
        screen.text,
        screen.replyMarkup,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("message to edit not found") && !message.includes("can't be edited")) {
        throw error;
      }
      const response = await sendMessage(ctx.botToken, chatId, screen.text, screen.replyMarkup);
      const messageId = await messageIdFromResponse(response);
      if (messageId !== null) {
        try {
          await setUiMessage(ctx.ui, userId, chatId, messageId);
        } catch (error) {
          console.warn("UI session message update failed", error);
        }
      }
    }
  } else {
    const response = await sendMessage(ctx.botToken, chatId, screen.text, screen.replyMarkup);
    const messageId = await messageIdFromResponse(response);
    if (messageId !== null) {
      try {
        await setUiMessage(ctx.ui, userId, chatId, messageId);
      } catch (error) {
        console.warn("UI session message update failed", error);
      }
    }
  }
  try {
    await replaceUiScreen(ctx.ui, userId, chatId, screen.screen, screen.state);
  } catch (error) {
    console.warn("UI screen state update failed", error);
  }
}
