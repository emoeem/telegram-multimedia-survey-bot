import type { TelegramUpdate } from "./types";

export type TelegramUpdateKind = "message" | "callback_query" | "channel_post" | "unknown";

export function getUpdateKind(update: TelegramUpdate): TelegramUpdateKind {
  if (update.message) {
    return "message";
  }

  if (update.callback_query) {
    return "callback_query";
  }

  if (update.channel_post) {
    return "channel_post";
  }

  return "unknown";
}

export function parseTelegramUpdate(body: unknown): TelegramUpdate | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const update = body as Partial<TelegramUpdate>;

  if (typeof update.update_id !== "number") {
    return null;
  }

  return update as TelegramUpdate;
}
