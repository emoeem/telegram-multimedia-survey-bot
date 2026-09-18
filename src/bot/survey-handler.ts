import { cancelResponse, getActiveResponseByUser, getResponseById } from "../db/repositories/response.repository";
import {
  getSurveyById,
  listAllSurveys,
  setSurveyAccessCode,
  updateSurveyResponsePolicy,
  updateSurveyStatus,
} from "../db/repositories/survey.repository";
import { deleteOptionMedia, deleteQuestionMedia } from "../db/repositories/media.repository";
import {
  deleteQuestion,
  deleteQuestionOption,
  duplicateQuestion,
  getQuestionById as getQuestionEntityById,
  getQuestionOptionById,
  listQuestionsBySurvey,
  listOptionsForQuestions,
  swapQuestionOptionOrder,
  swapQuestionOrder,
  updateQuestionRequired,
  setQuestionSkipRule,
} from "../db/repositories/question.repository";
import { getUserByTelegramId, markBotStarted } from "../db/repositories/user.repository";
import {
  countResponsesForParticipantKey,
  getParticipantLink,
  linkResponsesToUser,
  upsertParticipantLink,
} from "../db/repositories/participant-link.repository";
import { assertCanManageSurvey, canCreateSurvey, isAdmin } from "../services/permission.service";
import {
  assertSurveyQuestionsEditable,
  duplicateSurvey,
  listMySurveys as listOwnedSurveys,
  publishSurvey,
} from "../services/survey.service";

import { type SurveyExportFormat } from "../services/export-queue.service";
import { requestConfiguredResultVisual } from "../services/result-visual.service";

import { getSurveyFlow } from "../services/question.service";
import { completeSession } from "../services/session.service";
import { ADMIN_LOGIN_TTL_SECONDS, createBrowserLoginToken } from "../services/admin-session.service";
import { createSurveyParticipantToken, SURVEY_PARTICIPANT_TOKEN_PARAM } from "../services/participant-session.service";
import { loadSystemSettings } from "../services/system-settings.service";

import {
  answerCallbackQuery,
  getBotUsername,
  getChat,
  sendLongMessage,
  sendMessage,
  sendPhoto,
  type InlineKeyboardMarkup,
} from "./telegram";
import { renderUiScreen } from "./ui";
import { renderScreen } from "./ui-message-controller";
import type { BotContext, TelegramCallbackQuery, TelegramMessage } from "./types";
import {
  clearBuilderInteractionState,
  handleBuilderCallback,
  handleBuilderMessage,
  startBuilder,
} from "./builder-handler";
import {
  getBuilderState,
  initBuilder,
  startAddQuestionOption,
  startAppendQuestions,
  startEditOptionLabel,
  startEditQuestionTitle,
  startOptionMedia,
  startQuestionMedia,
  startSetSurveyAccessCode,
} from "../services/survey-builder.service";
import { clearAdminInteractionState, handleAdminCallback, handleAdminMessage } from "./admin-handler";
import { decryptSurveyAccessCode } from "../core/security";
import { REPORT_CHANNEL_CACHE_KEY, reportChannelPendingKey } from "../services/report-delivery.service";
import { botCanManageChannel, REPORT_CHANNEL_DETECT_REQUEST_KEY } from "./channel-detection";
import type { Survey } from "../db/schema";
import { showQuestionEditor, showQuestionList } from "./question-editor";
import {
  getCompletionPosterSetting,
  saveCompletionPosterSetting,
  type CompletionPosterStyle,
} from "../db/repositories/completion-poster.repository";
import { renderCompletionPoster } from "../services/completion-poster.service";
import {
  createSurveyFromTemplate,
  listSurveyTemplates,
  type SurveyTemplate,
} from "../services/survey-template.service";
import {
  clearImageGeneratorInteractionState,
  ensureReportStyleTemplates,
  handleImageGeneratorCallback,
  handleImageGeneratorParticipantMessage,
} from "./image-generator-handler";
import { clearResultVisualInteractionState } from "./result-visual-admin-handler";
import { clearUiSession } from "../services/ui-session.service";
import { clearPlazaInteractionState, handlePlazaCallback, handlePlazaMessage } from "./plaza-handler";
import { listVisualTemplates } from "../db/repositories/visual-template.repository";
import { sendSurveyExport, sendSurveyJsonExport } from "./survey-report";
import { handleReportCallbacks } from "./survey-callbacks";

// Kept re-exported for the export worker's dynamic import.
export { sendResponseReportExport } from "./survey-report";

const botUsernameCacheKey = "telegram-bot-username";
const publicSurveySearchKeyPrefix = "public-survey-search:";
const publicSurveySearchInputKeyPrefix = "public-survey-search-input:";

function publicSurveySearchKey(userId: number): string {
  return `${publicSurveySearchKeyPrefix}${userId}`;
}

function publicSurveySearchInputKey(userId: number): string {
  return `${publicSurveySearchInputKeyPrefix}${userId}`;
}

async function getSurveyShareUrl(ctx: BotContext, surveyId: number): Promise<string> {
  let username = await ctx.cache?.get(botUsernameCacheKey);
  if (!username) {
    username = await getBotUsername(ctx.botToken);
    await ctx.cache?.put(botUsernameCacheKey, username, {
      expirationTtl: 7 * 24 * 60 * 60,
    });
  }
  return `https://t.me/${username}?start=survey_${surveyId}`;
}

/** Resolves and sends the bot entry that opens the configured profile questionnaire. */
async function promptProfileQuestionnaire(
  ctx: BotContext,
  chatId: number,
  userId: number,
  isAdminUser: boolean,
  messageId?: number,
): Promise<void> {
  const system = await loadSystemSettings(ctx.db);
  const surveyId = Number(system.profileGallerySurveyId);
  const survey = Number.isInteger(surveyId) && surveyId > 0 ? await getSurveyById(ctx.db, surveyId) : null;
  if (!survey || survey.status !== "published") {
    const text = isAdminUser
      ? "🪪 个人资料问卷还未启用。\n\n请先在网页后台「系统设置」→ 个人画廊问卷 中选择一份已发布的问卷，然后在机器人里重试。"
      : "🪪 个人资料问卷暂时还未开放，请稍后再来。";
    const markup: InlineKeyboardMarkup = {
      inline_keyboard: [[{ text: "返回主菜单", callback_data: "home:menu" }]],
    };
    if (messageId !== undefined) {
      await renderScreen({
        botToken: ctx.botToken,
        chatId,
        userId,
        messageId,
        screen: "PROFILE_UNAVAILABLE",
        text,
        replyMarkup: markup,
      });
    } else {
      await sendMessage(ctx.botToken, chatId, text, markup);
    }
    return;
  }

  const participantParam =
    ctx.webhookSecret && userId
      ? `&${SURVEY_PARTICIPANT_TOKEN_PARAM}=${encodeURIComponent(
          await createSurveyParticipantToken(ctx.webhookSecret, userId),
        )}`
      : "";
  const fillUrl = ctx.origin ? `${ctx.origin}/s/${survey.id}?v=3${participantParam}` : null;
  const shareUrl = await getSurveyShareUrl(ctx, survey.id);
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    ...(fillUrl ? [[{ text: "📝 填写我的个人资料", url: fillUrl }]] : []),
    [{ text: "📤 分享这份问卷给朋友", url: shareUrl }],
    [{ text: "返回主菜单", callback_data: "home:menu" }],
  ];
  const text = [
    `🪪 个人资料 · ${survey.title}`,
    "",
    "点下方按钮在网页上填写资料并上传照片。",
    "提交时勾选「发布到个人画廊」，朋友就能在广场看到你的资料卡。",
    "",
    "也可以把这份问卷分享给朋友，让大家一起填写。",
  ].join("\n");
  if (messageId !== undefined) {
    await renderScreen({
      botToken: ctx.botToken,
      chatId,
      userId,
      messageId,
      screen: "PROFILE_START",
      text,
      replyMarkup: { inline_keyboard: rows },
    });
  } else {
    await sendMessage(ctx.botToken, chatId, text, { inline_keyboard: rows });
  }
}

/**
 * Fallback for deployments that do not set COMMUNITY_GROUP_URL. The web
 * surfaces read the variable directly, so a configured deployment shows the
 * same invite in both places.
 */
const DEFAULT_COMMUNITY_GROUP_URL = "https://t.me/+Zh5pq2dxN5xkYTcx";

function buildWelcomeText(
  creator: boolean,
  first_name?: string,
  opts?: { returning?: boolean; reset?: boolean },
  communityGroupUrl?: string | null,
): string {
  const greet = first_name ? `${first_name}` : "朋友";
  const header = opts?.returning
    ? opts?.reset
      ? `👋 欢迎回来，${greet}！已清理未完成操作，从问卷机器人重新开始～`
      : `👋 欢迎回来，${greet}！欢迎回到问卷机器人～`
    : `👋 你好，${greet}！欢迎来到问卷机器人～`;
  const creatorExtra = creator ? "\n✨ 作为创作者，你还可以发布自己的问卷、查看填写报告、管理权限。" : "";
  return `${header}

这里不只是填问卷 —— 还有很多有意思的事可以做：

📝 浏览问卷 —— 参与社区问卷，分享你的想法
🪪 我的资料 —— 设置头像、简介、隐私
🌳 树洞 —— 匿名倾诉心事，温柔接住情绪
🏛 广场 —— 分享故事、点赞互动，遇见同频的人
🎯 挑战任务 —— 趣味打卡，解锁成就${creatorExtra}

💬 欢迎加入社群一起交流：
${communityGroupUrl || DEFAULT_COMMUNITY_GROUP_URL}

🔑 问卷密码、软件授权或部署支持，请联系 @ehdhhsbot。`;
}

async function buildHomeKeyboard(
  creator: boolean,
  administrator: boolean,
  origin?: string,
  webhookSecret?: string,
  userId?: number,
  from?: { username?: string; first_name?: string; last_name?: string; language_code?: string },
  submissionBotUrl?: string | null,
): Promise<InlineKeyboardMarkup> {
  const participantParam =
    webhookSecret && userId
      ? `&${SURVEY_PARTICIPANT_TOKEN_PARAM}=${await createSurveyParticipantToken(webhookSecret, userId, from ?? undefined)}`
      : "";
  const trialUrl = origin ? `${origin}/trial${participantParam ? `?${participantParam.slice(1)}` : ""}` : null;
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    origin
      ? [{ text: "浏览问卷", url: `${origin}/s?v=3${participantParam}` }]
      : [{ text: "浏览问卷", callback_data: "home:surveys" }],
    [{ text: "🪪 我的个人资料", callback_data: "profile:start" }],
    origin
      ? [{ text: "🌳 树洞", url: `${origin}/plaza?tab=treehole` }]
      : [{ text: "🌳 树洞", callback_data: "plaza:treehole:0" }],
    origin ? [{ text: "🏛 广场", url: `${origin}/plaza` }] : [{ text: "🏛 广场 · 树洞", callback_data: "plaza:list" }],
    ...(trialUrl ? [[{ text: "🎯 挑战任务", url: trialUrl }]] : []),
  ];
  // Same jump the web surfaces carry: a direct Telegram deep link, so it works
  // from inside the chat without leaving for the browser first.
  if (submissionBotUrl) {
    rows.push([{ text: "📮 投稿机器人", url: submissionBotUrl }]);
  }
  if (creator) {
    if (origin) {
      rows.push([{ text: "🌐 网页管理后台", url: `${origin}/admin` }]);
    }
    rows.push([{ text: "我的问卷", callback_data: "home:my_surveys" }]);
  }
  if (administrator) {
    rows.push([{ text: "管理员中心", callback_data: "admin:home" }]);
  }
  return { inline_keyboard: rows };
}

