import { getActiveResponse, createResponse, cancelResponse, completeResponse, updateResponseCurrentQuestion, upsertMediaAnswer, upsertOptionAnswer, upsertTextAnswer } from "../db/repositories/response.repository";
import { updateSurveyStatus } from "../db/repositories/survey.repository";
import { createAnswerMedia, getMediaAssetById, getOptionMediaByOptionId } from "../db/repositories/media.repository";
import {
  duplicateQuestion,
  getQuestionById as getQuestionEntityById,
  listQuestionsBySurvey,
  listOptionsForQuestions,
  swapQuestionOrder,
  updateQuestionRequired,
  updateQuestionTitle,
} from "../db/repositories/question.repository";
import { registerMediaAsset } from "../services/media.service";
import { getUserByTelegramId } from "../db/repositories/user.repository";
import { assertCanFillSurvey, assertCanManageSurvey, canCreateSurvey } from "../services/permission.service";
import { duplicateSurvey, listMySurveys as listOwnedSurveys } from "../services/survey.service";
import {
  getNumericStatistics,
  getOptionStatistics,
  getSurveyStatistics,
} from "../services/statistics.service";
import { listResponses } from "../services/result.service";
import { buildCsv, buildExportZip, buildXlsx, getExportRows } from "../services/export.service";
import { exportUnifiedSurveyJson } from "../services/survey-json.service";
import { getSurveyDetail } from "../services/survey.service";
import { getSurveyFlow } from "../services/question.service";
import {
  clearSessionOptions,
  completeSession,
  getSession,
  getSessionSelectedOptions,
  initSession,
  setSessionCurrentQuestion,
  toggleSessionOption,
} from "../services/session.service";
import { getFirstQuestion, getNextQuestion, getPreviousQuestion, getQuestionById, isLastQuestion, type SurveyQuestionView } from "../survey/engine";
import { answerCallbackQuery, editMessageReplyMarkup, sendAnimation, sendAudio, sendDocument, sendMessage, sendPhoto, sendSticker, sendVideo, sendVoice, type InlineKeyboardMarkup } from "./telegram";
import type { BotContext, TelegramCallbackQuery, TelegramMessage } from "./types";
import { handleBuilderCallback, handleBuilderMessage } from "./builder-handler";
import { handleAdminCallback, handleAdminMessage } from "./admin-handler";

function buildSingleChoiceKeyboard(
  question: SurveyQuestionView,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: question.options.map((option) => [
      {
        text: option.label,
        callback_data: `q:single:${question.id}:${option.id}`,
      },
    ]).concat([
      [
        {
          text: "退出问卷",
          callback_data: "q:exit",
        },
      ],
    ]),
  };
}

function buildMultipleChoiceKeyboard(
  question: SurveyQuestionView,
  selectedOptionIds: number[],
): InlineKeyboardMarkup {
  const selected = new Set(selectedOptionIds);
  const optionRows = question.options.map((option) => [
    {
      text: `${selected.has(option.id) ? "✅" : "⬜"} ${option.label}`,
      callback_data: `q:multi:toggle:${question.id}:${option.id}`,
    },
  ]);

  return {
    inline_keyboard: [
      ...optionRows,
      [
        {
          text: "退出问卷",
          callback_data: "q:exit",
        },
      ],
      [
        {
          text: "完成选择",
          callback_data: `q:multi:confirm:${question.id}`,
        },
      ],
    ],
  };
}

function buildNavigationKeyboard(
  question: SurveyQuestionView,
  total: number,
  currentIndex: number,
): InlineKeyboardMarkup {
  const rows = [];

  if (currentIndex > 0) {
    rows.push([
      {
        text: "⬅️ 上一题",
        callback_data: `q:prev:${question.id}`,
      },
    ]);
  }

  rows.push([
    {
      text: currentIndex === total - 1 ? "✅ 提交" : "下一题 ➡️",
      callback_data:
        currentIndex === total - 1 ? "q:submit" : `q:next:${question.id}`,
    },
  ]);

  rows.push([
    {
      text: "退出问卷",
      callback_data: "q:exit",
    },
  ]);

  return { inline_keyboard: rows };
}

