import {
  editMessageText,
  sendMessage,
  type InlineKeyboardMarkup,
} from "./telegram";

export interface UiScreen {
  screen: string;
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
}

export interface UiMessageState {
  chatId: number;
  messageId: number;
  screen: string;
  version: number;
  method: "edit" | "send";
}

interface RenderInput extends UiScreen {
  botToken: string;
  chatId: number;
  userId: number;
  messageId?: number;
  version?: number;
}

function responseMessageId(response: Response): Promise<number | null> {
  return response.clone().json().then((body: unknown) => {
    const value = (body as { result?: { message_id?: unknown } }).result?.message_id;
    return typeof value === "number" ? value : null;
  }).catch(() => null);
}

function isEditFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /message (?:to edit )?not found|message can't be edited|there is no text in the message|message type/i.test(message);
}

export async function renderScreen(input: RenderInput): Promise<UiMessageState> {
  const requestId = crypto.randomUUID();
  const base = {
    requestId,
    chatId: input.chatId,
    userId: input.userId,
    screen: input.screen,
    messageId: input.messageId ?? null,
  };

  if (input.messageId !== undefined) {
    try {
      await editMessageText(
        input.botToken,
        input.chatId,
        input.messageId,
        input.text,
        input.replyMarkup,
      );
      console.info("UI render", { ...base, action: "render", method: "edit", success: true });
      return {
        chatId: input.chatId,
        messageId: input.messageId,
        screen: input.screen,
        version: (input.version ?? 0) + 1,
        method: "edit",
      };
    } catch (error) {
      console.warn("UI edit failed; falling back to send", {
        ...base,
        action: "render",
        method: "edit",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!isEditFallbackError(error)) throw error;
    }
  }

  const response = await sendMessage(
    input.botToken,
    input.chatId,
    input.text,
    input.replyMarkup,
  );
  const messageId = await responseMessageId(response);
  if (messageId === null) {
    throw new Error("Telegram sendMessage did not return a message id");
  }
  console.info("UI render", { ...base, action: "render", method: "send", success: true, messageId });
  return {
    chatId: input.chatId,
    messageId,
    screen: input.screen,
    version: (input.version ?? 0) + 1,
    method: "send",
  };
}