async function showHomeMenu(
  ctx: BotContext,
  chatId: number,
  userId: number,
  dbUser: NonNullable<Awaited<ReturnType<typeof getUserByTelegramId>>>,
  messageId?: number,
  from?: { username?: string; first_name?: string; last_name?: string; language_code?: string },
): Promise<void> {
  const creator = await canCreateSurvey(ctx.db, dbUser, ctx.adminIds);
  const text = buildWelcomeText(creator, from?.first_name, { returning: creator }, ctx.communityGroupUrl);
  await renderScreen({
    botToken: ctx.botToken,
    chatId,
    userId,
    screen: "home",
    text,
    replyMarkup: await buildHomeKeyboard(
      creator,
      isAdmin(userId, ctx.adminIds),
      ctx.origin,
      ctx.webhookSecret,
      userId,
      from,
      ctx.submissionBotUrl,
    ),
    ...(messageId === undefined ? {} : { messageId }),
  });
}

async function showCreateMenu(ctx: BotContext, chatId: number, userId: number): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user || !(await canCreateSurvey(ctx.db, user, ctx.adminIds))) {
    await sendMessage(ctx.botToken, chatId, "你没有创建问卷的权限。");
    return;
  }
  await renderUiScreen(ctx, chatId, userId, {
    screen: "create_menu",
    text: "创建问卷\n\n选择一种开始方式：",
    replyMarkup: {
      inline_keyboard: [
        [{ text: "➕ 新建问卷", callback_data: "home:new_survey" }],
        [{ text: "📝 继续草稿", callback_data: "home:continue" }],
        [{ text: "📥 导入或复制", callback_data: "home:import_or_copy" }],
      ],
    },
  });
}

async function showNewSurveyMenu(ctx: BotContext, chatId: number, userId: number): Promise<void> {
  await renderUiScreen(ctx, chatId, userId, {
    screen: "new_survey",
    text: "新建问卷\n\n选择空白问卷，或先从模板开始：",
    replyMarkup: {
      inline_keyboard: [
        [{ text: "从空白问卷开始", callback_data: "home:create" }],
        [{ text: "从模板开始", callback_data: "home:templates" }],
        [{ text: "⬅️ 返回", callback_data: "home:create_menu" }],
      ],
    },
  });
}

async function showImportOrCopyMenu(ctx: BotContext, chatId: number, userId: number): Promise<void> {
  await renderUiScreen(ctx, chatId, userId, {
    screen: "import_or_copy",
    text: "导入或复制\n\n导入 JSON 文件，或复制自己已有的问卷：",
    replyMarkup: {
      inline_keyboard: [
        [{ text: "导入 JSON 问卷", callback_data: "home:import_json" }],
        [{ text: "复制已有问卷", callback_data: "home:copy_list" }],
        [{ text: "⬅️ 返回", callback_data: "home:create_menu" }],
      ],
    },
  });
}

function builderOwnsNextMessage(state: Awaited<ReturnType<typeof getBuilderState>>): boolean {
  return Boolean(
    state &&
    [
      "import",
      "add_question_option",
      "option_media",
      "question_media_existing",
      "edit_option_label",
      "edit_question_title",
      "set_survey_access_code",
    ].includes(state.step),
  );
}

async function assertCanEditSurveyQuestions(
  ctx: BotContext,
  user: Awaited<ReturnType<typeof getUserByTelegramId>>,
  surveyId: number,
): Promise<void> {
  if (!user) {
    throw new Error("用户不存在");
  }
  await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
  await assertSurveyQuestionsEditable(ctx.db, surveyId);
}

async function listMySurveys(
  ctx: BotContext,
  chatId: number,
  userId: number,
  filter?: Survey["status"],
  page = 0,
  messageId?: number,
): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) {
    await sendMessage(ctx.botToken, chatId, "用户信息不存在，请重新 /start。");
    return;
  }

  const surveys = (await listOwnedSurveys(ctx.db, user.id)).filter((survey) => !filter || survey.status === filter);
  if (surveys.length === 0) {
    await sendMessage(ctx.botToken, chatId, "你还没有创建问卷。");
    return;
  }

  const pageSize = 8;
  const lastPage = Math.max(0, Math.ceil(surveys.length / pageSize) - 1);
  const safePage = Math.max(0, Math.min(page, lastPage));
  const pageSurveys = surveys.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [
      { text: "全部", callback_data: "owner:list:all" },
      { text: "草稿", callback_data: "owner:list:draft" },
      { text: "已发布", callback_data: "owner:list:published" },
      { text: "已关闭", callback_data: "owner:list:closed" },
    ],
    ...pageSurveys.map((survey) => [
      {
        text: `${survey.status === "draft" ? "📝" : survey.status === "published" ? "🟢" : "⚫"} ${compactSurveyTitle(survey.title)}`,
        callback_data: `owner:survey:${survey.id}`,
      },
    ]),
  ];

  if (lastPage > 0) {
    const navigation: InlineKeyboardMarkup["inline_keyboard"][number] = [];
    if (safePage > 0) {
      navigation.push({ text: "⬅️ 上一页", callback_data: `owner:list:${filter ?? "all"}:${safePage - 1}` });
    }
    if (safePage < lastPage) {
      navigation.push({ text: "下一页 ➡️", callback_data: `owner:list:${filter ?? "all"}:${safePage + 1}` });
    }
    rows.push(navigation);
  }

  const text = `我的问卷${filter ? ` · ${filter === "draft" ? "草稿" : filter === "published" ? "已发布" : "已关闭"}` : ""}\n\n第 ${safePage + 1}/${lastPage + 1} 页 · 共 ${surveys.length} 份\n\n选择一份问卷进入管理。`;
  if (messageId !== undefined) {
    await renderScreen({
      botToken: ctx.botToken,
      chatId,
      userId,
      messageId,
      screen: "MY_SURVEYS",
      text,
      replyMarkup: { inline_keyboard: rows },
    });
    return;
  }
  await sendMessage(ctx.botToken, chatId, text, { inline_keyboard: rows });
}

function compactSurveyTitle(title: string, maxLength = 32): string {
  const compact = title.replace(/\s+/g, " ").trim();
  return Array.from(compact).length <= maxLength
    ? compact
    : `${Array.from(compact)
        .slice(0, maxLength - 1)
        .join("")}…`;
}

export function cleanSurveyDescription(description: string | null): string | null {
  const compact = description?.replace(/\s+/g, " ").trim() ?? "";
  if (!compact || /^Imported from Microsoft Forms PDF\.?$/i.test(compact)) {
    return null;
  }
  return compact;
}

async function listManageableSurveys(ctx: BotContext, userId: number): Promise<Survey[]> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) throw new Error("用户信息不存在，请重新 /start。");
  if (user.systemRole === "admin" || isAdmin(user.telegramUserId, ctx.adminIds)) {
    return listAllSurveys(ctx.db);
  }
  return listOwnedSurveys(ctx.db, user.id);
}

export async function showSurveyPasswordMenu(ctx: BotContext, chatId: number, userId: number): Promise<void> {
  const surveys = await listManageableSurveys(ctx, userId);
  if (surveys.length === 0) {
    await sendMessage(ctx.botToken, chatId, "当前没有可管理的问卷。");
    return;
  }

  const rows: InlineKeyboardMarkup["inline_keyboard"] = surveys.map((survey, index) => [
    {
      text: `${survey.accessCode ? "🔐 已保护" : "🔓 未设置"} · ${compactSurveyTitle(survey.title)}`,
      callback_data: `owner:access_view:${survey.id}`,
    },
  ]);
  await sendMessage(
    ctx.botToken,
    chatId,
    [
      "🔐 问卷访问密码",
      "",
      `已保护：${surveys.filter((survey) => survey.accessCode).length} 份`,
      `未设置：${surveys.filter((survey) => !survey.accessCode).length} 份`,
      "",
      "点选问卷后可查看、设置、更换或移除访问密码。",
    ].join("\n"),
    { inline_keyboard: rows },
  );
}

async function showSurveyPasswordDetails(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) throw new Error("用户信息不存在");
  await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
  const survey = await getSurveyById(ctx.db, surveyId);
  if (!survey) throw new Error("问卷不存在");

  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [
      {
        text: survey.accessCode ? "✏️ 更换密码" : "➕ 设置密码",
        callback_data: `owner:access_set:${survey.id}`,
      },
    ],
  ];
  if (survey.accessCode) {
    if (survey.accessCodeEncrypted) {
      rows.push([
        {
          text: "👁 查看当前密码",
          callback_data: `owner:access_reveal:${survey.id}`,
        },
      ]);
    }
    rows.push([
      {
        text: "🗑 移除访问密码",
        callback_data: `owner:access_clear_ask:${survey.id}`,
      },
    ]);
  }
  rows.push([
    {
      text: "⬅️ 返回问卷列表",
      callback_data: "owner:access_codes",
    },
  ]);

  await sendMessage(
    ctx.botToken,
    chatId,
    [
      "🔐 问卷访问密码",
      "",
      `问卷：${survey.title}`,
      `当前状态：${survey.accessCode ? "已开启保护" : "未设置，任何人都可直接填写"}`,
      survey.accessCode ? `最后更新：${survey.updatedAt.replace("T", " ").slice(0, 16)}` : "",
      "",
      survey.accessCode
        ? survey.accessCodeEncrypted
          ? "可点击“查看当前密码”；也可随时更换。"
          : "这是旧版设置的密码，无法恢复明文；更换一次后即可查看。"
        : "设置后，参与者开始填写前必须输入正确密码。",
    ].join("\n"),
    { inline_keyboard: rows },
  );
}

async function beginSurveyPasswordInput(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) throw new Error("用户不存在");
  await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
  const survey = await getSurveyById(ctx.db, surveyId);
  if (!survey) throw new Error("问卷不存在");
  await initBuilder(ctx.builder, userId);
  await startSetSurveyAccessCode(ctx.builder, userId, surveyId);
  await sendMessage(
    ctx.botToken,
    chatId,
    [
      `正在为问卷“${survey.title}”${survey.accessCode ? "更换" : "设置"}访问密码。`,
      "",
      "请直接发送新密码，长度为 4 到 64 个字符；保存后会显示一次，方便复制。",
      "发送 /cancel 取消。",
    ].join("\n"),
  );
}

async function sendSurveyPreview(ctx: BotContext, chatId: number, userId: number, surveyId: number): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) {
    throw new Error("用户信息不存在");
  }
  await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);

  const flow = await getSurveyFlow(ctx.db, surveyId);
  if (flow.questions.length === 0) {
    throw new Error("问卷没有题目");
  }
  const preview = flow.questions
    .map((question, index) => {
      const options = question.options.map((option, optionIndex) => `  ${optionIndex + 1}. ${option.label}`).join("\n");
      return `第 ${index + 1} 题\n${question.title}${options ? `\n${options}` : ""}`;
    })
    .join("\n\n");
  await sendLongMessage(ctx.botToken, chatId, preview);
}

async function duplicateManagedSurvey(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) {
    throw new Error("用户信息不存在");
  }
  await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
  const duplicated = await duplicateSurvey(ctx.db, surveyId, user.id);
  await sendMessage(ctx.botToken, chatId, `已复制问卷，新问卷内部编号：${duplicated.id}`, {
    inline_keyboard: [
      [
        {
          text: "编辑新问卷",
          callback_data: `owner:questions:${duplicated.id}`,
        },
        {
          text: "发布新问卷",
          callback_data: `owner:publish_ask:${duplicated.id}`,
        },
      ],
    ],
  });
}