function formatQuestionText(
  question: SurveyQuestionView,
  index: number,
  total: number,
): string {
  const parts = [`第 ${index + 1} / ${total} 题`, question.title];

  if (question.description) {
    parts.push(question.description);
  }

  if (question.type === "single") {
    parts.push("请选择一个选项");
  } else if (question.type === "multiple") {
    parts.push("可选择多个选项，完成后点击“完成选择”");
  } else {
    parts.push("请直接发送你的回答");
  }

  return parts.join("\n\n");
}

async function renderQuestion(
  ctx: BotContext,
  chatId: number,
  responseId: number,
  question: SurveyQuestionView,
  flowQuestions: SurveyQuestionView[],
  userId: number,
  surveyId: number,
): Promise<void> {
  if (question.options.length > 0) {
    for (const option of question.options) {
      const optionMedia = await getOptionMediaByOptionId(ctx.db, option.id);
      for (const relation of optionMedia) {
        const asset = await getMediaAssetById(ctx.db, relation.mediaAssetId);
        if (!asset?.telegramFileId) continue;
        const caption = `选项：${option.label}`;

        if (asset.mediaType === "photo") {
          await sendPhoto(ctx.botToken, chatId, asset.telegramFileId, caption);
        } else if (asset.mediaType === "video") {
          await sendVideo(ctx.botToken, chatId, asset.telegramFileId, caption);
        } else if (asset.mediaType === "audio") {
          await sendAudio(ctx.botToken, chatId, asset.telegramFileId, caption);
        } else if (asset.mediaType === "voice") {
          await sendVoice(ctx.botToken, chatId, asset.telegramFileId, caption);
        } else if (asset.mediaType === "animation" || asset.mediaType === "gif") {
          await sendAnimation(ctx.botToken, chatId, asset.telegramFileId, caption);
        } else if (asset.mediaType === "sticker") {
          await sendSticker(ctx.botToken, chatId, asset.telegramFileId);
        } else {
          await sendDocument(
            ctx.botToken,
            chatId,
            asset.fileName ?? "document",
            asset.telegramFileId,
            asset.mimeType ?? "application/octet-stream",
          );
        }
      }
    }
  }

  const index = flowQuestions.findIndex((item) => item.id === question.id);
  const total = flowQuestions.length;

  let replyMarkup: InlineKeyboardMarkup | undefined;

  if (question.type === "single") {
    replyMarkup = buildSingleChoiceKeyboard(question);
  } else if (question.type === "multiple") {
    const selected = await getSessionSelectedOptions(ctx.session, userId, surveyId);
    replyMarkup = buildMultipleChoiceKeyboard(question, selected);
  } else {
    replyMarkup = buildNavigationKeyboard(question, total, index);
  }

  await sendMessage(
    ctx.botToken,
    chatId,
    formatQuestionText(question, index, total),
    replyMarkup,
  );
}

async function advanceQuestion(
  ctx: BotContext,
  chatId: number,
  responseId: number,
  currentQuestionId: number,
  flowQuestions: SurveyQuestionView[],
  userId: number,
  surveyId: number,
): Promise<void> {
  const next = getNextQuestion(
    { questions: flowQuestions },
    currentQuestionId,
  );

  if (!next) {
    await completeResponse(ctx.db, responseId);
    await completeSession(ctx.session, userId, surveyId);
    await sendMessage(ctx.botToken, chatId, "你已完成问卷，感谢参与。");
    return;
  }

  await updateResponseCurrentQuestion(ctx.db, responseId, next.id);
  await setSessionCurrentQuestion(ctx.session, userId, surveyId, next.id);
  await renderQuestion(
    ctx,
    chatId,
    responseId,
    next,
    flowQuestions,
    userId,
    surveyId,
  );
}

