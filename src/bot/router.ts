import { handleTelegramCallback, handleTelegramMessage } from "./survey-handler";
import { answerCallbackQuery, sendMessage } from "./telegram";
import type { BotContext, TelegramUpdate } from "./types";
import { getUpdateKind } from "./update-parser";
import { getUserByTelegramId, upsertUser } from "../db/repositories/user.repository";
import type { TelegramUser } from "./types";
import { setUiMessage } from "../services/ui-session.service";

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
      const user = await getUserByTelegramId(ctx.db, update.message.from.id);
      if (user?.bannedAt && !ctx.adminIds.includes(update.message.from.id)) {
        await sendMessage(ctx.botToken, update.message.chat.id, "⛔ 你的账号当前无法使用此机器人。如有疑问，请联系管理员。");
        return;
      }
    }
    try {
      await handleTelegramMessage(ctx, update.message);
    } catch (error) {
      console.error("Telegram message handler failed", error);
      await sendMessage(
        ctx.botToken,
        update.message.chat.id,
        "⚠️ 处理失败，请稍后重试。",
      );
    }
    return;
  }

  if (kind === "callback_query" && update.callback_query) {
    await ensureUser(ctx, update.callback_query.from);
    const user = await getUserByTelegramId(ctx.db, update.callback_query.from.id);
    if (user?.bannedAt && !ctx.adminIds.includes(update.callback_query.from.id)) {
      await answerCallbackQuery(ctx.botToken, update.callback_query.id, "账号已被限制使用");
      return;
    }
    try {
      // UI bookkeeping must never prevent the actual callback action.
      if (ctx.ui && update.callback_query.message) {
        try {
          await setUiMessage(
            ctx.ui,
            update.callback_query.from.id,
            update.callback_query.message.chat.id,
            update.callback_query.message.message_id,
          );
        } catch (error) {
          console.warn("UI session update failed; continuing callback", error);
        }
      }
      await handleTelegramCallback(ctx, update.callback_query);
    } catch (error) {
      console.error("Telegram callback handler failed", error);
      await answerCallbackQuery(
        ctx.botToken,
        update.callback_query.id,
        "处理失败，请稍后重试",
      );
    }
  }
}
