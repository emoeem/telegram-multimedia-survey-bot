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
  "matrix",
]);

function matrixColumnsText(settingsJson: string | null): string {
  try {
    const parsed = settingsJson ? JSON.parse(settingsJson) as { columns?: unknown } : null;
    const columns = Array.isArray(parsed?.columns)
      ? parsed.columns.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    return columns.length > 0 ? columns.join(" / ") : "（未设置）";
  } catch {
    return "（配置异常）";
  }
}
const QUESTION_LIST_PAGE_SIZE = 8;

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
  offset = 0,
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
  const lastPageOffset = questions.length === 0
    ? 0
    : Math.floor((questions.length - 1) / QUESTION_LIST_PAGE_SIZE) * QUESTION_LIST_PAGE_SIZE;
  const safeOffset = Math.max(0, Math.min(offset, lastPageOffset));
  const pageQuestions = questions.slice(
    safeOffset,
    safeOffset + QUESTION_LIST_PAGE_SIZE,
  );
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const question of pageQuestions) {
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
  if (questions.length > QUESTION_LIST_PAGE_SIZE) {
    const navigation = [];
    if (safeOffset > 0) {
      navigation.push({
        text: "上一页",
        callback_data: `qedit:list:${surveyId}:${safeOffset - QUESTION_LIST_PAGE_SIZE}`,
      });
    }
    if (safeOffset + QUESTION_LIST_PAGE_SIZE < questions.length) {
      navigation.push({
        text: "下一页",
        callback_data: `qedit:list:${surveyId}:${safeOffset + QUESTION_LIST_PAGE_SIZE}`,
      });
    }
    if (navigation.length > 0) rows.push(navigation);
  }
  if (!locked) {
    rows.push([
      {
        text: "新增题目",
        callback_data: `qedit:add:${surveyId}`,
      },
    ]);
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
    questions.length > QUESTION_LIST_PAGE_SIZE
      ? `当前显示：第 ${safeOffset + 1}-${Math.min(safeOffset + QUESTION_LIST_PAGE_SIZE, questions.length)} 题`
      : null,
    locked
      ? `已有 ${responseCount} 份答卷，题目结构已锁定。复制问卷后可继续修改。`
      : "点击题目可编辑内容、选项和附件。",
  ].filter(Boolean).join("\n");

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
    question.type === "matrix" ? `矩阵列：${matrixColumnsText(question.settingsJson)}` : "",
    `必答：${question.required ? "是" : "否"}`,
    question.conditionJson && question.skipToQuestionId
      ? `跳题：已设置 ${(() => {
          try {
            const parsed = JSON.parse(question.conditionJson) as { rules?: unknown[] };
            return Array.isArray(parsed.rules) ? `${parsed.rules.length} 条规则` : "1 条规则";
          } catch {
            return "1 条规则";
          }
        })()}`
      : "跳题：未设置",
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
          text: `✏️ 修改选项 ${index + 1}`,
          callback_data: `option_label:${option.id}`,
        });
      }
      optionActions.push({
        text: `📎 选项 ${index + 1} 附件`,
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
    if (["single", "yes_no", "rating"].includes(question.type) && options.length > 0) {
      rows.push([
        { text: "新增/修改跳题", callback_data: `qedit:skip_menu:${question.id}` },
        ...(question.conditionJson ? [{ text: "清除跳题", callback_data: `qedit:skip_clear:${question.id}` }] : []),
      ]);
    }
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
  const surveyQuestions = await listQuestionsBySurvey(ctx.db, question.surveyId) ?? [];
  const previousQuestion = surveyQuestions[question.order - 1] ?? null;
  const nextQuestion = surveyQuestions[question.order + 1] ?? null;
  const navigation: InlineKeyboardMarkup["inline_keyboard"][number] = [];
  if (previousQuestion) {
    navigation.push({ text: "⬅️ 上一题", callback_data: `qedit:view:${previousQuestion.id}` });
  }
  if (nextQuestion) {
    navigation.push({ text: "下一题 ➡️", callback_data: `qedit:view:${nextQuestion.id}` });
  }
  if (navigation.length > 0) rows.push(navigation);
  if (!locked) {
    rows.push([{ text: "➕ 添加下一题", callback_data: `qedit:add:${question.surveyId}` }]);
  }
  rows.push([
    {
      text: "⬅ 返回题目列表",
      callback_data: `qedit:list:${question.surveyId}`,
    },
    {
      text: "问卷概览",
      callback_data: `owner:survey:${question.surveyId}`,
    },
  ]);

  await sendLongMessage(
    ctx.botToken,
    chatId,
    text,
    { inline_keyboard: rows },
  );
}