export async function showSurveyStats(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
  messageId?: number,
): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) {
    await sendMessage(ctx.botToken, chatId, "用户信息不存在。");
    return;
  }

  try {
    await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
  } catch (error) {
    await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "无权查看该问卷。");
    return;
  }

  const survey = await getSurveyById(ctx.db, surveyId);
  if (!survey) {
    await sendMessage(ctx.botToken, chatId, "问卷不存在。");
    return;
  }
  const statusLabel =
    survey.status === "draft"
      ? "草稿"
      : survey.status === "published"
        ? "已发布"
        : survey.status === "closed"
          ? "已关闭"
          : "已归档";
  const text = `📋 ${survey.title}\n内部编号：${surveyId}\n状态：${statusLabel}\n\n完整编辑、统计和访问设置请进入网页后台。`;
  const statusAction =
    survey.status === "published"
      ? { text: "⏹ 关闭问卷", callback_data: `owner:close:${surveyId}` }
      : {
          text: survey.status === "draft" ? "🚀 发布确认" : "🚀 重新发布",
          callback_data: `owner:publish_ask:${surveyId}`,
        };
  const replyMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [
      ...(ctx.origin ? [[{ text: "🌐 打开网页编辑器", url: `${ctx.origin}/admin/surveys/${surveyId}/editor` }]] : []),
      [statusAction],
      [{ text: "📦 导出数据", callback_data: `owner:reports:${surveyId}` }],
      [{ text: "⬅️ 返回我的问卷", callback_data: "home:my_surveys" }],
    ],
  };
  if (messageId !== undefined) {
    await renderScreen({
      botToken: ctx.botToken,
      chatId,
      userId,
      messageId,
      screen: "SURVEY_DETAIL",
      text,
      replyMarkup,
    });
    return;
  }
  await sendMessage(ctx.botToken, chatId, text, replyMarkup);
}

async function showSurveyContentMenu(ctx: BotContext, chatId: number, userId: number, surveyId: number): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) throw new Error("用户信息不存在");
  await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
  const survey = await getSurveyById(ctx.db, surveyId);
  if (!survey) throw new Error("问卷不存在");

  const publication =
    survey.status === "draft"
      ? { text: "🚀 发布前检查", callback_data: `owner:publish_ask:${surveyId}` }
      : survey.status === "published"
        ? { text: "⏹ 关闭问卷", callback_data: `owner:close:${surveyId}` }
        : { text: "🚀 重新发布", callback_data: `owner:publish_ask:${surveyId}` };

  await renderUiScreen(ctx, chatId, userId, {
    screen: "survey_content",
    text: [
      "📝 内容与发布",
      "",
      `“${survey.title}”当前为${survey.status === "draft" ? "草稿" : survey.status === "published" ? "已发布" : "已关闭"}状态。`,
      survey.status === "published" ? "用户提交答卷不会自动关闭问卷，需要时请手动关闭。" : "",
    ]
      .filter(Boolean)
      .join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [{ text: "✏️ 编辑题目", callback_data: `owner:questions:${surveyId}` }],
        [publication, { text: "👀 预览填写", callback_data: `owner:preview:${surveyId}` }],
        [
          {
            text: `🔁 重复填写：${survey.allowMultipleResponses ? "允许（不限次数）" : "禁止"}`,
            callback_data: `owner:repeat_toggle:${surveyId}`,
          },
        ],
        ...(survey.status === "published"
          ? [[{ text: "🔗 分享问卷链接", callback_data: `owner:share:${surveyId}` }]]
          : []),
        [{ text: "📋 复制为新问卷", callback_data: `owner:duplicate:${surveyId}` }],
        [{ text: "⬅️ 返回问卷概览", callback_data: `owner:survey:${surveyId}` }],
      ],
    },
    state: { surveyId },
  });
}

async function showSurveyShareLink(ctx: BotContext, chatId: number, userId: number, surveyId: number): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) throw new Error("用户信息不存在");
  await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
  const survey = await getSurveyById(ctx.db, surveyId);
  if (!survey) throw new Error("问卷不存在");
  if (survey.status !== "published") {
    throw new Error("请先发布问卷，发布后才能生成分享链接");
  }
  const url = await getSurveyShareUrl(ctx, surveyId);
  const webUrl = ctx.origin ? `${ctx.origin}/s/${surveyId}?v=3` : null;
  await renderUiScreen(ctx, chatId, userId, {
    screen: "survey_share",
    text: [
      `🔗 ${survey.title}`,
      "",
      "把链接发给对方即可填写问卷。",
      "Telegram 链接会在机器人对话内打开网页填写；网页链接可在浏览器中填写（支持手机/桌面）。",
      survey.accessCode ? "该问卷已设置访问密码，接收者进入后仍需输入密码。" : "",
      "",
      url,
      ...(webUrl ? ["", "网页版：", webUrl] : []),
    ]
      .filter(Boolean)
      .join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [{ text: "Telegram 打开", url }],
        ...(webUrl ? [[{ text: "🌐 网页版打开", url: webUrl }]] : []),
      ],
    },
    state: { surveyId },
  });
}

async function showSurveyReportsMenu(ctx: BotContext, chatId: number, userId: number, surveyId: number): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) throw new Error("用户信息不存在");
  await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
  const survey = await getSurveyById(ctx.db, surveyId);
  if (!survey) throw new Error("问卷不存在");

  await renderUiScreen(ctx, chatId, userId, {
    screen: "survey_exports",
    text: `📦 导出数据\n\n选择“${survey.title}”的导出格式。文件生成后会自动发送。`,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "CSV", callback_data: `owner:export:csv:${surveyId}` },
          { text: "ZIP", callback_data: `owner:export:zip:${surveyId}` },
          { text: "JSON", callback_data: `owner:export_json:${surveyId}` },
        ],
        [{ text: "⬅️ 返回问卷概览", callback_data: `owner:survey:${surveyId}` }],
      ],
    },
    state: { surveyId },
  });
}

async function showCompletionPosterMenu(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) throw new Error("用户信息不存在");
  await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
  const setting = await getCompletionPosterSetting(ctx.db, surveyId);
  const labels: Record<CompletionPosterStyle, string> = {
    clean: "简洁",
    cute: "可爱",
    editorial: "杂志感",
    bold: "强对比",
  };
  await renderUiScreen(ctx, chatId, userId, {
    screen: "poster_settings",
    text: [
      "完成海报",
      setting.enabled
        ? `已开启，当前风格：${labels[setting.style]}。`
        : "当前未开启。开启后答卷者完成时会收到一张 PNG 海报。",
      "问卷封面会优先显示；没有封面时自动尝试使用第一张题目图片。",
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [{ text: setting.enabled ? "关闭海报" : "开启海报", callback_data: `owner:poster_toggle:${surveyId}` }],
        [
          { text: "简洁", callback_data: `owner:poster_style:${surveyId}:clean` },
          { text: "预览", callback_data: `owner:poster_preview:${surveyId}:clean` },
        ],
        [
          { text: "可爱", callback_data: `owner:poster_style:${surveyId}:cute` },
          { text: "预览", callback_data: `owner:poster_preview:${surveyId}:cute` },
        ],
        [
          { text: "杂志感", callback_data: `owner:poster_style:${surveyId}:editorial` },
          { text: "预览", callback_data: `owner:poster_preview:${surveyId}:editorial` },
        ],
        [
          { text: "强对比", callback_data: `owner:poster_style:${surveyId}:bold` },
          { text: "预览", callback_data: `owner:poster_preview:${surveyId}:bold` },
        ],
        [{ text: "返回统计", callback_data: `owner:survey:${surveyId}` }],
      ],
    },
    state: { surveyId },
  });
}

async function showPublishCheck(ctx: BotContext, chatId: number, userId: number, surveyId: number): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) throw new Error("用户信息不存在");
  await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
  const survey = await getSurveyById(ctx.db, surveyId);
  if (!survey) throw new Error("问卷不存在");
  const questions = await listQuestionsBySurvey(ctx.db, surveyId);
  const options = await listOptionsForQuestions(
    ctx.db,
    questions.map((question) => question.id),
  );
  const issues: string[] = [];
  if (questions.length === 0) issues.push("没有题目");
  for (const question of questions) {
    if (!question.title.trim()) issues.push(`第 ${question.order + 1} 题没有标题`);
    if (
      ["single", "multiple", "yes_no", "rating"].includes(question.type) &&
      options.filter((option) => option.questionId === question.id).length < 2
    ) {
      issues.push(`第 ${question.order + 1} 题选项不足两个`);
    }
  }
  const settings = [
    `题目：${questions.length} 道`,
    `访问密码：${survey.accessCode ? "已设置" : "未设置"}`,
    `重复填写：${survey.allowMultipleResponses ? `允许，最多 ${survey.maxResponsesPerUser || "不限"} 次` : "不允许"}`,
  ];
  await renderUiScreen(ctx, chatId, userId, {
    screen: "publish_check",
    text: [
      "发布前检查",
      "",
      ...settings,
      "",
      issues.length > 0 ? `发现问题：\n${issues.map((issue) => `- ${issue}`).join("\n")}` : "检查通过，可以发布。",
    ].join("\n"),
    replyMarkup: {
      inline_keyboard:
        issues.length > 0
          ? [
              ...(ctx.origin
                ? [[{ text: "🌐 前往网页编辑器修正", url: `${ctx.origin}/admin/surveys/${surveyId}/editor` }]]
                : []),
              [{ text: "返回问卷", callback_data: `owner:survey:${surveyId}` }],
            ]
          : [
              [{ text: "确认发布", callback_data: `owner:publish_confirm:${surveyId}` }],
              ...(ctx.origin
                ? [[{ text: "🌐 打开网页编辑器", url: `${ctx.origin}/admin/surveys/${surveyId}/editor` }]]
                : []),
              [{ text: "返回问卷", callback_data: `owner:survey:${surveyId}` }],
            ],
    },
    state: { surveyId },
  });
}

