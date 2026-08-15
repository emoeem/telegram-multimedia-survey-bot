import {
  getQuestionById,
  listOptionsForQuestions,
  listQuestionsBySurvey,
} from "../db/repositories/question.repository";
import {
  getQuestionMediaByQuestionId,
  listOptionMediaByOptionIds,
} from "../db/repositories/media.repository";
import { getSurveyById } from "../db/repositories/survey.repository";
import { getUserByTelegramId } from "../db/repositories/user.repository";
import { assertCanManageSurvey } from "../services/permission.service";
import { getResponseCount } from "../services/statistics.service";
import {
  sendLongMessage,
  sendMessage,
  type InlineKeyboardMarkup,
} from "./telegram";
import type { BotContext } from "./types";

const EDITABLE_OPTION_STRUCTURE_TYPES = new Set([
  "single",
  "multiple",
]);

function compactButtonText(value: string, maxLength = 28): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength - 1)}…`;
}

export async function showQuestionList(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) {
    await sendMessage(ctx.botToken, chatId, "用户信息不存在。");
    return;
  }

  try {
    await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
  } catch {
    await sendMessage(ctx.botToken, chatId, "无权编辑该问卷。");
    return;
  }

  const [survey, questions, responseCount] = await Promise.all([
    getSurveyById(ctx.db, surveyId),
    listQuestionsBySurvey(ctx.db, surveyId),
    getResponseCount(ctx.db, surveyId),
  ]);
  if (!survey) {
    await sendMessage(ctx.botToken, chatId, "问卷不存在。");
    return;
  }

  const locked = responseCount > 0;
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const question of questions) {
    rows.push([
      {
        text: `${question.order + 1}. ${compactButtonText(question.title, 40)}`,
        callback_data: `qedit:view:${question.id}`,
      },
    ]);
    if (!locked) {
      rows.push([
        { text: "⬆️", callback_data: `qedit:up:${question.id}` },
        { text: "⬇️", callback_data: `qedit:down:${question.id}` },
        { text: "📋", callback_data: `qedit:copy:${question.id}` },
        { text: "🗑", callback_data: `qedit:delete_ask:${question.id}` },
      ]);
    }
  }
  rows.push([
    {
      text: "📋 复制整个问卷",
      callback_data: `owner:duplicate:${surveyId}`,
    },
  ]);

  const text = [
    `题目列表：${survey.title}`,
    `状态：${survey.status}`,
    `题目：${questions.length} 道`,
    locked
      ? `已有 ${responseCount} 份答卷，题目结构已锁定。复制问卷后可继续修改。`
      : "点击题目可编辑内容、选项和附件。",
  ].join("\n");

  await sendMessage(
    ctx.botToken,
    chatId,
    text,
    { inline_keyboard: rows },
  );
}

export async function showQuestionEditor(
  ctx: BotContext,
  chatId: number,
  userId: number,
  questionId: number,
): Promise<void> {
  const [question, user] = await Promise.all([
    getQuestionById(ctx.db, questionId),
    getUserByTelegramId(ctx.db, userId),
  ]);
  if (!question || !user) {
    await sendMessage(ctx.botToken, chatId, "题目不存在或用户不存在。");
    return;
  }

  try {
    await assertCanManageSurvey(ctx.db, user, question.surveyId, ctx.adminIds);
  } catch {
    await sendMessage(ctx.botToken, chatId, "无权编辑该题目。");
    return;
  }

  const [options, questionMedia, responseCount] = await Promise.all([
    listOptionsForQuestions(ctx.db, [question.id]),
    getQuestionMediaByQuestionId(ctx.db, question.id),
    getResponseCount(ctx.db, question.surveyId),
  ]);
  const optionMediaRows = await listOptionMediaByOptionIds(
    ctx.db,
    options.map((option) => option.id),
  );
  const optionMedia = new Map<number, typeof optionMediaRows>();
  for (const relation of optionMediaRows) {
    const relations = optionMedia.get(relation.questionOptionId) ?? [];
    relations.push(relation);
    optionMedia.set(relation.questionOptionId, relations);
  }
  const locked = responseCount > 0;
  const totalOptionMedia = optionMediaRows.length;

  const text = [
    `第 ${question.order + 1} 题`,
    `类型：${question.type}`,
    `题目：${question.title}`,
    `必答：${question.required ? "是" : "否"}`,
    `题目附件：${questionMedia.length} 个`,
    options.length > 0
      ? `选项：\n${options
          .map((option, index) => {
            const mediaCount = optionMedia.get(option.id)?.length ?? 0;
            return `${index + 1}. ${option.label}${mediaCount > 0 ? `（附件 ${mediaCount}）` : ""}`;
          })
          .join("\n")}`
      : "",
    totalOptionMedia > 0 ? `选项附件合计：${totalOptionMedia} 个` : "",
    locked
      ? `该问卷已有 ${responseCount} 份答卷，当前题目已锁定。`
      : "",
  ].filter(Boolean).join("\n\n");

  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  if (!locked) {
    rows.push([
      {
        text: "✏️ 修改题目",
        callback_data: `qedit:title:${question.id}`,
      },
      {
        text: "📎 添加题目附件",
        callback_data: `question_media:${question.id}`,
      },
    ]);

    options.forEach((option, index) => {
      const optionActions = [];
      if (question.type !== "rating") {
        optionActions.push({
          text: `✏️ ${compactButtonText(option.label)}`,
          callback_data: `option_label:${option.id}`,
        });
      }
      optionActions.push({
        text: "📎 添加附件",
        callback_data: `option_media:${option.id}`,
      });
      rows.push(optionActions);

      if (EDITABLE_OPTION_STRUCTURE_TYPES.has(question.type)) {
        rows.push([
          {
            text: "⬆️",
            callback_data: `qedit:option_up:${option.id}`,
          },
          {
            text: "⬇️",
            callback_data: `qedit:option_down:${option.id}`,
          },
          {
            text: "🗑 删除选项",
            callback_data: `qedit:option_delete_ask:${option.id}`,
          },
        ]);
      }

      for (
        let mediaIndex = 0;
        mediaIndex < (optionMedia.get(option.id)?.length ?? 0);
        mediaIndex += 1
      ) {
        const relation = optionMedia.get(option.id)?.[mediaIndex];
        if (!relation) continue;
        rows.push([
          {
            text: `🗑 删除选项 ${index + 1} 的附件 ${mediaIndex + 1}`,
            callback_data:
              `qedit:omedia_delete:${relation.id}:${question.id}`,
          },
        ]);
      }
    });

    if (EDITABLE_OPTION_STRUCTURE_TYPES.has(question.type)) {
      rows.push([
        {
          text: "➕ 新增选项",
          callback_data: `qedit:option_add:${question.id}`,
        },
      ]);
    }

    questionMedia.forEach((relation, index) => {
      rows.push([
        {
          text: `🗑 删除题目附件 ${index + 1}`,
          callback_data:
            `qedit:qmedia_delete:${relation.id}:${question.id}`,
        },
      ]);
    });

    rows.push([
      {
        text: question.required ? "设为非必答" : "设为必答",
        callback_data: `qedit:required:${question.id}`,
      },
    ]);
    rows.push([
      { text: "📋 复制题目", callback_data: `qedit:copy:${question.id}` },
      {
        text: "🗑 删除题目",
        callback_data: `qedit:delete_ask:${question.id}`,
      },
    ]);
  } else {
    rows.push([
      {
        text: "📋 复制整个问卷后编辑",
        callback_data: `owner:duplicate:${question.surveyId}`,
      },
    ]);
  }
  rows.push([
    {
      text: "⬅ 返回题目列表",
      callback_data: `qedit:list:${question.surveyId}`,
    },
  ]);

  await sendLongMessage(
    ctx.botToken,
    chatId,
    text,
    { inline_keyboard: rows },
  );
}