async function getResponseForUser(
  ctx: BotContext,
  surveyId: number,
  userId: number,
) {
  const participantHash = `user_${userId}`;
  const existing = await getActiveResponse(
    ctx.db,
    surveyId,
    participantHash,
  );

  if (existing) {
    return existing;
  }

  return createResponse(ctx.db, {
    surveyId,
    userId,
    participantHash,
  });
}

async function startSurvey(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) {
    await sendMessage(ctx.botToken, chatId, "用户信息不存在，请重新 /start。");
    return;
  }

  try {
    await assertCanFillSurvey(ctx.db, surveyId, user);
  } catch (error) {
    await sendMessage(
      ctx.botToken,
      chatId,
      error instanceof Error ? error.message : "无权填写该问卷。",
    );
    return;
  }

  const survey = await getSurveyDetail(ctx.db, surveyId);
  if (!survey || survey.status !== "published") {
    await sendMessage(ctx.botToken, chatId, "问卷不存在或未发布。");
    return;
  }

  const flow = await getSurveyFlow(ctx.db, surveyId);
  const firstQuestion = getFirstQuestion(flow);
  if (!firstQuestion) {
    await sendMessage(ctx.botToken, chatId, "该问卷还没有题目。");
    return;
  }

  const response = await getResponseForUser(ctx, surveyId, userId);
  const sessionState = await initSession(ctx.session, {
    userId,
    surveyId,
    responseId: response.id,
    currentQuestionId: response.currentQuestionId ?? firstQuestion.id,
  });
  const currentQuestionId = sessionState.currentQuestionId ?? firstQuestion.id;
  const question = getQuestionById(flow, currentQuestionId) ?? firstQuestion;

  await updateResponseCurrentQuestion(ctx.db, response.id, question.id);
  await setSessionCurrentQuestion(ctx.session, userId, surveyId, question.id);
  await sendMessage(
    ctx.botToken,
    chatId,
    `开始问卷：${survey.title}\n${survey.description ?? ""}`,
  );
  await renderQuestion(
    ctx,
    chatId,
    response.id,
    question,
    flow.questions,
    userId,
    surveyId,
  );
}

async function listMySurveys(
  ctx: BotContext,
  chatId: number,
  userId: number,
): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) {
    await sendMessage(ctx.botToken, chatId, "用户信息不存在，请重新 /start。");
    return;
  }

  const surveys = await listOwnedSurveys(ctx.db, user.id);
  if (surveys.length === 0) {
    await sendMessage(ctx.botToken, chatId, "你还没有创建问卷。");
    return;
  }

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: surveys.flatMap((survey) => {
      const rows = [
        [
          {
            text: `${survey.status === "draft" ? "📝" : "📋"} ${survey.title}`,
            callback_data: `owner:survey:${survey.id}`,
          },
        ],
      ];

      if (survey.status === "draft") {
        rows.push([
          {
            text: "发布",
            callback_data: `owner:publish_ask:${survey.id}`,
          },
          {
            text: "编辑",
            callback_data: `owner:questions:${survey.id}`,
          },
        ]);
      } else if (survey.status === "published") {
        rows.push([
          {
            text: "关闭",
            callback_data: `owner:close:${survey.id}`,
          },
          {
            text: "编辑",
            callback_data: `owner:questions:${survey.id}`,
          },
        ]);
      } else {
        rows.push([
          {
            text: "编辑",
            callback_data: `owner:questions:${survey.id}`,
          },
        ]);
      }

      return rows;
    }),
  };

  await sendMessage(ctx.botToken, chatId, "我的问卷：", keyboard);
}

