import { handleTelegramCallback, handleTelegramMessage } from "./survey-handler";
import type { BotContext, TelegramUpdate } from "./types";
import { getUpdateKind } from "./update-parser";
import { upsertUser } from "../db/repositories/user.repository";
import type { TelegramUser } from "./types";

async function ensureUser(ctx: BotContext, telegramUser: TelegramUser): Promise<void> {
  await upsertUser(ctx.db, {
    telegramUserId: telegramUser.id,
    username: telegramUser.username ?? null,
    firstName: telegramUser.first_name ?? null,
    lastName: telegramUser.last_name ?? null,
    languageCode: null,
    systemRole: ctx.adminIds.includes(telegramUser.id) ? "admin" : "participant",
  });
}

export async function handleTelegramUpdate(
  update: TelegramUpdate,
  ctx: BotContext,
): Promise<void> {
  const kind = getUpdateKind(update);

  if (kind === "message" && update.message) {
    if (update.message.from) {
      await ensureUser(ctx, update.message.from);
    }
    await handleTelegramMessage(ctx, update.message);
    return;
  }

  if (kind === "callback_query" && update.callback_query) {
    await ensureUser(ctx, update.callback_query.from);
    await handleTelegramCallback(ctx, update.callback_query);
  }
}