async function listSurveys(
  ctx: BotContext,
  chatId: number,
  userId?: number,
  page = 0,
  sort: "latest" | "popular" = "latest",
  messageId?: number,
  from?: { username?: string; first_name?: string; last_name?: string; language_code?: string },
): Promise<void> {
  const search = userId ? ((await ctx.cache?.get(publicSurveySearchKey(userId)))?.trim() ?? "") : "";
  const escapedSearch = search.replace(/[\\%_]/g, "\\$&");
  const where = search ? "AND (s.title LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\')" : "";
  const countBindings = search ? [`%${escapedSearch}%`, `%${escapedSearch}%`] : [];
  const countRow = await ctx.db
    .prepare(`SELECT COUNT(*) AS count FROM surveys s WHERE s.status = 'published' ${where}`)
    .bind(...countBindings)
    .first<{ count: number }>();
  const total = countRow?.count ?? 0;
  if (total === 0) {
    const text = search ? "没有匹配的已发布问卷。" : "当前没有已发布的问卷。";
    if (userId !== undefined && messageId !== undefined) {
      await renderScreen({
        botToken: ctx.botToken,
        chatId,
        userId,
        messageId,
        screen: "SURVEY_LIST",
        text,
        replyMarkup: { inline_keyboard: [[{ text: "⬅️ 返回首页", callback_data: "home:menu" }]] },
      });
    } else {
      await sendMessage(ctx.botToken, chatId, text, {
        inline_keyboard: [[{ text: "⬅️ 返回首页", callback_data: "home:menu" }]],
      });
    }
    return;
  }
  const pageSize = 8;
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const safePage = Math.min(Math.max(0, page), lastPage);
  const orderBy =
    sort === "popular" ? "completed_count DESC, s.published_at DESC, s.id DESC" : "s.published_at DESC, s.id DESC";
  const bindings = search
    ? [`%${escapedSearch}%`, `%${escapedSearch}%`, pageSize, safePage * pageSize]
    : [pageSize, safePage * pageSize];
  const result = await ctx.db
    .prepare(
      `SELECT s.id, s.title, s.description, s.access_code,
            SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed_count
     FROM surveys s
     LEFT JOIN survey_responses r ON r.survey_id = s.id
     WHERE s.status = 'published' ${where}
     GROUP BY s.id
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    )
    .bind(...bindings)
    .all<{
      id: number;
      title: string;
      description: string | null;
      access_code: string | null;
      completed_count: number | null;
    }>();
  const surveys = result.results ?? [];
  const participantParam =
    ctx.webhookSecret && userId !== undefined
      ? `&${SURVEY_PARTICIPANT_TOKEN_PARAM}=${await createSurveyParticipantToken(ctx.webhookSecret, userId, from ?? undefined)}`
      : "";
  const rows: InlineKeyboardMarkup["inline_keyboard"] = surveys.map((survey) => [
    {
      text: `${survey.access_code ? "🔐" : "📝"} ${compactSurveyTitle(survey.title, 32)}`,
      ...(ctx.origin ? { url: `${ctx.origin}/s/${survey.id}?v=3${participantParam}` } : { callback_data: "home:menu" }),
    },
  ]);
  const navigation: InlineKeyboardMarkup["inline_keyboard"][number] = [];
  if (safePage > 0) navigation.push({ text: "⬅️ 上一页", callback_data: `public:list:${safePage - 1}:${sort}` });
  if (safePage < lastPage) navigation.push({ text: "下一页 ➡️", callback_data: `public:list:${safePage + 1}:${sort}` });
  if (navigation.length) rows.push(navigation);
  rows.push([
    { text: "🔎 搜索问卷", callback_data: "public:search" },
    {
      text: sort === "latest" ? "🔥 热门优先" : "🕒 最新优先",
      callback_data: `public:sort:${sort === "latest" ? "popular" : "latest"}`,
    },
  ]);
  if (search) rows.push([{ text: "✖️ 清除搜索", callback_data: `public:clear:${sort}` }]);
  const descriptions = surveys.map((survey, index) => {
    const description = cleanSurveyDescription(survey.description);
    return [
      `${safePage * pageSize + index + 1}. ${compactSurveyTitle(survey.title, 48)}`,
      description ? `   ${description.slice(0, 56)}` : "",
      survey.access_code ? "   🔐 需要密码" : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  const text = [
    "浏览问卷",
    search ? `搜索：${search}` : sort === "popular" ? "排序：热门优先" : "排序：最新发布优先",
    `第 ${safePage + 1}/${lastPage + 1} 页 · 共 ${total} 份`,
    "",
    ...descriptions,
  ].join("\n");
  if (userId !== undefined && messageId !== undefined) {
    await renderScreen({
      botToken: ctx.botToken,
      chatId,
      userId,
      messageId,
      screen: "SURVEY_LIST",
      text,
      replyMarkup: { inline_keyboard: rows },
    });
  } else {
    await sendMessage(ctx.botToken, chatId, text, { inline_keyboard: rows });
  }
}

async function showResponseReportTemplates(
  ctx: BotContext,
  chatId: number,
  userId: number,
  messageId: number | undefined,
  responseId: number,
): Promise<void> {
  const response = await getResponseById(ctx.db, responseId);
  const dbUser = await getUserByTelegramId(ctx.db, userId);
  if (!response || !dbUser || response.userId !== dbUser.id || response.status !== "completed") {
    throw new Error("找不到可生成的已完成问卷");
  }
  // Keep the participant flow self-contained: the three supported report
  // styles are provisioned lazily and then receive this response's profile.
  try {
    await ensureReportStyleTemplates(ctx, dbUser.id);
  } catch (error) {
    console.warn("Report style provisioning failed", error);
  }
  const templates = (await listVisualTemplates(ctx.db, 100)).filter(
    (template) =>
      template.type === "report" &&
      template.status === "published" &&
      template.currentVersion &&
      (template.surveyId === null || template.surveyId === response.surveyId),
  );
  const rows: InlineKeyboardMarkup["inline_keyboard"] = templates.map((template) => [
    {
      text: `📊 ${template.name}`,
      callback_data: `rv:generate:${response.id}:${template.id}`,
    },
  ]);
  rows.push([{ text: "暂不生成", callback_data: `rv:skip:${response.id}` }]);
  // Finishing a survey is the moment people most often want to submit
  // something of their own, so the jump sits right here too.
  if (ctx.submissionBotUrl) {
    rows.push([{ text: "📮 投稿机器人", url: ctx.submissionBotUrl }]);
  }
  await renderScreen({
    botToken: ctx.botToken,
    chatId,
    userId,
    ...(messageId === undefined ? {} : { messageId }),
    screen: "RESULT_REPORT_TEMPLATES",
    text:
      templates.length > 0
        ? "✅ 问卷已完成！\n\n请选择一个报告模板生成你的专属报告："
        : "✅ 问卷已完成！\n\n当前没有可用的报告模板。",
    replyMarkup: { inline_keyboard: rows },
  });
}

export async function handleTelegramMessage(ctx: BotContext, message: TelegramMessage): Promise<void> {
  const text = message.text?.trim();
  const userId = message.from?.id;
  const dbUser = userId ? await getUserByTelegramId(ctx.db, userId) : null;
  const dbUserId = dbUser?.id;
  const canCreateFromCache = async (): Promise<boolean> => {
    if (!dbUser) return false;
    try {
      return await canCreateSurvey(ctx.db, dbUser, ctx.adminIds);
    } catch {
      return isAdmin(dbUser.telegramUserId, ctx.adminIds);
    }
  };
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

  // Commands must always win over every pending wizard.  This is deliberately
  // before search, generator, template and builder routing: /start is a hard
  // reset, while /cancel terminates an in-progress flow rather than becoming
  // invalid JSON or an invalid image upload.
  // Telegram sends `/start@bot_name` and `/cancel@bot_name` in groups.  These
  // commands must be treated exactly like their private-chat form, otherwise a
  // pending upload wizard can consume the command as ordinary text.
  const startMatch = text?.match(/^\/start(?:@[A-Za-z0-9_]{3,64})?(?:\s+([A-Za-z0-9_-]{1,64}))?$/);
  if (startMatch) {
    const payload = startMatch[1];
    const surveyId = Number(payload?.match(/^survey_(\d+)$/)?.[1]);
    if (dbUser) await markBotStarted(ctx.db, userId);
    const resetResults = await Promise.allSettled([
      ctx.cache?.delete(publicSurveySearchInputKey(userId)),
      ctx.cache?.delete(publicSurveySearchKey(userId)),
      clearImageGeneratorInteractionState(ctx, userId),
      clearResultVisualInteractionState(ctx, userId),
      clearBuilderInteractionState(ctx, userId),
      clearAdminInteractionState(ctx, userId),
      clearPlazaInteractionState(ctx, userId, message.chat.id),
      ctx.ui ? clearUiSession(ctx.ui, userId, message.chat.id).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    for (const result of resetResults) {
      if (result.status === "rejected") {
        console.warn("Start command interaction cleanup failed; continuing", result.reason);
      }
    }
    const linkKey = payload?.match(/^link_([A-Za-z0-9_-]{8,64})$/)?.[1];
    if (linkKey) {
      if (!dbUser) {
        await sendMessage(ctx.botToken, message.chat.id, "请先发送 /start 完成初始化，再重新打开绑定链接。");
        return;
      }
      const existing = await getParticipantLink(ctx.db, linkKey);
      if (existing) {
        await sendMessage(
          ctx.botToken,
          message.chat.id,
          existing.userId === dbUser.id
            ? "✅ 这个网页已经绑定到你的 Telegram 账号，无需重复操作。"
            : "⚠️ 这个网页绑定码已经关联了其他 Telegram 账号，不能重复使用。如果这是你的网页，请先清空浏览器站点数据后重新填写。",
        );
        return;
      }
      await upsertParticipantLink(ctx.db, { participantKey: linkKey, userId: dbUser.id });
      await linkResponsesToUser(ctx.db, { participantKey: linkKey, userId: dbUser.id });
      const total = await countResponsesForParticipantKey(ctx.db, linkKey);
      const displayName = message.from?.username
        ? `@${message.from.username}`
        : [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || `用户 ${userId}`;
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        `✅ 已关联 Telegram（${displayName}）\n\n` +
          `这个网页留下的 ${total} 份答卷记录已并入你的账号，之后从这个网页填写也会自动计入。\n\n` +
          "绑定链接相当于网页身份钥匙，请勿转发给他人。",
      );
      return;
    }
    if (Number.isSafeInteger(surveyId) && surveyId > 0) {
      if (ctx.origin) {
        const participantParam = ctx.webhookSecret
          ? `&${SURVEY_PARTICIPANT_TOKEN_PARAM}=${await createSurveyParticipantToken(ctx.webhookSecret, userId, message.from ?? undefined)}`
          : "";
        await sendMessage(
          ctx.botToken,
          message.chat.id,
          `📝 请打开问卷开始填写：${ctx.origin}/s/${surveyId}?v=3${participantParam}`,
          {
            inline_keyboard: [[{ text: "填写问卷", url: `${ctx.origin}/s/${surveyId}?v=3${participantParam}` }]],
          },
        );
      } else {
        await sendMessage(ctx.botToken, message.chat.id, "请在下方选择“浏览问卷”开始填写。");
      }
      return;
    }
    const creator = await canCreateFromCache();
    await renderUiScreen(ctx, message.chat.id, userId, {
      screen: "home",
      text: buildWelcomeText(
        creator,
        message.from?.first_name,
        { returning: true, reset: true },
        ctx.communityGroupUrl,
      ),
      replyMarkup: await buildHomeKeyboard(
        creator,
        Boolean(dbUser && isAdmin(userId, ctx.adminIds)),
        ctx.origin,
        ctx.webhookSecret,
        userId,
        message.from,
        ctx.submissionBotUrl,
      ),
    });
    return;
  }

  const adminLoginMatch = text?.match(/^\/admin_login(?:@[A-Za-z0-9_]{3,64})?$/);
  if (adminLoginMatch) {
    if (!isAdmin(userId, ctx.adminIds)) {
      await sendMessage(ctx.botToken, message.chat.id, "仅管理员可使用该命令。");
      return;
    }
    if (!ctx.origin || !ctx.webhookSecret) {
      await sendMessage(ctx.botToken, message.chat.id, "无法获取站点地址，请稍后重试。");
      return;
    }
    const token = await createBrowserLoginToken(ctx.webhookSecret, userId);
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      `🔐 电脑浏览器登录链接（${Math.round(ADMIN_LOGIN_TTL_SECONDS / 60)} 分钟内有效）：\n` +
        `${ctx.origin}/api/admin/auth/browser?t=${token}\n\n` +
        `在电脑默认浏览器打开即可进入管理后台，会话有效期 7 天。`,
    );
    return;
  }

  if (/^\/cancel(?:@[A-Za-z0-9_]{3,64})?$/.test(text ?? "")) {
    await Promise.all([
      ctx.cache?.delete(publicSurveySearchInputKey(userId)),
      ctx.cache?.delete(publicSurveySearchKey(userId)),
      clearImageGeneratorInteractionState(ctx, userId),
      clearResultVisualInteractionState(ctx, userId),
      clearBuilderInteractionState(ctx, userId),
      clearAdminInteractionState(ctx, userId),
      clearPlazaInteractionState(ctx, userId, message.chat.id),
    ]);
    const activeResponse = dbUserId ? await getActiveResponseByUser(ctx.db, dbUserId) : null;
    if (activeResponse) {
      await cancelResponse(ctx.db, activeResponse.id).catch(() => undefined);
      await Promise.resolve(completeSession(ctx.session, userId, activeResponse.surveyId)).catch(() => undefined);
    }
    const creator = await canCreateFromCache();
    await renderUiScreen(ctx, message.chat.id, userId, {
      screen: "home",
      text: activeResponse ? "已取消当前问卷填写及未完成操作。请选择下一步。" : "已取消当前操作。请选择下一步。",
      replyMarkup: await buildHomeKeyboard(
        creator,
        Boolean(dbUser && isAdmin(userId, ctx.adminIds)),
        ctx.origin,
        ctx.webhookSecret,
        userId,
        message.from,
        ctx.submissionBotUrl,
      ),
    });
    return;
  }

  if (/^\/set_report_channel(?:@[A-Za-z0-9_]{3,64})?$/.test(text ?? "")) {
    if (!ctx.cache) {
      await sendMessage(ctx.botToken, message.chat.id, "当前部署未启用 KV，无法保存频道设置。");
      return;
    }
    const forwarded = message.forward_from_chat;
    if (forwarded && forwarded.type === "channel") {
      if (!(await botCanManageChannel(ctx.botToken, forwarded.id))) {
        await sendMessage(ctx.botToken, message.chat.id, "该频道不可用：请确认「问卷机器人」已被添加为该频道管理员。");
        return;
      }
      await ctx.cache.put(REPORT_CHANNEL_CACHE_KEY, String(forwarded.id));
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        `✅ 报告归档频道已设置：${forwarded.title ?? String(forwarded.id)}\n频道 ID：${forwarded.id}`,
      );
      return;
    }
    await ctx.cache.put(reportChannelPendingKey(userId), "1", {
      expirationTtl: 10 * 60,
    });
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      "请把频道里的任意一条消息转发给我，或发送频道 @username。\n（邀请链接 t.me/+... 无法解析；设置 10 分钟内有效）",
    );
    return;
  }

  if (/^\/detect_channel(?:@[A-Za-z0-9_]{3,64})?$/.test(text ?? "")) {
    if (!ctx.cache) {
      await sendMessage(ctx.botToken, message.chat.id, "当前部署未启用 KV，无法保存频道设置。");
      return;
    }
    await ctx.cache.put(REPORT_CHANNEL_DETECT_REQUEST_KEY, String(userId), {
      expirationTtl: 10 * 60,
    });
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      "请在目标频道里发送任意一条消息（例如 TEST）。\nBot 检测到后会自动把该频道设置为报告归档频道，并在这里通知你。\n（10 分钟内有效）",
    );
    return;
  }

  if (ctx.cache && message.forward_from_chat?.type === "channel") {
    const configured = await ctx.cache.get(REPORT_CHANNEL_CACHE_KEY);
    if (!configured) {
      const forwarded = message.forward_from_chat;
      if (!(await botCanManageChannel(ctx.botToken, forwarded.id))) {
        await sendMessage(ctx.botToken, message.chat.id, "该频道不可用：请确认「问卷机器人」已被添加为该频道管理员。");
        return;
      }
      await ctx.cache.put(REPORT_CHANNEL_CACHE_KEY, String(forwarded.id));
      await ctx.cache.delete(reportChannelPendingKey(userId));
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        `✅ 已自动识别报告归档频道：${forwarded.title ?? String(forwarded.id)}\n频道 ID：${forwarded.id}\n如需更换请发送 /set_report_channel。`,
      );
      return;
    }
  }

  if (ctx.cache) {
    const configured = await ctx.cache.get(REPORT_CHANNEL_CACHE_KEY);
    const candidate = text?.trim() ?? "";
    if (!configured && /^https?:\/\/t\.me\/(\+|\/c\/)/.test(candidate)) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "这是邀请链接，Bot 无法直接解析。\n请打开频道，随便发一条消息，然后用 Telegram 的「转发」按钮把它转发给我（转发后消息会带“转发自频道”标记）。\n也可以先发 /set_report_channel 再操作。",
      );
      return;
    }
  }

  if (ctx.cache) {
    const pendingChannel = await ctx.cache.get(reportChannelPendingKey(userId));
    if (pendingChannel === "1") {
      const forwarded = message.forward_from_chat;
      if (forwarded && forwarded.type === "channel") {
        if (!(await botCanManageChannel(ctx.botToken, forwarded.id))) {
          await sendMessage(
            ctx.botToken,
            message.chat.id,
            "该频道不可用：请确认「问卷机器人」已被添加为该频道管理员。",
          );
          return;
        }
        await ctx.cache.put(REPORT_CHANNEL_CACHE_KEY, String(forwarded.id));
        await ctx.cache.delete(reportChannelPendingKey(userId));
        await sendMessage(
          ctx.botToken,
          message.chat.id,
          `✅ 报告归档频道已设置：${forwarded.title ?? String(forwarded.id)}\n频道 ID：${forwarded.id}`,
        );
        return;
      }
      const candidate = text?.trim();
      if (candidate && /^@[A-Za-z0-9_]{3,}$/.test(candidate)) {
        try {
          const chat = await getChat(ctx.botToken, candidate);
          if (chat.type === "channel" && (await botCanManageChannel(ctx.botToken, chat.id))) {
            await ctx.cache.put(REPORT_CHANNEL_CACHE_KEY, String(chat.id));
            await ctx.cache.delete(reportChannelPendingKey(userId));
            await sendMessage(
              ctx.botToken,
              message.chat.id,
              `✅ 报告归档频道已设置：${chat.title ?? candidate}\n频道 ID：${chat.id}`,
            );
            return;
          }
          await sendMessage(ctx.botToken, message.chat.id, `${candidate} 不是频道，请重试。`);
          return;
        } catch {
          await sendMessage(ctx.botToken, message.chat.id, `无法解析 ${candidate}，请确认 Bot 已添加为频道管理员。`);
          return;
        }
      }
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "请把频道里的任意一条消息转发给我，或发送频道 @username（邀请链接 t.me/+... 无法解析）。",
      );
      return;
    }
  }

  if (text && ctx.cache) {
    const waitingForSearch = await ctx.cache.get(publicSurveySearchInputKey(userId));
    if (waitingForSearch === "1") {
      if (text === "/cancel") {
        await ctx.cache.delete(publicSurveySearchInputKey(userId));
        await renderUiScreen(ctx, message.chat.id, userId, {
          screen: "survey_list",
          text: "已取消搜索。使用下方按钮浏览问卷。",
          replyMarkup: await buildHomeKeyboard(
            Boolean(dbUser && (await canCreateSurvey(ctx.db, dbUser, ctx.adminIds))),
            Boolean(dbUser && isAdmin(userId, ctx.adminIds)),
            ctx.origin,
            ctx.webhookSecret,
            userId,
            message.from,
            ctx.submissionBotUrl,
          ),
        });
        return;
      }
      if (!text.startsWith("/")) {
        await ctx.cache.put(publicSurveySearchKey(userId), text.slice(0, 80), {
          expirationTtl: 24 * 60 * 60,
        });
        await ctx.cache.delete(publicSurveySearchInputKey(userId));
        await listSurveys(ctx, message.chat.id, userId, 0, "latest", undefined, message.from);
        return;
      }
    }
  }

  if (text === "/surveys") {
    await listSurveys(ctx, message.chat.id, userId, 0, "latest", undefined, message.from);
    return;
  }

  if (text === "/help") {
    const creator = Boolean(dbUser && (await canCreateSurvey(ctx.db, dbUser, ctx.adminIds)));
    await renderUiScreen(ctx, message.chat.id, userId, {
      screen: "home",
      text: creator
        ? "快捷入口在下方。问卷创建和完整管理请进入网页后台。\n\n🔑 需要问卷密码、软件授权或部署支持，请联系 @ehdhhsbot。"
        : "从下方选择“浏览问卷”即可开始填写。\n\n🔑 需要问卷密码、软件授权或部署支持，请联系 @ehdhhsbot。",
      replyMarkup: await buildHomeKeyboard(
        creator,
        Boolean(dbUser && isAdmin(userId, ctx.adminIds)),
        ctx.origin,
        ctx.webhookSecret,
        userId,
        message.from,
        ctx.submissionBotUrl,
      ),
    });
    return;
  }

  if (dbUser && (await handlePlazaMessage(ctx, message, dbUser.id))) {
    return;
  }

  if (dbUser && (await handleImageGeneratorParticipantMessage(ctx, message, dbUser.id))) {
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
    try {
      await duplicateManagedSurvey(ctx, message.chat.id, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, message.chat.id, error instanceof Error ? error.message : "复制失败。");
    }
    return;
  }

  if (text === "/passwords" || text === "/set_survey_code" || text === "/get_survey_code") {
    await showSurveyPasswordMenu(ctx, message.chat.id, userId);
    return;
  }

  if (text?.startsWith("/set_survey_code ") || text?.startsWith("/get_survey_code ")) {
    await sendMessage(ctx.botToken, message.chat.id, "密码功能已整合。请发送 /passwords 后直接点选问卷操作。");
    return;
  }

  if (text?.startsWith("/export ")) {
    const [, surveyIdRaw, formatRaw] = text.split(/\s+/);
    const surveyId = Number(surveyIdRaw);
    const exportFormat = formatRaw?.toLowerCase() ?? "csv";
    if (!Number.isInteger(surveyId) || surveyId <= 0 || !["csv", "zip"].includes(exportFormat)) {
      await sendMessage(ctx.botToken, message.chat.id, "用法：/export <内部编号> [csv|zip]");
      return;
    }

    try {
      await sendSurveyExport(ctx, message.chat.id, userId, surveyId, exportFormat as SurveyExportFormat);
    } catch (error) {
      await sendMessage(ctx.botToken, message.chat.id, error instanceof Error ? error.message : "导出失败。");
    }
    return;
  }

  if (text?.startsWith("/export_json ")) {
    const surveyId = Number(text.slice("/export_json ".length));
    try {
      await sendSurveyJsonExport(ctx, message.chat.id, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, message.chat.id, error instanceof Error ? error.message : "导出失败。");
    }
    return;
  }

  if (text?.startsWith("/preview ")) {
    const surveyId = Number(text.slice("/preview ".length));
    try {
      await sendSurveyPreview(ctx, message.chat.id, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, message.chat.id, error instanceof Error ? error.message : "预览失败。");
    }
    return;
  }

  if (text === "/create" || text === "/continue" || text === "/import") {
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user || !(await canCreateSurvey(ctx.db, user, ctx.adminIds))) {
      await sendMessage(ctx.botToken, message.chat.id, "你没有创建或导入问卷的权限。");
      return;
    }
  }

  const builderState = await getBuilderState(ctx.builder, userId);
  const isBuilderCommand = Boolean(
    text === "/create" ||
    text === "/continue" ||
    text === "/import" ||
    text === "/save" ||
    text === "/discard" ||
    text === "/cancel" ||
    text === "/back" ||
    text?.startsWith("/option_media ") ||
    text?.startsWith("/question_media ") ||
    text?.startsWith("/edit_question_title "),
  );

  if (isBuilderCommand || builderOwnsNextMessage(builderState) || builderState?.step === "set_survey_access_code") {
    if (await handleBuilderMessage(ctx, message)) {
      return;
    }
  }

  const creator = await canCreateFromCache();
  await renderUiScreen(ctx, message.chat.id, userId, {
    screen: "home",
    text: creator
      ? "请在下方选择入口；问卷填写请在网页完成。\n\n🔑 需要问卷密码、软件授权或部署支持，请联系 @ehdhhsbot。"
      : "请在下方选择“浏览问卷”开始填写。\n\n🔑 需要问卷密码、软件授权或部署支持，请联系 @ehdhhsbot。",
    replyMarkup: await buildHomeKeyboard(
      creator,
      Boolean(dbUser && isAdmin(userId, ctx.adminIds)),
      ctx.origin,
      ctx.webhookSecret,
      userId,
      message.from,
      ctx.submissionBotUrl,
    ),
  });
}

export async function handleTelegramCallback(ctx: BotContext, callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  const chatId = callback.message?.chat.id;
  const userId = callback.from.id;
  const dbUser = await getUserByTelegramId(ctx.db, userId);
  const dbUserId = dbUser?.id;

  if (!dbUserId) {
    await answerCallbackQuery(ctx.botToken, callback.id, "用户不存在");
    return;
  }

  if (!data || !chatId) {
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (await handlePlazaCallback(ctx, callback, dbUserId)) {
    return;
  }

  if (await handleImageGeneratorCallback(ctx, callback, dbUserId, false)) {
    return;
  }

  if (data === "home:menu") {
    await showHomeMenu(ctx, chatId, userId, dbUser, callback.message?.message_id, callback.from);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "profile:start") {
    await answerCallbackQuery(ctx.botToken, callback.id);
    await promptProfileQuestionnaire(
      ctx,
      chatId,
      userId,
      ctx.adminIds.includes(callback.from.id),
      callback.message?.message_id,
    );
    return;
  }

  if (data === "home:surveys") {
    await listSurveys(ctx, chatId, userId, 0, "latest", undefined, callback.from);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("public:list:")) {
    const [, , pageRaw, sortRaw] = data.split(":");
    const page = Number(pageRaw);
    const sort = sortRaw === "popular" ? "popular" : "latest";
    if (!Number.isInteger(page) || page < 0) {
      await answerCallbackQuery(ctx.botToken, callback.id, "页码无效");
      return;
    }
    await listSurveys(ctx, chatId, userId, page, sort, callback.message?.message_id, callback.from);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "public:search") {
    if (!ctx.cache) {
      await answerCallbackQuery(ctx.botToken, callback.id, "当前部署未启用搜索功能");
      return;
    }
    await ctx.cache.put(publicSurveySearchInputKey(userId), "1", { expirationTtl: 10 * 60 });
    await renderUiScreen(ctx, chatId, userId, {
      screen: "survey_search",
      text: "请发送问卷标题关键词；发送 /cancel 取消搜索。",
    });
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("public:sort:")) {
    const sort = data.endsWith(":popular") ? "popular" : "latest";
    await listSurveys(ctx, chatId, userId, 0, sort, callback.message?.message_id, callback.from);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("public:clear:")) {
    const sort = data.endsWith(":popular") ? "popular" : "latest";
    await ctx.cache?.delete(publicSurveySearchKey(userId));
    await listSurveys(ctx, chatId, userId, 0, sort, callback.message?.message_id, callback.from);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "home:my_surveys") {
    await listMySurveys(ctx, chatId, userId, undefined, 0, callback.message?.message_id);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "home:create_menu") {
    await showCreateMenu(ctx, chatId, userId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "home:new_survey") {
    await showNewSurveyMenu(ctx, chatId, userId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "home:import_or_copy") {
    await showImportOrCopyMenu(ctx, chatId, userId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "home:continue") {
    await handleBuilderMessage(ctx, {
      message_id: callback.message?.message_id ?? 0,
      chat: { id: chatId },
      from: callback.from,
      text: "/continue",
    });
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "home:import_json") {
    await handleBuilderMessage(ctx, {
      message_id: callback.message?.message_id ?? 0,
      chat: { id: chatId },
      from: callback.from,
      text: "/import",
    });
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "home:copy_list") {
    const user = await getUserByTelegramId(ctx.db, userId);
    const surveys = user ? await listOwnedSurveys(ctx.db, user.id) : [];
    const screen = {
      screen: "copy_survey",
      text: surveys.length === 0 ? "你还没有可复制的问卷。" : "选择要复制的问卷：",
      ...(surveys.length > 0
        ? {
            replyMarkup: {
              inline_keyboard: surveys.map((survey) => [
                { text: compactSurveyTitle(survey.title), callback_data: `owner:duplicate:${survey.id}` },
              ]),
            },
          }
        : {}),
    };
    await renderUiScreen(ctx, chatId, userId, screen);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "home:templates") {
    await renderUiScreen(ctx, chatId, userId, {
      screen: "templates",
      text: "问卷模板\n\n选择模板后会生成一份可随意修改的草稿：",
      replyMarkup: {
        inline_keyboard: listSurveyTemplates().map((template) => [
          { text: `${template.title} · ${template.description}`, callback_data: `home:template:${template.id}` },
        ]),
      },
    });
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("home:template:")) {
    const templateId = data.slice("home:template:".length) as SurveyTemplate["id"];
    try {
      if (!dbUser || !(await canCreateSurvey(ctx.db, dbUser, ctx.adminIds))) throw new Error("你没有创建问卷的权限");
      const survey = await createSurveyFromTemplate(ctx.db, dbUser.id, templateId);
      await renderUiScreen(ctx, chatId, userId, {
        screen: "template_created",
        text: `已创建“${survey.title}”模板草稿，共可继续编辑后再发布。`,
        replyMarkup: {
          inline_keyboard: [
            [
              { text: "编辑题目", callback_data: `owner:questions:${survey.id}` },
              { text: "查看发布检查", callback_data: `owner:publish_ask:${survey.id}` },
            ],
          ],
        },
      });
      await answerCallbackQuery(ctx.botToken, callback.id, "模板草稿已创建");
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "模板创建失败");
    }
    return;
  }

  if (data === "home:create") {
    if (!dbUser || !(await canCreateSurvey(ctx.db, dbUser, ctx.adminIds))) {
      await answerCallbackQuery(ctx.botToken, callback.id, "你没有创建问卷的权限");
      return;
    }
    await startBuilder(ctx, chatId, userId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("owner:list:")) {
    const [filterRaw, pageRaw] = data.slice("owner:list:".length).split(":");
    const filter =
      filterRaw === "all"
        ? undefined
        : ["draft", "published", "closed"].includes(filterRaw ?? "")
          ? (filterRaw as Survey["status"])
          : undefined;
    const page = Number(pageRaw ?? 0);
    if (!Number.isInteger(page) || page < 0) {
      await answerCallbackQuery(ctx.botToken, callback.id, "页码无效");
      return;
    }
    await listMySurveys(ctx, chatId, userId, filter, page, callback.message?.message_id);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (await handleBuilderCallback(ctx, callback)) {
    return;
  }

  if (data.startsWith("option_media:")) {
    const optionId = Number(data.slice("option_media:".length));
    const optionRow = await ctx.db
      .prepare(
        `SELECT q.survey_id
         FROM question_options o
         JOIN survey_questions q ON q.id = o.question_id
         WHERE o.id = ? LIMIT 1`,
      )
      .bind(optionId)
      .first<{ survey_id: number }>();
    if (!optionRow || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "选项不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, optionRow.survey_id);
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无权编辑该选项");
      return;
    }
    await initBuilder(ctx.builder, userId);
    await startOptionMedia(ctx.builder, userId, optionId);
    await sendMessage(ctx.botToken, chatId, `请发送要绑定到选项 #${optionId} 的媒体文件。`);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("option_label:")) {
    const optionId = Number(data.slice("option_label:".length));
    const optionRow = await ctx.db
      .prepare(
        `SELECT q.survey_id
         FROM question_options o
         JOIN survey_questions q ON q.id = o.question_id
         WHERE o.id = ? LIMIT 1`,
      )
      .bind(optionId)
      .first<{ survey_id: number }>();
    if (!optionRow || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "选项不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, optionRow.survey_id);
      await initBuilder(ctx.builder, userId);
      await startEditOptionLabel(ctx.builder, userId, optionId);
      await sendMessage(ctx.botToken, chatId, "请输入新的选项名称：");
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无权编辑该选项");
      return;
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("question_media:")) {
    const questionId = Number(data.slice("question_media:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (!question || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "题目不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无权编辑该题目");
      return;
    }
    await initBuilder(ctx.builder, userId);
    await startQuestionMedia(ctx.builder, userId, questionId);
    await sendMessage(ctx.botToken, chatId, `请发送要绑定到题目 #${questionId} 的媒体文件。`);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (await handleAdminCallback(ctx, callback)) {
    return;
  }

  if (data.startsWith("rv:templates:")) {
    const responseId = Number(data.slice("rv:templates:".length));
    if (!Number.isSafeInteger(responseId) || responseId <= 0) {
      await answerCallbackQuery(ctx.botToken, callback.id, "结果编号无效");
      return;
    }
    try {
      await showResponseReportTemplates(ctx, chatId, userId, callback.message?.message_id, responseId);
      await answerCallbackQuery(ctx.botToken, callback.id);
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无法打开报告模板");
    }
    return;
  }

  if (data.startsWith("rv:skip:")) {
    const responseId = Number(data.slice("rv:skip:".length));
    const response = Number.isSafeInteger(responseId) ? await getResponseById(ctx.db, responseId) : null;
    if (!response || response.userId !== dbUserId || response.status !== "completed") {
      await answerCallbackQuery(ctx.botToken, callback.id, "找不到已完成的问卷");
      return;
    }
    if (callback.message?.message_id !== undefined) {
      await renderScreen({
        botToken: ctx.botToken,
        chatId,
        userId,
        messageId: callback.message.message_id,
        screen: "RESULT_VISUAL_SKIPPED",
        text: "✅ 问卷已完成。结果报告尚未生成。",
        replyMarkup: {
          inline_keyboard: [
            [{ text: "返回主页", callback_data: "home:menu" }],
            ...(ctx.submissionBotUrl ? [[{ text: "📮 投稿机器人", url: ctx.submissionBotUrl }]] : []),
          ],
        },
      });
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("rv:generate:") || data.startsWith("rv:regenerate:")) {
    const forceRegenerate = data.startsWith("rv:regenerate:");
    const prefix = forceRegenerate ? "rv:regenerate:" : "rv:generate:";
    const parts = data.slice(prefix.length).split(":");
    const responseId = Number(parts[0]);
    const selectedTemplateId = parts[1] === undefined ? undefined : Number(parts[1]);
    if (!Number.isSafeInteger(responseId) || responseId <= 0) {
      await answerCallbackQuery(ctx.botToken, callback.id, "结果编号无效");
      return;
    }

    const response = await getResponseById(ctx.db, responseId);
    if (!response || response.userId !== dbUserId || response.status !== "completed") {
      await answerCallbackQuery(ctx.botToken, callback.id, "找不到可生成的问卷结果");
      return;
    }

    if (selectedTemplateId !== undefined && (!Number.isSafeInteger(selectedTemplateId) || selectedTemplateId <= 0)) {
      await answerCallbackQuery(ctx.botToken, callback.id, "报告模板编号无效");
      return;
    }

    try {
      const result = await requestConfiguredResultVisual(ctx.db, ctx.exportQueue, {
        responseId: response.id,
        chatId,
        requestedBy: dbUserId,
        ...(selectedTemplateId === undefined ? {} : { templateId: selectedTemplateId }),
        forceRegenerate,
      });
      if (!result) throw new Error("该问卷未配置可用的结果卡模板");

      if (callback.message?.message_id !== undefined) {
        await renderScreen({
          botToken: ctx.botToken,
          chatId,
          userId,
          messageId: callback.message.message_id,
          screen: "RESULT_VISUAL_QUEUED",
          text:
            result.status === "processing"
              ? "🎨 结果卡正在生成，请稍候。"
              : "🎨 正在生成你的结果卡。生成完成后会直接发送 PNG 图片。",
          replyMarkup: { inline_keyboard: [] },
        });
      }
      await answerCallbackQuery(ctx.botToken, callback.id, "已开始生成");
    } catch (error) {
      console.error("Result visual request failed", {
        responseId,
        surveyId: response.surveyId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (callback.message?.message_id !== undefined) {
        try {
          await renderScreen({
            botToken: ctx.botToken,
            chatId,
            userId,
            messageId: callback.message.message_id,
            screen: "RESULT_VISUAL_ERROR",
            text: "无法生成结果图片，请稍后重试。",
            replyMarkup: {
              inline_keyboard: [
                [
                  {
                    text: "🎨 重试生成",
                    callback_data: `rv:generate:${response.id}${selectedTemplateId === undefined ? "" : `:${selectedTemplateId}`}`,
                  },
                ],
              ],
            },
          });
        } catch (renderError) {
          console.error("Result visual error screen failed", {
            responseId,
            error: renderError instanceof Error ? renderError.message : String(renderError),
          });
        }
      }
      await answerCallbackQuery(ctx.botToken, callback.id, "无法生成结果卡");
    }
    return;
  }

  if (await handleReportCallbacks(ctx, callback, chatId, userId, dbUserId, data)) {
    return;
  }

  if (data.startsWith("owner:poster_menu:")) {
    const surveyId = Number(data.slice("owner:poster_menu:".length));
    await answerCallbackQuery(ctx.botToken, callback.id);
    try {
      await showCompletionPosterMenu(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "无法打开海报设置。");
    }
    return;
  }

  if (data.startsWith("owner:poster_toggle:")) {
    const surveyId = Number(data.slice("owner:poster_toggle:".length));
    try {
      const user = await getUserByTelegramId(ctx.db, userId);
      if (!user) throw new Error("用户信息不存在");
      await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
      const setting = await getCompletionPosterSetting(ctx.db, surveyId);
      await saveCompletionPosterSetting(ctx.db, { ...setting, enabled: !setting.enabled });
      await answerCallbackQuery(ctx.botToken, callback.id, setting.enabled ? "海报已关闭" : "海报已开启");
      await showCompletionPosterMenu(ctx, chatId, userId, surveyId);
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "设置失败");
    }
    return;
  }

  if (data.startsWith("owner:poster_style:")) {
    const [, , surveyIdRaw, styleRaw] = data.split(":");
    const styles: CompletionPosterStyle[] = ["clean", "cute", "editorial", "bold"];
    const style = styles.includes(styleRaw as CompletionPosterStyle) ? (styleRaw as CompletionPosterStyle) : null;
    const surveyId = Number(surveyIdRaw);
    if (!style || !Number.isInteger(surveyId)) {
      await answerCallbackQuery(ctx.botToken, callback.id, "海报风格无效");
      return;
    }
    try {
      const user = await getUserByTelegramId(ctx.db, userId);
      if (!user) throw new Error("用户信息不存在");
      await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
      await saveCompletionPosterSetting(ctx.db, { surveyId, enabled: true, style });
      await answerCallbackQuery(ctx.botToken, callback.id, "海报风格已保存并开启");
      await showCompletionPosterMenu(ctx, chatId, userId, surveyId);
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "设置失败");
    }
    return;
  }

  if (data.startsWith("owner:poster_preview:")) {
    const [, , surveyIdRaw, styleRaw] = data.split(":");
    const surveyId = Number(surveyIdRaw);
    const styles: CompletionPosterStyle[] = ["clean", "cute", "editorial", "bold"];
    const style = styles.includes(styleRaw as CompletionPosterStyle) ? (styleRaw as CompletionPosterStyle) : null;
    try {
      const user = await getUserByTelegramId(ctx.db, userId);
      if (!user || !style) throw new Error("海报风格无效");
      await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
      if (!ctx.browser) throw new Error("当前部署未启用海报服务");
      const survey = await getSurveyById(ctx.db, surveyId);
      if (!survey) throw new Error("问卷不存在");
      await answerCallbackQuery(ctx.botToken, callback.id, "正在生成预览");
      const png = await renderCompletionPoster(ctx.browser, {
        surveyTitle: survey.title,
        completedAt: "预览效果",
        style,
      });
      await sendPhoto(ctx.botToken, chatId, png, "完成海报预览");
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "预览失败");
    }
    return;
  }

  if (data.startsWith("owner:survey:")) {
    const surveyId = Number(data.slice("owner:survey:".length));
    await showSurveyStats(ctx, chatId, userId, surveyId, callback.message?.message_id);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("owner:content:")) {
    const surveyId = Number(data.slice("owner:content:".length));
    try {
      await showSurveyContentMenu(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "读取问卷设置失败。");
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("owner:repeat_toggle:")) {
    const surveyId = Number(data.slice("owner:repeat_toggle:".length));
    try {
      const owner = await getUserByTelegramId(ctx.db, userId);
      if (!owner) throw new Error("用户信息不存在");
      await assertCanManageSurvey(ctx.db, owner, surveyId, ctx.adminIds);
      const survey = await getSurveyById(ctx.db, surveyId);
      if (!survey) throw new Error("问卷不存在");
      const updated = await updateSurveyResponsePolicy(ctx.db, surveyId, !survey.allowMultipleResponses, 0);
      await showSurveyContentMenu(ctx, chatId, userId, surveyId);
      await answerCallbackQuery(
        ctx.botToken,
        callback.id,
        updated?.allowMultipleResponses ? "已允许重复填写" : "已禁止重复填写",
      );
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "设置失败");
    }
    return;
  }

  if (data.startsWith("owner:reports:")) {
    const surveyId = Number(data.slice("owner:reports:".length));
    try {
      await showSurveyReportsMenu(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "读取答卷与报告失败。");
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("owner:share:")) {
    const surveyId = Number(data.slice("owner:share:".length));
    await answerCallbackQuery(ctx.botToken, callback.id, "正在生成分享链接");
    try {
      await showSurveyShareLink(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "生成分享链接失败。");
    }
    return;
  }

  if (data.startsWith("owner:duplicate:")) {
    const surveyId = Number(data.slice("owner:duplicate:".length));
    await answerCallbackQuery(ctx.botToken, callback.id, "正在复制");
    try {
      await duplicateManagedSurvey(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "复制失败。");
    }
    return;
  }

  if (data.startsWith("owner:preview:")) {
    const surveyId = Number(data.slice("owner:preview:".length));
    await answerCallbackQuery(ctx.botToken, callback.id, "正在生成预览");
    try {
      await sendSurveyPreview(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "预览失败。");
    }
    return;
  }

  if (data === "owner:access_codes") {
    await answerCallbackQuery(ctx.botToken, callback.id);
    try {
      await showSurveyPasswordMenu(ctx, chatId, userId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "读取密码列表失败。");
    }
    return;
  }

  if (data.startsWith("owner:access_view:")) {
    const surveyId = Number(data.slice("owner:access_view:".length));
    await answerCallbackQuery(ctx.botToken, callback.id);
    try {
      await showSurveyPasswordDetails(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "读取密码状态失败。");
    }
    return;
  }

  if (data.startsWith("owner:access_reveal:")) {
    const surveyId = Number(data.slice("owner:access_reveal:".length));
    if (!dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "用户不存在");
      return;
    }
    try {
      await assertCanManageSurvey(ctx.db, dbUser, surveyId, ctx.adminIds);
      const survey = await getSurveyById(ctx.db, surveyId);
      if (!survey?.accessCode) throw new Error("该问卷未设置密码");
      const code = survey.accessCodeEncrypted
        ? await decryptSurveyAccessCode(survey.accessCodeEncrypted, ctx.botToken)
        : null;
      if (!code) throw new Error("这是旧版密码，无法恢复；请点击“更换密码”重新设置");
      await sendMessage(ctx.botToken, chatId, `🔐 当前访问密码\n\n${code}\n\n请勿转发此消息；如不再需要可删除。`);
      await answerCallbackQuery(ctx.botToken, callback.id, "密码已显示");
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无法查看密码");
    }
    return;
  }

  if (data.startsWith("owner:access_set:") || data.startsWith("owner:access_code:")) {
    const prefix = data.startsWith("owner:access_set:") ? "owner:access_set:" : "owner:access_code:";
    const surveyId = Number(data.slice(prefix.length));
    await answerCallbackQuery(ctx.botToken, callback.id);
    try {
      await beginSurveyPasswordInput(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "无权设置密码。");
    }
    return;
  }

  if (data.startsWith("owner:access_clear_ask:")) {
    const surveyId = Number(data.slice("owner:access_clear_ask:".length));
    if (!dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "用户不存在");
      return;
    }
    try {
      await assertCanManageSurvey(ctx.db, dbUser, surveyId, ctx.adminIds);
      const survey = await getSurveyById(ctx.db, surveyId);
      if (!survey) throw new Error("问卷不存在");
      await sendMessage(
        ctx.botToken,
        chatId,
        `确认移除问卷“${survey.title}”的访问密码？移除后任何人都可以直接开始填写。`,
        {
          inline_keyboard: [
            [
              {
                text: "确认移除",
                callback_data: `owner:access_clear:${survey.id}`,
              },
              {
                text: "取消",
                callback_data: `owner:access_view:${survey.id}`,
              },
            ],
          ],
        },
      );
      await answerCallbackQuery(ctx.botToken, callback.id);
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无权移除密码");
    }
    return;
  }

  if (data.startsWith("owner:access_clear:")) {
    const surveyId = Number(data.slice("owner:access_clear:".length));
    if (!dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "用户不存在");
      return;
    }
    try {
      await assertCanManageSurvey(ctx.db, dbUser, surveyId, ctx.adminIds);
      await setSurveyAccessCode(ctx.db, surveyId, null);
      await answerCallbackQuery(ctx.botToken, callback.id, "密码已移除");
      await showSurveyPasswordDetails(ctx, chatId, userId, surveyId);
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "移除密码失败");
    }
    return;
  }

  if (data === "owner:cancel") {
    await answerCallbackQuery(ctx.botToken, callback.id, "已取消");
    return;
  }

  if (data.startsWith("owner:publish_ask:")) {
    const surveyId = Number(data.slice("owner:publish_ask:".length));
    try {
      await showPublishCheck(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "无法检查发布条件。");
    }
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
      await publishSurvey(ctx.db, surveyId, user.id);
      await showSurveyStats(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "发布失败。");
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
      await showSurveyStats(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "关闭失败。");
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "/surveys" || data === "surveys:list") {
    await listSurveys(ctx, chatId, userId, 0, "latest", undefined, callback.from);
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
    const [surveyIdRaw, offsetRaw] = data.slice("qedit:list:".length).split(":");
    const surveyId = Number(surveyIdRaw);
    const offset = Number(offsetRaw ?? 0);
    await showQuestionList(ctx, chatId, userId, surveyId, offset);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:view:")) {
    const questionId = Number(data.slice("qedit:view:".length));
    await showQuestionEditor(ctx, chatId, userId, questionId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:add:")) {
    const surveyId = Number(data.slice("qedit:add:".length));
    if (!dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "用户信息不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, surveyId);
      const builderState = await getBuilderState(ctx.builder, userId);
      if (builderState?.activeDraft && builderState.step !== "idle") {
        throw new Error("你有未完成的创建草稿，请先完成或取消后再新增题目");
      }
      await initBuilder(ctx.builder, userId);
      await startAppendQuestions(ctx.builder, userId, surveyId);
      await sendMessage(ctx.botToken, chatId, "请选择要新增题目的类型：", {
        inline_keyboard: [
          [
            { text: "单选", callback_data: "builder:type:single" },
            { text: "多选", callback_data: "builder:type:multiple" },
          ],
          [
            { text: "单行文本", callback_data: "builder:type:text" },
            { text: "多行文本", callback_data: "builder:type:long_text" },
          ],
          [
            { text: "数字", callback_data: "builder:type:number" },
            { text: "评分", callback_data: "builder:type:rating" },
          ],
          [
            { text: "矩阵题", callback_data: "builder:type:matrix" },
            { text: "是 / 否", callback_data: "builder:type:yes_no" },
          ],
          [
            { text: "日期", callback_data: "builder:type:date" },
            { text: "时间", callback_data: "builder:type:time" },
          ],
          [
            { text: "上传图片", callback_data: "builder:type:image" },
            { text: "上传视频", callback_data: "builder:type:video" },
          ],
          [
            { text: "上传音频", callback_data: "builder:type:audio" },
            { text: "上传文件", callback_data: "builder:type:file" },
          ],
          [{ text: "取消", callback_data: "builder:cancel" }],
        ],
      });
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无法新增题目");
      return;
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:option_add:")) {
    const questionId = Number(data.slice("qedit:option_add:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (!question || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "题目不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
      await initBuilder(ctx.builder, userId);
      await startAddQuestionOption(ctx.builder, userId, question.id);
      await sendMessage(
        ctx.botToken,
        chatId,
        "请输入新选项，每行一个。\n也可以发送带说明文字的图片、音频、视频或文件，直接创建带附件的选项。",
      );
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无法新增选项");
      return;
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:option_delete_ask:")) {
    const optionId = Number(data.slice("qedit:option_delete_ask:".length));
    const option = await getQuestionOptionById(ctx.db, optionId);
    const question = option ? await getQuestionEntityById(ctx.db, option.questionId) : null;
    if (!option || !question || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "选项不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
      await sendMessage(ctx.botToken, chatId, `确认删除选项“${option.label}”？`, {
        inline_keyboard: [
          [
            {
              text: "确认删除",
              callback_data: `qedit:option_delete_confirm:${option.id}`,
            },
            {
              text: "取消",
              callback_data: `qedit:view:${question.id}`,
            },
          ],
        ],
      });
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无法删除选项");
      return;
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:option_delete_confirm:")) {
    const optionId = Number(data.slice("qedit:option_delete_confirm:".length));
    const option = await getQuestionOptionById(ctx.db, optionId);
    const question = option ? await getQuestionEntityById(ctx.db, option.questionId) : null;
    if (!option || !question || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "选项不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
      const options = await listOptionsForQuestions(ctx.db, [question.id]);
      if (question.type !== "single" && question.type !== "multiple") {
        throw new Error("该题型使用固定选项，不能删除");
      }
      if (options.length <= 2) {
        throw new Error("选择题至少需要两个选项，不能继续删除");
      }
      await deleteQuestionOption(ctx.db, option.id);
      await showQuestionEditor(ctx, chatId, userId, question.id);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "删除选项失败。");
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:option_up:") || data.startsWith("qedit:option_down:")) {
    const movingUp = data.startsWith("qedit:option_up:");
    const prefix = movingUp ? "qedit:option_up:" : "qedit:option_down:";
    const optionId = Number(data.slice(prefix.length));
    const option = await getQuestionOptionById(ctx.db, optionId);
    const question = option ? await getQuestionEntityById(ctx.db, option.questionId) : null;
    if (!option || !question || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "选项不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
      if (question.type !== "single" && question.type !== "multiple") {
        throw new Error("该题型使用固定选项，不能调整顺序");
      }
      const options = await listOptionsForQuestions(ctx.db, [question.id]);
      const index = options.findIndex((item) => item.id === option.id);
      const adjacent = options[index + (movingUp ? -1 : 1)];
      if (adjacent) {
        await swapQuestionOptionOrder(ctx.db, option.id, adjacent.id);
      }
      await showQuestionEditor(ctx, chatId, userId, question.id);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "调整选项顺序失败。");
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:qmedia_delete:") || data.startsWith("qedit:omedia_delete:")) {
    const isQuestionMedia = data.startsWith("qedit:qmedia_delete:");
    const [, , relationIdRaw, questionIdRaw] = data.split(":");
    const relationId = Number(relationIdRaw);
    const questionId = Number(questionIdRaw);
    const relation = isQuestionMedia
      ? await ctx.db
          .prepare(
            `SELECT qm.question_id, q.survey_id
             FROM question_media qm
             JOIN survey_questions q ON q.id = qm.question_id
             WHERE qm.id = ? LIMIT 1`,
          )
          .bind(relationId)
          .first<{ question_id: number; survey_id: number }>()
      : await ctx.db
          .prepare(
            `SELECT o.question_id, q.survey_id
             FROM option_media om
             JOIN question_options o ON o.id = om.question_option_id
             JOIN survey_questions q ON q.id = o.question_id
             WHERE om.id = ? LIMIT 1`,
          )
          .bind(relationId)
          .first<{ question_id: number; survey_id: number }>();
    if (!relation || relation.question_id !== questionId || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "附件不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, relation.survey_id);
      const confirmAction = isQuestionMedia ? "qedit:qmedia_confirm" : "qedit:omedia_confirm";
      await sendMessage(ctx.botToken, chatId, "确认移除这个附件？原文件不会从 Telegram 删除。", {
        inline_keyboard: [
          [
            {
              text: "确认移除",
              callback_data: `${confirmAction}:${relationId}:${questionId}`,
            },
            {
              text: "取消",
              callback_data: `qedit:view:${questionId}`,
            },
          ],
        ],
      });
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无法移除附件");
      return;
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:qmedia_confirm:") || data.startsWith("qedit:omedia_confirm:")) {
    const isQuestionMedia = data.startsWith("qedit:qmedia_confirm:");
    const [, , relationIdRaw, questionIdRaw] = data.split(":");
    const relationId = Number(relationIdRaw);
    const questionId = Number(questionIdRaw);
    const relation = isQuestionMedia
      ? await ctx.db
          .prepare(
            `SELECT qm.question_id, q.survey_id
             FROM question_media qm
             JOIN survey_questions q ON q.id = qm.question_id
             WHERE qm.id = ? LIMIT 1`,
          )
          .bind(relationId)
          .first<{ question_id: number; survey_id: number }>()
      : await ctx.db
          .prepare(
            `SELECT o.question_id, q.survey_id
             FROM option_media om
             JOIN question_options o ON o.id = om.question_option_id
             JOIN survey_questions q ON q.id = o.question_id
             WHERE om.id = ? LIMIT 1`,
          )
          .bind(relationId)
          .first<{ question_id: number; survey_id: number }>();
    if (!relation || relation.question_id !== questionId || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "附件不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, relation.survey_id);
      if (isQuestionMedia) {
        await deleteQuestionMedia(ctx.db, relationId);
      } else {
        await deleteOptionMedia(ctx.db, relationId);
      }
      await showQuestionEditor(ctx, chatId, userId, questionId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "移除附件失败。");
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:title:")) {
    const questionId = Number(data.slice("qedit:title:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (!question || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "题目不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
      await initBuilder(ctx.builder, userId);
      await startEditQuestionTitle(ctx.builder, userId, questionId);
      await sendMessage(ctx.botToken, chatId, "请输入新的题目内容：");
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无权编辑该题目");
      return;
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:required:")) {
    const questionId = Number(data.slice("qedit:required:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (question && dbUser) {
      try {
        await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
      } catch (error) {
        await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无权编辑该题目");
        return;
      }
      await updateQuestionRequired(ctx.db, questionId, !question.required);
      await showQuestionEditor(ctx, chatId, userId, questionId);
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:skip_menu:")) {
    const questionId = Number(data.slice("qedit:skip_menu:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (!question || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "题目不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
      const [options, questions] = await Promise.all([
        listOptionsForQuestions(ctx.db, [questionId]),
        listQuestionsBySurvey(ctx.db, question.surveyId),
      ]);
      const targets = questions.filter((item) => item.order > question.order);
      if (options.length === 0 || targets.length === 0) {
        throw new Error("需要至少一个选项和一道后续题目才能设置跳题");
      }
      await sendMessage(ctx.botToken, chatId, `设置跳题：${question.title}\n\n先选择触发跳题的选项：`, {
        inline_keyboard: options
          .map((option) => [{ text: option.label, callback_data: `qedit:skip_option:${questionId}:${option.id}` }])
          .concat([[{ text: "取消", callback_data: `qedit:view:${questionId}` }]]),
      });
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无法设置跳题");
      return;
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:skip_option:")) {
    const [, , , questionIdRaw, optionIdRaw] = data.split(":");
    const questionId = Number(questionIdRaw);
    const optionId = Number(optionIdRaw);
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (!question || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "题目不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
      const targets = (await listQuestionsBySurvey(ctx.db, question.surveyId)).filter(
        (item) => item.order > question.order,
      );
      await sendMessage(ctx.botToken, chatId, "选择要跳转到的后续题目：", {
        inline_keyboard: targets
          .map((target) => [
            {
              text: `第 ${target.order + 1} 题 · ${compactSurveyTitle(target.title, 35)}`,
              callback_data: `qedit:skip_target:${questionId}:${optionId}:${target.id}`,
            },
          ])
          .concat([[{ text: "取消", callback_data: `qedit:view:${questionId}` }]]),
      });
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无法设置跳题");
      return;
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:skip_target:")) {
    const [, , , questionIdRaw, optionIdRaw, targetIdRaw] = data.split(":");
    const questionId = Number(questionIdRaw);
    const optionId = Number(optionIdRaw);
    const targetId = Number(targetIdRaw);
    const [question, option, target] = await Promise.all([
      getQuestionEntityById(ctx.db, questionId),
      getQuestionOptionById(ctx.db, optionId),
      getQuestionEntityById(ctx.db, targetId),
    ]);
    if (
      !question ||
      !option ||
      !target ||
      option.questionId !== question.id ||
      target.surveyId !== question.surveyId ||
      target.order <= question.order ||
      !dbUser
    ) {
      await answerCallbackQuery(ctx.botToken, callback.id, "跳题规则无效");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
      await setQuestionSkipRule(ctx.db, questionId, { optionId, targetQuestionId: targetId });
      await showQuestionEditor(ctx, chatId, userId, questionId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "保存跳题规则失败。");
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:skip_clear:")) {
    const questionId = Number(data.slice("qedit:skip_clear:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (!question || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "题目不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
      await setQuestionSkipRule(ctx.db, questionId, null);
      await showQuestionEditor(ctx, chatId, userId, questionId);
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "清除跳题规则失败");
    }
    return;
  }

  if (data.startsWith("qedit:copy:")) {
    const questionId = Number(data.slice("qedit:copy:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (question && dbUser) {
      try {
        await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
      } catch (error) {
        await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无权编辑该题目");
        return;
      }
      await duplicateQuestion(ctx.db, questionId);
      await showQuestionList(ctx, chatId, userId, question.surveyId);
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:delete_ask:")) {
    const questionId = Number(data.slice("qedit:delete_ask:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (question && dbUser) {
      try {
        await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
      } catch (error) {
        await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无权编辑该题目");
        return;
      }
      await sendMessage(ctx.botToken, chatId, `确认删除题目“${question.title}”？此操作不可撤销。`, {
        inline_keyboard: [
          [
            {
              text: "确认删除",
              callback_data: `qedit:delete_confirm:${question.id}`,
            },
            {
              text: "取消",
              callback_data: `qedit:view:${question.id}`,
            },
          ],
        ],
      });
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:delete_confirm:")) {
    const questionId = Number(data.slice("qedit:delete_confirm:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (!question || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "题目不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
      await deleteQuestion(ctx.db, questionId);
      await showQuestionList(ctx, chatId, userId, question.surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "删除题目失败。");
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:up:")) {
    const questionId = Number(data.slice("qedit:up:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (question && dbUser) {
      try {
        await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
      } catch (error) {
        await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无权编辑该题目");
        return;
      }
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
    if (question && dbUser) {
      try {
        await assertCanEditSurveyQuestions(ctx, dbUser, question.surveyId);
      } catch (error) {
        await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无权编辑该题目");
        return;
      }
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