export async function showSurveyStats(
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
  } catch (error) {
    await sendMessage(
      ctx.botToken,
      chatId,
      error instanceof Error ? error.message : "无权查看该问卷。",
    );
    return;
  }

  const stats = await getSurveyStatistics(ctx.db, surveyId);
  const optionStats = await getOptionStatistics(ctx.db, surveyId);
  const numericStats = await getNumericStatistics(ctx.db, surveyId);
  const responses = await listResponses(ctx.db, surveyId, 10);

  const lines = [
    `📊 问卷统计 #${surveyId}`,
    `开始：${stats.totalStarted}`,
    `完成：${stats.totalCompleted}`,
    `完成率：${stats.completionRate.toFixed(1)}%`,
  ];

  if (optionStats.length > 0) {
    lines.push("", "选项统计：");
    const grouped = new Map<number, typeof optionStats>();
    for (const stat of optionStats) {
      const list = grouped.get(stat.questionId) ?? [];
      list.push(stat);
      grouped.set(stat.questionId, list);
    }

    for (const list of grouped.values()) {
      const first = list[0];
      if (!first) continue;
      lines.push(`${first.questionTitle}`);
      for (const stat of list) {
        lines.push(`${stat.optionLabel}: ${stat.count} (${stat.percentage.toFixed(1)}%)`);
      }
    }
  }

  if (numericStats.length > 0) {
    lines.push("", "评分/数字统计：");
    for (const stat of numericStats) {
      lines.push(
        `${stat.questionTitle}: avg=${stat.average ?? "-"} min=${stat.min ?? "-"} max=${stat.max ?? "-"}`,
      );
    }
  }

  if (responses.length > 0) {
    lines.push("", "最近回答：");
    for (const response of responses) {
      lines.push(`#${response.id} ${response.status} ${response.startedAt}`);
    }
  }

  await sendMessage(ctx.botToken, chatId, lines.join("\n"));
}

async function showQuestionList(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) return;

  try {
    await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
  } catch {
    await sendMessage(ctx.botToken, chatId, "无权编辑该问卷。");
    return;
  }

  const questions = await listQuestionsBySurvey(ctx.db, surveyId);
  if (questions.length === 0) {
    await sendMessage(ctx.botToken, chatId, "该问卷没有题目。");
    return;
  }

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: questions.flatMap((question) => [
      [
        {
          text: `${question.order + 1}. ${question.title}`,
          callback_data: `qedit:view:${question.id}`,
        },
      ],
      [
        { text: "⬆️", callback_data: `qedit:up:${question.id}` },
        { text: "⬇️", callback_data: `qedit:down:${question.id}` },
        { text: "📋", callback_data: `qedit:copy:${question.id}` },
        { text: "🗑", callback_data: `qedit:delete:${question.id}` },
      ],
    ]),
  };

  await sendMessage(ctx.botToken, chatId, "题目列表：", keyboard);
}

