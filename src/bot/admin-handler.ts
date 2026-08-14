import {
  deleteSurvey,
  getSurveyById,
  listAllSurveys,
  updateSurveyStatus,
} from "../db/repositories/survey.repository";
import { getUserByTelegramId } from "../db/repositories/user.repository";
import {
  isAdmin,
  assertCanManageSurvey,
} from "../services/permission.service";
import { answerCallbackQuery, sendMessage, type InlineKeyboardMarkup } from "./telegram";
import { getSurveyStatistics } from "../services/statistics.service";
import type { BotContext, TelegramCallbackQuery, TelegramMessage } from "./types";

export async function handleAdminMessage(
  ctx: BotContext,
  message: TelegramMessage,
): Promise<boolean> {
  const text = message.text?.trim();
  const userId = message.from?.id;

  if (text !== "/admin" || !userId) {
    return false;
  }

  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user || !isAdmin(user.telegramUserId, ctx.adminIds)) {
    await sendMessage(ctx.botToken, message.chat.id, "你没有管理员权限。");
    return true;
  }

  const surveys = await listAllSurveys(ctx.db);
  if (surveys.length === 0) {
    await sendMessage(ctx.botToken, message.chat.id, "当前没有问卷。");
    return true;
  }

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: surveys.flatMap((survey) => [
      [
        {
          text: `${survey.title} (#${survey.id}, ${survey.status})`,
          callback_data: `admin:survey:${survey.id}`,
        },
      ],
      [
        {
          text: "关闭",
          callback_data: `admin:close:${survey.id}`,
        },
        {
          text: "删除",
          callback_data: `admin:delete:${survey.id}`,
        },
      ],
    ]),
  };

  await sendMessage(ctx.botToken, message.chat.id, "全部问卷：", keyboard);
  return true;
}

export async function handleAdminCallback(
  ctx: BotContext,
  callback: TelegramCallbackQuery,
): Promise<boolean> {
  const data = callback.data;
  const userId = callback.from.id;
  const chatId = callback.message?.chat.id;

  if (!data || !chatId) {
    return false;
  }

  if (!data.startsWith("admin:")) {
    return false;
  }

  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user || !isAdmin(user.telegramUserId, ctx.adminIds)) {
    await answerCallbackQuery(ctx.botToken, callback.id, "没有管理员权限");
    return true;
  }

  if (data.startsWith("admin:survey:")) {
    const surveyId = Number(data.slice("admin:survey:".length));
    const survey = await getSurveyById(ctx.db, surveyId);
    if (!survey) {
      await answerCallbackQuery(ctx.botToken, callback.id, "问卷不存在");
      return true;
    }
    const stats = await getSurveyStatistics(ctx.db, surveyId);
    await sendMessage(
      ctx.botToken,
      chatId,
      `📋 ${survey.title} (#${survey.id})\n状态：${survey.status}\n开始：${stats.totalStarted}\n完成：${stats.totalCompleted}\n完成率：${stats.completionRate.toFixed(1)}%`,
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("admin:close:")) {
    const surveyId = Number(data.slice("admin:close:".length));
    await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
    await updateSurveyStatus(ctx.db, surveyId, "closed");
    await sendMessage(ctx.botToken, chatId, `问卷 #${surveyId} 已关闭。`);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("admin:delete:")) {
    const surveyId = Number(data.slice("admin:delete:".length));
    await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
    await deleteSurvey(ctx.db, surveyId);
    await sendMessage(ctx.botToken, chatId, `问卷 #${surveyId} 已删除。`);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  return false;
}
