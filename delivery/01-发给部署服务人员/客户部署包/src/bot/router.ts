import { handleTelegramCallback, handleTelegramMessage } from "./survey-handler";
import { answerCallbackQuery, sendMessage } from "./telegram";
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
    try {
      await handleTelegramMessage(ctx, update.message);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        update.message.chat.id,
        `⚠️ 处理失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    }
    return;
  }

  if (kind === "callback_query" && update.callback_query) {
    await ensureUser(ctx, update.callback_query.from);
    try {
      await handleTelegramCallback(ctx, update.callback_query);
    } catch (error) {
      await answerCallbackQuery(
        ctx.botToken,
        update.callback_query.id,
        error instanceof Error ? error.message : "处理失败",
      );
    }
  }
}