async function showQuestionEditor(
  ctx: BotContext,
  chatId: number,
  userId: number,
  questionId: number,
): Promise<void> {
  const question = await getQuestionEntityById(ctx.db, questionId);
  if (!question) {
    await sendMessage(ctx.botToken, chatId, "题目不存在。");
    return;
  }

  const options = await listOptionsForQuestions(ctx.db, [question.id]);
  const text = [
    `题目 ID：${question.id}`,
    `类型：${question.type}`,
    `题目：${question.title}`,
    `必答：${question.required ? "✅" : "⭕"}`,
    options.length > 0 ? `选项：\n${options.map((option) => `${option.order + 1}. ${option.label} (ID: ${option.id})`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: question.required ? "设为非必答" : "设为必答",
          callback_data: `qedit:required:${question.id}`,
        },
      ],
      [
        { text: "📋 复制", callback_data: `qedit:copy:${question.id}` },
        { text: "🗑 删除", callback_data: `qedit:delete:${question.id}` },
      ],
      [
        { text: "⬅ 返回题目列表", callback_data: `qedit:list:${question.surveyId}` },
      ],
    ],
  };

  await sendMessage(ctx.botToken, chatId, text, keyboard);
}

async function listSurveys(
  ctx: BotContext,
  chatId: number,
): Promise<void> {
  const result = await ctx.db
    .prepare("SELECT id, title, description FROM surveys WHERE status = 'published' ORDER BY id DESC")
    .all<{ id: number; title: string; description: string | null }>();

  if ((result.results ?? []).length === 0) {
    await sendMessage(ctx.botToken, chatId, "当前没有已发布的问卷。");
    return;
  }

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: result.results.map((survey) => [
      {
        text: survey.title,
        callback_data: `q:start:${survey.id}`,
      },
    ]),
  };

  await sendMessage(ctx.botToken, chatId, "请选择问卷：", keyboard);
}

export async function handleTelegramMessage(
  ctx: BotContext,
  message: TelegramMessage,
): Promise<void> {
  const text = message.text?.trim();
  const userId = message.from?.id;
  const hasMedia = Boolean(
    message.photo ||
      message.video ||
      message.audio ||
      message.voice ||
      message.animation ||
      message.sticker ||
      message.document,
  );

  if ((!text && !hasMedia) || !userId) {
    return;
  }

  if (text === "/start") {
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      "欢迎使用问卷机器人。\n\n发送 /create 创建问卷，发送 /surveys 浏览问卷。",
    );
    return;
  }

  if (text === "/surveys") {
    await listSurveys(ctx, message.chat.id);
    return;
  }

  if (text === "/help") {
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      "命令：\n/start 开始\n/create 创建问卷\n/surveys 浏览问卷\n/my_surveys 我的问卷\n/admin 管理员面板\n/export <id> 导出",
    );
    return;
  }

  if (await handleAdminMessage(ctx, message)) {
    return;
  }

  if (text === "/my_surveys") {
    await listMySurveys(ctx, message.chat.id, userId);
    return;
  }

  if (text?.startsWith("/duplicate ")) {
    const surveyId = Number(text.slice("/duplicate ".length));
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user) {
      await sendMessage(ctx.botToken, message.chat.id, "用户信息不存在。");
      return;
    }

    try {
      await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
      const duplicated = await duplicateSurvey(ctx.db, surveyId, user.id);
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        `已复制问卷，新问卷 ID：${duplicated.id}`,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "复制失败。",
      );
    }
    return;
  }

  if (text?.startsWith("/export ")) {
    const surveyId = Number(text.slice("/export ".length));
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user) {
      await sendMessage(ctx.botToken, message.chat.id, "用户信息不存在。");
      return;
    }

    try {
      await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "无权导出该问卷。",
      );
      return;
    }

    const { rows } = await getExportRows(ctx.db, surveyId);
    const csv = buildCsv(rows);
    const exportFormat = text.split(" ")[2]?.toLowerCase();

    if (exportFormat === "zip") {
      const zip = buildExportZip(csv, rows);
      await sendDocument(
        ctx.botToken,
        message.chat.id,
        `survey-${surveyId}.zip`,
        zip,
        "application/zip",
      );
    } else if (exportFormat === "xlsx") {
      const xlsx = buildXlsx(rows);
      await sendDocument(
        ctx.botToken,
        message.chat.id,
        `survey-${surveyId}.xlsx`,
        xlsx,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    } else {
      await sendDocument(
        ctx.botToken,
        message.chat.id,
        `survey-${surveyId}.csv`,
        csv,
        "text/csv",
      );
    }
    return;
  }

  if (text?.startsWith("/export_json ")) {
    const surveyId = Number(text.slice("/export_json ".length));
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user) {
      await sendMessage(ctx.botToken, message.chat.id, "用户信息不存在。");
      return;
    }

    try {
      await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "无权导出该问卷。",
      );
      return;
    }

    const unified = await exportUnifiedSurveyJson(ctx.db, surveyId);
    if (!unified) {
      await sendMessage(ctx.botToken, message.chat.id, "问卷不存在。");
      return;
    }

    await sendDocument(
      ctx.botToken,
      message.chat.id,
      `survey-${surveyId}.json`,
      JSON.stringify(unified, null, 2),
      "application/json",
    );
    return;
  }

  if (text?.startsWith("/preview ")) {
    const surveyId = Number(text.slice("/preview ".length));
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user) {
      await sendMessage(ctx.botToken, message.chat.id, "用户信息不存在。");
      return;
    }

    try {
      await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "无权预览该问卷。",
      );
      return;
    }

    const flow = await getSurveyFlow(ctx.db, surveyId);
    if (flow.questions.length === 0) {
      await sendMessage(ctx.botToken, message.chat.id, "问卷没有题目。");
      return;
    }

    const preview = flow.questions
      .map((question, index) => {
        const options = question.options.map((option) => `  ${option.label}`).join("\n");
        return `第 ${index + 1} 题\n${question.title}${options ? `\n${options}` : ""}`;
      })
      .join("\n\n");

    await sendMessage(ctx.botToken, message.chat.id, preview);
    return;
  }

  if (text === "/create") {
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user || !canCreateSurvey(user, ctx.adminIds)) {
      await sendMessage(ctx.botToken, message.chat.id, "你没有创建问卷的权限。");
      return;
    }
  }

  if (await handleBuilderMessage(ctx, message)) {
    return;
  }

  const response = await ctx.db
    .prepare(
      "SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1",
    )
    .bind(userId)
    .first<{ id: number; survey_id: number; current_question_id: number | null }>();

  if (!response) {
    await sendMessage(ctx.botToken, message.chat.id, "请使用 /surveys 选择一个问卷。");
    return;
  }

  const sessionState = await getSession(ctx.session, userId, response.survey_id);
  const currentQuestionId = sessionState.currentQuestionId;

  if (!currentQuestionId) {
    await sendMessage(ctx.botToken, message.chat.id, "当前问卷没有可用题目。");
    return;
  }

  const flow = await getSurveyFlow(ctx.db, response.survey_id);
  const question = getQuestionById(flow, currentQuestionId);

  if (!question) {
    await sendMessage(ctx.botToken, message.chat.id, "当前题目不存在。");
    return;
  }

  if (question.type === "single" || question.type === "multiple") {
    await renderQuestion(
      ctx,
      message.chat.id,
      response.id,
      question,
      flow.questions,
      userId,
      response.survey_id,
    );
    return;
  }

  if (
    question.type === "image" ||
    question.type === "video" ||
    question.type === "audio" ||
    question.type === "file"
  ) {
    const mediaAssetId = await registerMediaAsset(ctx, message);
    if (!mediaAssetId) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "请上传对应的媒体文件。",
      );
      return;
    }

    const answerId = await upsertMediaAnswer(ctx.db, {
      responseId: response.id,
      questionId: question.id,
      mediaAssetId,
    });
    await createAnswerMedia(ctx.db, {
      answerId,
      mediaAssetId,
    });
    await advanceQuestion(
      ctx,
      message.chat.id,
      response.id,
      question.id,
      flow.questions,
      userId,
      response.survey_id,
    );
    return;
  }

  if (text) {
    await upsertTextAnswer(ctx.db, {
      responseId: response.id,
      questionId: question.id,
      textValue: text,
    });
    await advanceQuestion(
      ctx,
      message.chat.id,
      response.id,
      question.id,
      flow.questions,
      userId,
      response.survey_id,
    );
  }
}

export async function handleTelegramCallback(
  ctx: BotContext,
  callback: TelegramCallbackQuery,
): Promise<void> {
  const data = callback.data;
  const chatId = callback.message?.chat.id;
  const userId = callback.from.id;

  if (!data || !chatId) {
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (await handleBuilderCallback(ctx, callback)) {
    return;
  }

  if (await handleAdminCallback(ctx, callback)) {
    return;
  }

  if (data.startsWith("owner:survey:")) {
    const surveyId = Number(data.slice("owner:survey:".length));
    await showSurveyStats(ctx, chatId, userId, surveyId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "owner:cancel") {
    await answerCallbackQuery(ctx.botToken, callback.id, "已取消");
    return;
  }

  if (data.startsWith("owner:publish_ask:")) {
    const surveyId = Number(data.slice("owner:publish_ask:".length));
    await sendMessage(
      ctx.botToken,
      chatId,
      "⚠️ 确认发布该问卷？",
      {
        inline_keyboard: [
          [
            {
              text: "✅ 确认发布",
              callback_data: `owner:publish_confirm:${surveyId}`,
            },
            {
              text: "取消",
              callback_data: "owner:cancel",
            },
          ],
        ],
      },
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("owner:publish_confirm:")) {
    const surveyId = Number(data.slice("owner:publish_confirm:".length));
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user) {
      await answerCallbackQuery(ctx.botToken, callback.id, "用户不存在");
      return;
    }
    try {
      await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
      await updateSurveyStatus(ctx.db, surveyId, "published");
      await sendMessage(ctx.botToken, chatId, "问卷已发布。");
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "发布失败。",
      );
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("owner:close:")) {
    const surveyId = Number(data.slice("owner:close:".length));
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user) {
      await answerCallbackQuery(ctx.botToken, callback.id, "用户不存在");
      return;
    }
    try {
      await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
      await updateSurveyStatus(ctx.db, surveyId, "closed");
      await sendMessage(ctx.botToken, chatId, "问卷已关闭。");
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "关闭失败。",
      );
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "/surveys" || data === "surveys:list") {
    await listSurveys(ctx, chatId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("q:start:")) {
    const surveyId = Number(data.slice("q:start:".length));
    await startSurvey(ctx, chatId, userId, surveyId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("q:single:")) {
    const [, , questionIdRaw, optionIdRaw] = data.split(":");
    const questionId = Number(questionIdRaw);
    const optionId = Number(optionIdRaw);
    const response = await ctx.db
      .prepare("SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1")
      .bind(userId)
      .first<{ id: number; survey_id: number }>();

    if (!response) {
      await answerCallbackQuery(ctx.botToken, callback.id);
      return;
    }

    await upsertOptionAnswer(ctx.db, {
      responseId: response.id,
      questionId,
      selectedOptionIds: [optionId],
    });

    const flow = await getSurveyFlow(ctx.db, response.survey_id);
    await advanceQuestion(
      ctx,
      chatId,
      response.id,
      questionId,
      flow.questions,
      userId,
      response.survey_id,
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("q:multi:toggle:")) {
    const [, , , questionIdRaw, optionIdRaw] = data.split(":");
    const questionId = Number(questionIdRaw);
    const optionId = Number(optionIdRaw);
    const response = await ctx.db
      .prepare("SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1")
      .bind(userId)
      .first<{ id: number; survey_id: number }>();

    if (!response) {
      await answerCallbackQuery(ctx.botToken, callback.id);
      return;
    }

    const sessionState = await toggleSessionOption(
      ctx.session,
      userId,
      response.survey_id,
      optionId,
    );
    const selected = sessionState.selectedOptionIds;

    const flow = await getSurveyFlow(ctx.db, response.survey_id);
    const question = getQuestionById(flow, questionId);
    if (question) {
      const messageId = callback.message?.message_id;
      if (messageId) {
        await editMessageReplyMarkup(
          ctx.botToken,
          chatId,
          messageId,
          buildMultipleChoiceKeyboard(question, selected),
        );
      }
    }

    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("q:multi:confirm:")) {
    const questionId = Number(data.slice("q:multi:confirm:".length));
    const response = await ctx.db
      .prepare("SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1")
      .bind(userId)
      .first<{ id: number; survey_id: number }>();

    if (!response) {
      await answerCallbackQuery(ctx.botToken, callback.id);
      return;
    }

    const selected = await getSessionSelectedOptions(
      ctx.session,
      userId,
      response.survey_id,
    );
    await upsertOptionAnswer(ctx.db, {
      responseId: response.id,
      questionId,
      selectedOptionIds: selected,
    });
    await clearSessionOptions(ctx.session, userId, response.survey_id);

    const flow = await getSurveyFlow(ctx.db, response.survey_id);
    await advanceQuestion(
      ctx,
      chatId,
      response.id,
      questionId,
      flow.questions,
      userId,
      response.survey_id,
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("q:prev:")) {
    const questionId = Number(data.slice("q:prev:".length));
    const response = await ctx.db
      .prepare("SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1")
      .bind(userId)
      .first<{ id: number; survey_id: number }>();

    if (!response) {
      await answerCallbackQuery(ctx.botToken, callback.id);
      return;
    }

    const flow = await getSurveyFlow(ctx.db, response.survey_id);
    const previous = getPreviousQuestion({ questions: flow.questions }, questionId);
    if (previous) {
      await updateResponseCurrentQuestion(ctx.db, response.id, previous.id);
      await setSessionCurrentQuestion(
        ctx.session,
        userId,
        response.survey_id,
        previous.id,
      );
      await renderQuestion(
        ctx,
        chatId,
        response.id,
        previous,
        flow.questions,
        userId,
        response.survey_id,
      );
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "q:submit") {
    const response = await ctx.db
      .prepare("SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1")
      .bind(userId)
      .first<{ id: number; survey_id: number }>();

    if (response) {
      await completeResponse(ctx.db, response.id);
      await completeSession(ctx.session, userId, response.survey_id);
      await sendMessage(ctx.botToken, chatId, "问卷已提交，感谢参与。");
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "q:exit") {
    const response = await ctx.db
      .prepare("SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1")
      .bind(userId)
      .first<{ id: number; survey_id: number }>();

    if (response) {
      await cancelResponse(ctx.db, response.id);
      await completeSession(ctx.session, userId, response.survey_id);
      await sendMessage(ctx.botToken, chatId, "已退出当前问卷。");
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("owner:questions:")) {
    const surveyId = Number(data.slice("owner:questions:".length));
    await showQuestionList(ctx, chatId, userId, surveyId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:list:")) {
    const surveyId = Number(data.slice("qedit:list:".length));
    await showQuestionList(ctx, chatId, userId, surveyId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:view:")) {
    const questionId = Number(data.slice("qedit:view:".length));
    await showQuestionEditor(ctx, chatId, userId, questionId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:required:")) {
    const questionId = Number(data.slice("qedit:required:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (question) {
      await updateQuestionRequired(ctx.db, questionId, !question.required);
      await showQuestionEditor(ctx, chatId, userId, questionId);
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:copy:")) {
    const questionId = Number(data.slice("qedit:copy:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (question) {
      await duplicateQuestion(ctx.db, questionId);
      await showQuestionList(ctx, chatId, userId, question.surveyId);
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:delete:")) {
    const questionId = Number(data.slice("qedit:delete:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (question) {
      await ctx.db.prepare("DELETE FROM survey_questions WHERE id = ?").bind(questionId).run();
      await showQuestionList(ctx, chatId, userId, question.surveyId);
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:up:")) {
    const questionId = Number(data.slice("qedit:up:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (question) {
      const questions = await listQuestionsBySurvey(ctx.db, question.surveyId);
      const index = questions.findIndex((item) => item.id === questionId);
      const previous = questions[index - 1];
      if (previous) {
        await swapQuestionOrder(ctx.db, questionId, previous.id);
      }
      await showQuestionList(ctx, chatId, userId, question.surveyId);
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:down:")) {
    const questionId = Number(data.slice("qedit:down:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (question) {
      const questions = await listQuestionsBySurvey(ctx.db, question.surveyId);
      const index = questions.findIndex((item) => item.id === questionId);
      const next = questions[index + 1];
      if (next) {
        await swapQuestionOrder(ctx.db, questionId, next.id);
      }
      await showQuestionList(ctx, chatId, userId, question.surveyId);
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  await answerCallbackQuery(ctx.botToken, callback.id, "未知操作");
}
