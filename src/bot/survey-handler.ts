import {
  cancelResponse,
  completeResponse,
  createResponse,
  deleteAnswer,
  getActiveResponseBySurveyAndUser,
  getActiveResponseByUser,
  getResponseById,
  getResponseBySurveyAndHash,
  restartResponse,
  updateResponseCurrentQuestion,
  upsertDateAnswer,
  upsertMediaAnswer,
  upsertNumberAnswer,
  upsertOptionAnswer,
  upsertJsonAnswer,
  upsertTextAnswer,
  upsertTimeAnswer,
} from "../db/repositories/response.repository";
import {
  getSurveyById,
  listAllSurveys,
  setSurveyAccessCode,
  updateSurveyResponsePolicy,
  updateSurveyStatus,
} from "../db/repositories/survey.repository";
import {
  createAnswerMedia,
  deleteOptionMedia,
  deleteQuestionMedia,
  getAnswerMediaByAnswerId,
  getMediaAssetById,
  getOptionMediaByOptionId,
  getQuestionMediaByQuestionId,
} from "../db/repositories/media.repository";
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
import { registerMediaAsset } from "../services/media.service";
import { getUserByTelegramId, markBotStarted } from "../db/repositories/user.repository";
import { assertCanFillSurvey, assertCanManageSurvey, canCreateSurvey, isAdmin } from "../services/permission.service";
import {
  assertSurveyCanPublish,
  assertSurveyQuestionsEditable,
  duplicateSurvey,
  listMySurveys as listOwnedSurveys,
} from "../services/survey.service";
import {
  getNumericStatistics,
  getOptionStatistics,
  getResponseCount,
  getSurveyStatistics,
} from "../services/statistics.service";
import { getResponseDetail, listResponses } from "../services/result.service";
import { enqueueExportJob, type SurveyExportFormat } from "../services/export-queue.service";
import { requestConfiguredResultVisual } from "../services/result-visual.service";
import {
  renderResponseReport,
  type ResponseReport,
} from "../services/response-report.service";
import { renderSurveySummaryReport } from "../services/survey-report.service";
import { exportUnifiedSurveyJson } from "../services/survey-json.service";
import { getSurveyDetail } from "../services/survey.service";
import { getSurveyFlow } from "../services/question.service";
import {
  clearSessionOptions,
  completeSession,
  getSession,
  getSessionSelectedOptions,
  getSessionMatrixSelections,
  initSession,
  setSessionCurrentQuestion,
  setSessionMatrixSelection,
  clearSessionMatrixSelections,
  toggleSessionOption,
} from "../services/session.service";
import { getFirstQuestion, getNextQuestion, getNextQuestionAfterOption, getPreviousQuestion, getQuestionById, type SurveyQuestionView } from "../survey/engine";
import { answerCallbackQuery, downloadTelegramFile, editMessageReplyMarkup, getBotUsername, sendAnimation, sendAudio, sendDocument, sendDocumentByFileId, sendLongMessage, sendMessage, sendPhoto, sendPhotoAlbum, sendSticker, sendVideo, sendVoice, type InlineKeyboardMarkup } from "./telegram";
import { renderUiScreen } from "./ui";
import { renderScreen } from "./ui-message-controller";
import type { BotContext, TelegramCallbackQuery, TelegramMessage } from "./types";
import { clearBuilderInteractionState, handleBuilderCallback, handleBuilderMessage, startBuilder } from "./builder-handler";
import {
  getBuilderState,
  initBuilder,
  resumeBuilderAfterAuxiliary,
  startAddQuestionOption,
  startAppendQuestions,
  startEditOptionLabel,
  startEditQuestionTitle,
  startOptionMedia,
  startQuestionMedia,
  startSetSurveyAccessCode,
  startSurveyAccessCode,
  resetBuilder,
} from "../services/survey-builder.service";
import { clearAdminInteractionState, handleAdminCallback, handleAdminMessage } from "./admin-handler";
import {
  decryptSurveyAccessCode,
  verifySurveyAccessCode,
} from "../core/security";
import type { Answer, MediaAsset, Survey } from "../db/schema";
import { showQuestionEditor, showQuestionList } from "./question-editor";
import {
  getCompletionPosterSetting,
  saveCompletionPosterSetting,
  type CompletionPosterStyle,
} from "../db/repositories/completion-poster.repository";
import { renderCompletionPoster } from "../services/completion-poster.service";
import { createSurveyFromTemplate, listSurveyTemplates, type SurveyTemplate } from "../services/survey-template.service";
import { clearImageGeneratorInteractionState, ensureReportStyleTemplates, handleImageGeneratorCallback, handleImageGeneratorParticipantMessage } from "./image-generator-handler";
import { clearResultVisualInteractionState } from "./result-visual-admin-handler";
import { clearUiSession } from "../services/ui-session.service";
import { clearIdentityCardInteractionState, handleIdentityCardCallback, handleIdentityCardMessage } from "./identity-card-handler";
import { listVisualTemplates } from "../db/repositories/visual-template.repository";

const compactChoiceLabelLength = 18;
const botUsernameCacheKey = "telegram-bot-username";
const publicSurveySearchKeyPrefix = "public-survey-search:";
const publicSurveySearchInputKeyPrefix = "public-survey-search-input:";

function publicSurveySearchKey(userId: number): string {
  return `${publicSurveySearchKeyPrefix}${userId}`;
}

function publicSurveySearchInputKey(userId: number): string {
  return `${publicSurveySearchInputKeyPrefix}${userId}`;
}

async function getSurveyShareUrl(
  ctx: BotContext,
  surveyId: number,
): Promise<string> {
  let username = await ctx.cache?.get(botUsernameCacheKey);
  if (!username) {
    username = await getBotUsername(ctx.botToken);
    await ctx.cache?.put(botUsernameCacheKey, username, {
      expirationTtl: 7 * 24 * 60 * 60,
    });
  }
  return `https://t.me/${username}?start=survey_${surveyId}`;
}

function bytesToDataUrl(bytes: Uint8Array, contentType: string): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

async function sendCompletionPoster(
  ctx: BotContext,
  chatId: number,
  surveyId: number,
): Promise<void> {
  if (!ctx.browser) return;
  const setting = await getCompletionPosterSetting(ctx.db, surveyId);
  if (!setting.enabled) return;
  const survey = await getSurveyById(ctx.db, surveyId);
  if (!survey) return;
  let imageDataUrl: string | undefined;
  try {
    let mediaId = survey.coverMediaId;
    if (!mediaId) {
      const flow = await getSurveyFlow(ctx.db, surveyId);
      for (const question of flow.questions) {
        const media = await getQuestionMediaByQuestionId(ctx.db, question.id);
        if (media[0]) {
          mediaId = media[0].mediaAssetId;
          break;
        }
      }
    }
    const asset = mediaId ? await getMediaAssetById(ctx.db, mediaId) : null;
    if (asset?.mediaType === "photo" && asset.telegramFileId && (asset.fileSize ?? 0) <= 4 * 1024 * 1024) {
      const image = await downloadTelegramFile(ctx.botToken, asset.telegramFileId);
      imageDataUrl = bytesToDataUrl(image.data, image.contentType);
    }
  } catch (error) {
    console.warn("Completion poster cover image unavailable", error);
  }
  const posterData = {
    surveyTitle: survey.title,
    completedAt: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    style: setting.style,
    ...(imageDataUrl ? { imageDataUrl } : {}),
  };
  const png = await renderCompletionPoster(ctx.browser, posterData);
  await sendPhoto(ctx.botToken, chatId, png, "你的完成海报");
}

function buildHomeKeyboard(
  creator: boolean,
  administrator: boolean,
  hasPausedSurvey = false,
): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [{ text: "浏览问卷", callback_data: "home:surveys" }],
    [{ text: "🪪 身份认证卡", callback_data: "identity:list" }],
  ];
  if (hasPausedSurvey) {
    rows.push([{ text: "▶️ 继续填写", callback_data: "home:resume_survey" }]);
  }
  if (creator) {
    rows.push([
      { text: "创建与导入", callback_data: "home:create_menu" },
      { text: "我的问卷", callback_data: "home:my_surveys" },
    ]);
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
): Promise<void> {
  const creator = await canCreateSurvey(ctx.db, dbUser, ctx.adminIds);
  const pausedResponse = await getActiveResponseByUser(ctx.db, dbUser.id);
  const text = creator
    ? "欢迎回来。选择一个入口开始操作。\n\n🔑 需要问卷密码、软件授权或部署支持，请联系 @meiebhiebot。"
    : "欢迎使用问卷机器人。选择问卷后即可开始填写。\n\n🔑 需要问卷密码、软件授权或部署支持，请联系 @meiebhiebot。";
  await renderScreen({
    botToken: ctx.botToken,
    chatId,
    userId,
    screen: "home",
    text,
    replyMarkup: buildHomeKeyboard(creator, isAdmin(userId, ctx.adminIds), Boolean(pausedResponse)),
    ...(messageId === undefined ? {} : { messageId }),
  });
}

async function showCreateMenu(ctx: BotContext, chatId: number, userId: number): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user || !(await canCreateSurvey(ctx.db, user, ctx.adminIds))) {
    await sendMessage(ctx.botToken, chatId, "你没有创建问卷的权限。");
    return;
  }
  await renderUiScreen(ctx, chatId, userId, { screen: "create_menu", text: "创建问卷\n\n选择一种开始方式：", replyMarkup: {
    inline_keyboard: [
      [{ text: "➕ 新建问卷", callback_data: "home:new_survey" }],
      [{ text: "📝 继续草稿", callback_data: "home:continue" }],
      [{ text: "📥 导入或复制", callback_data: "home:import_or_copy" }],
    ],
  }});
}

async function showNewSurveyMenu(ctx: BotContext, chatId: number, userId: number): Promise<void> {
  await renderUiScreen(ctx, chatId, userId, { screen: "new_survey", text: "新建问卷\n\n选择空白问卷，或先从模板开始：", replyMarkup: {
    inline_keyboard: [
      [{ text: "从空白问卷开始", callback_data: "home:create" }],
      [{ text: "从模板开始", callback_data: "home:templates" }],
      [{ text: "⬅️ 返回", callback_data: "home:create_menu" }],
    ],
  }});
}

async function showImportOrCopyMenu(
  ctx: BotContext,
  chatId: number,
  userId: number,
): Promise<void> {
  await renderUiScreen(ctx, chatId, userId, { screen: "import_or_copy", text: "导入或复制\n\n导入 JSON 文件，或复制自己已有的问卷：", replyMarkup: {
    inline_keyboard: [
      [{ text: "导入 JSON 问卷", callback_data: "home:import_json" }],
      [{ text: "复制已有问卷", callback_data: "home:copy_list" }],
      [{ text: "⬅️ 返回", callback_data: "home:create_menu" }],
    ],
  }});
}

export function usesNumberedChoiceList(
  question: Pick<SurveyQuestionView, "options">,
): boolean {
  return question.options.some(
    (option) =>
      option.label.includes("\n") ||
      Array.from(option.label.trim()).length > compactChoiceLabelLength,
  );
}

function choiceButtonLabel(
  question: Pick<SurveyQuestionView, "options">,
  optionIndex: number,
): string {
  const option = question.options[optionIndex];
  if (!option) return `选择 ${optionIndex + 1}`;
  return usesNumberedChoiceList(question)
    ? `选择 ${optionIndex + 1}`
    : option.label;
}

export function buildSingleChoiceKeyboard(
  question: SurveyQuestionView,
  currentIndex: number,
): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  if (currentIndex > 0) {
    rows.push([
      {
        text: "⬅️ 上一题",
        callback_data: `q:prev:${question.id}`,
      },
    ]);
  }

  rows.push(
    ...question.options.map((option, optionIndex) => [
      {
        text: choiceButtonLabel(question, optionIndex),
        callback_data: `q:single:${question.id}:${option.id}`,
      },
    ]),
  );

  if (!question.required) {
    rows.push([
      {
        text: "跳过此题",
        callback_data: `q:skip:${question.id}`,
      },
    ]);
  }

  rows.push([
    {
      text: "💾 暂存",
      callback_data: `q:pause:${question.surveyId}`,
    },
    {
      text: "退出并放弃",
      callback_data: `q:exit:${question.surveyId}`,
    },
  ]);

  return { inline_keyboard: rows };
}

function usesSingleChoiceKeyboard(question: SurveyQuestionView): boolean {
  return (
    question.type === "single" ||
    question.type === "yes_no" ||
    question.type === "rating"
  );
}

function matrixColumns(question: SurveyQuestionView): string[] {
  try {
    const parsed = question.settingsJson ? JSON.parse(question.settingsJson) as { columns?: unknown } : null;
    return Array.isArray(parsed?.columns)
      ? parsed.columns.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

export function buildMatrixKeyboard(
  question: SurveyQuestionView,
  selections: Record<string, number>,
  currentIndex: number,
): InlineKeyboardMarkup {
  const columns = matrixColumns(question);
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  if (currentIndex > 0) rows.push([{ text: "⬅️ 上一题", callback_data: `q:prev:${question.id}` }]);

  const completedRows = question.options.filter((row) => selections[String(row.id)] !== undefined).length;
  rows.push([{ text: `已完成 ${completedRows}/${question.options.length} 行 · 点选一行填写`, callback_data: "q:matrix:label" }]);
  for (const [rowIndex, row] of question.options.entries()) {
    const selectedColumn = selections[String(row.id)];
    const selectedLabel = selectedColumn === undefined ? "未选择" : columns[selectedColumn] ?? "未选择";
    rows.push([{
      text: `${selectedColumn === undefined ? "⬜" : "✅"} ${rowIndex + 1}. ${row.label} · ${selectedLabel}`,
      callback_data: `q:matrix:row:${question.id}:${row.id}`,
    }]);
  }
  if (!question.required) rows.push([{ text: "跳过此题", callback_data: `q:skip:${question.id}` }]);
  rows.push([{ text: "完成矩阵", callback_data: `q:matrix:confirm:${question.id}` }]);
  rows.push([
    { text: "💾 暂存", callback_data: `q:pause:${question.surveyId}` },
    { text: "退出并放弃", callback_data: `q:exit:${question.surveyId}` },
  ]);
  return { inline_keyboard: rows };
}

export function buildMatrixColumnKeyboard(
  question: SurveyQuestionView,
  rowId: number,
  currentIndex: number,
  selectedColumnIndex: number | undefined,
): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  if (currentIndex > 0) rows.push([{ text: "⬅️ 上一题", callback_data: `q:prev:${question.id}` }]);
  rows.push(...matrixColumns(question).map((column, columnIndex) => [{
    text: `${selectedColumnIndex === columnIndex ? "✅" : "⬜"} ${column}`,
    callback_data: `q:matrix:select:${question.id}:${rowId}:${columnIndex}`,
  }]));
  rows.push([{ text: "⬅️ 返回行列表", callback_data: `q:matrix:back:${question.id}` }]);
  return { inline_keyboard: rows };
}

export function buildMultipleChoiceKeyboard(
  question: SurveyQuestionView,
  selectedOptionIds: number[],
  currentIndex: number,
): InlineKeyboardMarkup {
  const selected = new Set(selectedOptionIds);
  const optionRows = question.options.map((option, optionIndex) => [
    {
      text: `${selected.has(option.id) ? "✅" : "⬜"} ${choiceButtonLabel(question, optionIndex)}`,
      callback_data: `q:multi:toggle:${question.id}:${option.id}`,
    },
  ]);

  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  if (currentIndex > 0) {
    rows.push([
      {
        text: "⬅️ 上一题",
        callback_data: `q:prev:${question.id}`,
      },
    ]);
  }
  rows.push(...optionRows);
  if (!question.required) {
    rows.push([
      {
        text: "跳过此题",
        callback_data: `q:skip:${question.id}`,
      },
    ]);
  }
  rows.push([
    {
      text: "完成选择",
      callback_data: `q:multi:confirm:${question.id}`,
    },
  ]);
  rows.push([
    {
      text: "💾 暂存",
      callback_data: `q:pause:${question.surveyId}`,
    },
    {
      text: "退出并放弃",
      callback_data: `q:exit:${question.surveyId}`,
    },
  ]);

  return { inline_keyboard: rows };
}

function buildNavigationKeyboard(
  question: SurveyQuestionView,
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

  if (!question.required) {
    rows.push([
      {
        text: "跳过此题",
        callback_data: `q:skip:${question.id}`,
      },
    ]);
  }

  rows.push([
    {
      text: "💾 暂存",
      callback_data: `q:pause:${question.surveyId}`,
    },
    {
      text: "退出并放弃",
      callback_data: `q:exit:${question.surveyId}`,
    },
  ]);

  return { inline_keyboard: rows };
}

function formatQuestionIntro(
  question: SurveyQuestionView,
  index: number,
  total: number,
): string {
  const parts = [`第 ${index + 1} / ${total} 题`, question.title];
  if (question.description) {
    parts.push(question.description);
  }
  return parts.join("\n\n");
}

function formatQuestionInstruction(question: SurveyQuestionView): string {
  if (usesSingleChoiceKeyboard(question)) {
    if (question.type === "rating") {
      return "请选择一个分数";
    }
    return "请选择一个选项";
  }
  if (question.type === "multiple") {
    return "可选择多个选项，完成后点击“完成选择”";
  }
  if (question.type === "matrix") {
    return "请为每一行选择一个选项，完成后点击“完成矩阵”";
  }
  if (
    question.type === "image" ||
    question.type === "video" ||
    question.type === "audio" ||
    question.type === "file"
  ) {
    return "请直接发送对应的媒体文件";
  }
  if (question.type === "number") return "请输入一个数字";
  if (question.type === "date") return "请输入日期，格式：YYYY-MM-DD";
  if (question.type === "time") return "请输入时间，格式：HH:MM";
  return "请直接发送你的回答";
}

export function formatQuestionText(
  question: SurveyQuestionView,
  index: number,
  total: number,
): string {
  return [
    formatQuestionIntro(question, index, total),
    formatQuestionInstruction(question),
  ].join("\n\n");
}

export function formatChoiceOptionText(
  optionNumber: number,
  label: string,
): string {
  return `【选项 ${optionNumber}】\n\n${label.trim()}`;
}

async function sendStoredMedia(
  ctx: BotContext,
  chatId: number,
  asset: MediaAsset,
  caption?: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
  if (!asset.telegramFileId) {
    return;
  }

  if (asset.mediaType === "photo") {
    await sendPhoto(
      ctx.botToken,
      chatId,
      asset.telegramFileId,
      caption,
      replyMarkup,
    );
  } else if (asset.mediaType === "video") {
    await sendVideo(
      ctx.botToken,
      chatId,
      asset.telegramFileId,
      caption,
      replyMarkup,
    );
  } else if (asset.mediaType === "audio") {
    await sendAudio(
      ctx.botToken,
      chatId,
      asset.telegramFileId,
      caption,
      replyMarkup,
    );
  } else if (asset.mediaType === "voice") {
    await sendVoice(
      ctx.botToken,
      chatId,
      asset.telegramFileId,
      caption,
      replyMarkup,
    );
  } else if (asset.mediaType === "animation" || asset.mediaType === "gif") {
    await sendAnimation(
      ctx.botToken,
      chatId,
      asset.telegramFileId,
      caption,
      replyMarkup,
    );
  } else if (asset.mediaType === "sticker") {
    await sendSticker(
      ctx.botToken,
      chatId,
      asset.telegramFileId,
      replyMarkup,
    );
  } else {
    await sendDocumentByFileId(
      ctx.botToken,
      chatId,
      asset.telegramFileId,
      caption,
      replyMarkup,
    );
  }
}

interface QuestionMediaGroups {
  question: MediaAsset[];
  options: Map<number, MediaAsset[]>;
}

async function getQuestionMediaGroups(
  ctx: BotContext,
  question: SurveyQuestionView,
): Promise<QuestionMediaGroups> {
  const groups: QuestionMediaGroups = {
    question: [],
    options: new Map(),
  };
  const questionMedia = await getQuestionMediaByQuestionId(ctx.db, question.id);
  for (const relation of questionMedia) {
    const asset = await getMediaAssetById(ctx.db, relation.mediaAssetId);
    if (asset?.telegramFileId) {
      groups.question.push(asset);
    }
  }

  for (const option of question.options) {
    if (!option) continue;
    const optionMedia = await getOptionMediaByOptionId(ctx.db, option.id);
    const assets: MediaAsset[] = [];
    for (const relation of optionMedia) {
      const asset = await getMediaAssetById(ctx.db, relation.mediaAssetId);
      if (asset?.telegramFileId) {
        assets.push(asset);
      }
    }
    if (assets.length > 0) groups.options.set(option.id, assets);
  }

  return groups;
}

async function sendTextWithMedia(
  ctx: BotContext,
  chatId: number,
  text: string,
  assets: MediaAsset[],
): Promise<void> {
  if (assets.length === 0) {
    await sendLongMessage(ctx.botToken, chatId, text);
    return;
  }

  let textSent = false;
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    if (!asset) continue;
    let caption: string | undefined;
    if (!textSent && asset.mediaType !== "sticker" && text.length <= 1024) {
      caption = text;
      textSent = true;
    }
    if (!textSent) {
      await sendLongMessage(ctx.botToken, chatId, text);
      textSent = true;
    }
    if (!caption && index > 0 && asset.mediaType !== "sticker") {
      caption = `附件 ${index + 1}`;
    }
    await sendStoredMedia(ctx, chatId, asset, caption);
  }
}

async function renderNumberedChoiceQuestion(
  ctx: BotContext,
  chatId: number,
  question: SurveyQuestionView,
  questionIndex: number,
  total: number,
  media: QuestionMediaGroups,
  replyMarkup: InlineKeyboardMarkup,
  userId: number,
): Promise<void> {
  const hasMedia = media.question.length > 0 || [...media.options.values()].some((items) => items.length > 0);
  if (!hasMedia) {
    const optionText = question.options.map((option, index) => {
      const label = option.label.replaceAll(/\s+/g, " ").trim();
      const compact = label.length > 260 ? `${label.slice(0, 257)}…` : label;
      return `【${index + 1}】 ${compact}`;
    }).join("\n\n");
    const combined = `${formatQuestionIntro(question, questionIndex, total)}\n\n${optionText}\n\n${formatQuestionInstruction(question)}`;
    await renderUiScreen(ctx, chatId, userId, {
      screen: "participant_question",
      text: combined.length > 3900 ? `${combined.slice(0, 3897)}…` : combined,
      replyMarkup,
      state: { surveyId: question.surveyId, questionId: question.id },
    });
    return;
  }
  await sendTextWithMedia(
    ctx,
    chatId,
    formatQuestionIntro(question, questionIndex, total),
    media.question,
  );

  for (let optionIndex = 0; optionIndex < question.options.length; optionIndex += 1) {
    const option = question.options[optionIndex];
    if (!option) continue;
    await sendTextWithMedia(
      ctx,
      chatId,
      formatChoiceOptionText(optionIndex + 1, option.label),
      media.options.get(option.id) ?? [],
    );
  }

  await renderUiScreen(ctx, chatId, userId, {
    screen: "participant_question",
    text: formatQuestionInstruction(question),
    replyMarkup,
    state: { surveyId: question.surveyId, questionId: question.id },
  });
}

async function renderQuestion(
  ctx: BotContext,
  chatId: number,
  _responseId: number,
  question: SurveyQuestionView,
  flowQuestions: SurveyQuestionView[],
  userId: number,
  surveyId: number,
): Promise<void> {
  const index = flowQuestions.findIndex((item) => item.id === question.id);
  const total = flowQuestions.length;

  let replyMarkup: InlineKeyboardMarkup;

  if (usesSingleChoiceKeyboard(question)) {
    replyMarkup = buildSingleChoiceKeyboard(question, index);
  } else if (question.type === "multiple") {
    const selected = await getSessionSelectedOptions(ctx.session, userId, surveyId);
    replyMarkup = buildMultipleChoiceKeyboard(question, selected, index);
  } else if (question.type === "matrix") {
    const selected = await getSessionMatrixSelections(ctx.session, userId, surveyId);
    replyMarkup = buildMatrixKeyboard(question, selected, index);
  } else {
    replyMarkup = buildNavigationKeyboard(question, index);
  }

  const mediaGroups = await getQuestionMediaGroups(ctx, question);
  if (
    (usesSingleChoiceKeyboard(question) || question.type === "multiple") &&
    usesNumberedChoiceList(question)
  ) {
    await renderNumberedChoiceQuestion(
      ctx,
      chatId,
      question,
      index,
      total,
      mediaGroups,
      replyMarkup,
      userId,
    );
    return;
  }

  const prompt = formatQuestionText(question, index, total);
  const mediaItems: Array<{
    asset: MediaAsset;
    label: string | null;
  }> = [
    ...mediaGroups.question.map((asset) => ({ asset, label: null })),
  ];
  for (let optionIndex = 0; optionIndex < question.options.length; optionIndex += 1) {
    const option = question.options[optionIndex];
    if (!option) continue;
    for (const asset of mediaGroups.options.get(option.id) ?? []) {
      mediaItems.push({
        asset,
        label: `选项 ${optionIndex + 1}：${option.label}`,
      });
    }
  }
  if (mediaItems.length === 0) {
    await renderUiScreen(ctx, chatId, userId, {
      screen: "participant_question",
      text: prompt,
      replyMarkup,
      state: { surveyId, questionId: question.id },
    });
    return;
  }

  let promptSent = false;
  for (let mediaIndex = 0; mediaIndex < mediaItems.length; mediaIndex += 1) {
    const item = mediaItems[mediaIndex];
    if (!item) continue;
    const isLast = mediaIndex === mediaItems.length - 1;
    let caption = item.label ?? undefined;

    if (!promptSent && item.asset.mediaType !== "sticker") {
      const combined = item.label ? `${prompt}\n\n${item.label}` : prompt;
      if (combined.length <= 1024) {
        caption = combined;
        promptSent = true;
      }
    }

    if (!promptSent && (item.asset.mediaType === "sticker" || mediaIndex === 0)) {
      await sendLongMessage(ctx.botToken, chatId, prompt);
      promptSent = true;
    }

    if (caption && caption.length > 1024) {
      await sendLongMessage(ctx.botToken, chatId, caption);
      caption = undefined;
    }

    await sendStoredMedia(
      ctx,
      chatId,
      item.asset,
      caption,
      isLast ? replyMarkup : undefined,
    );
  }
}

/*
 * Choice questions are answered through callbacks. Other questions advance as
 * soon as the participant sends a valid text or media answer.
 */
function isDirectAnswerQuestion(question: SurveyQuestionView): boolean {
  return !usesSingleChoiceKeyboard(question) && question.type !== "multiple" && question.type !== "matrix";
}

/*
 * Kept as a separate predicate so routing and rendering use the same behavior.
 */
function acceptsMediaAnswer(question: SurveyQuestionView): boolean {
  return (
    question.type === "image" ||
    question.type === "video" ||
    question.type === "audio" ||
    question.type === "file"
  );
}

function messageMatchesMediaQuestion(
  question: SurveyQuestionView,
  message: TelegramMessage,
): boolean {
  if (question.type === "image") {
    return Boolean(message.photo);
  }
  if (question.type === "video") {
    return Boolean(message.video || message.animation);
  }
  if (question.type === "audio") {
    return Boolean(message.audio || message.voice);
  }
  if (question.type === "file") {
    return Boolean(message.document);
  }
  return false;
}

function builderOwnsNextMessage(
  state: Awaited<ReturnType<typeof getBuilderState>>,
): boolean {
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

function normalizeDateAnswer(value: string): string | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return value;
}

function normalizeTimeAnswer(value: string): string | null {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? value : null;
}

async function advanceQuestion(
  ctx: BotContext,
  chatId: number,
  responseId: number,
  currentQuestionId: number,
  flowQuestions: SurveyQuestionView[],
  userId: number,
  surveyId: number,
  selectedOptionId: number | null = null,
): Promise<void> {
  const next = getNextQuestionAfterOption(
    { questions: flowQuestions },
    currentQuestionId,
    selectedOptionId,
  );

  if (!next) {
    const answered = await ctx.db.prepare(
      "SELECT COUNT(*) AS count FROM answers WHERE response_id = ?",
    ).bind(responseId).first<{ count: number }>();
    await renderUiScreen(ctx, chatId, userId, { screen: "participant_submit", text: `填写检查\n\n已保存 ${answered?.count ?? 0} 项回答。你可以返回上一题修改，确认后再提交。`, replyMarkup: {
      inline_keyboard: [
        [{ text: "返回上一题修改", callback_data: `q:prev:${currentQuestionId}` }],
        [{ text: "确认提交问卷", callback_data: `q:submit:${surveyId}` }],
        [{ text: "💾 暂存并稍后继续", callback_data: `q:pause:${surveyId}` }],
        [{ text: "退出并放弃", callback_data: `q:exit:${surveyId}` }],
      ],
    }});
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

type ActiveParticipantResponse = {
  id: number;
  survey_id: number;
  current_question_id: number | null;
};

async function refreshStaleQuestionCallback(
  ctx: BotContext,
  chatId: number,
  userId: number,
  callbackId: string,
  response: ActiveParticipantResponse | null,
): Promise<void> {
  if (!response?.current_question_id) {
    await answerCallbackQuery(ctx.botToken, callbackId, "当前问卷已结束或不存在");
    return;
  }
  const flow = await getSurveyFlow(ctx.db, response.survey_id);
  const current = getQuestionById(flow, response.current_question_id);
  if (!current) {
    await answerCallbackQuery(ctx.botToken, callbackId, "当前题目不存在，请重新开始问卷");
    return;
  }
  await setSessionCurrentQuestion(ctx.session, userId, response.survey_id, current.id);
  await renderQuestion(ctx, chatId, response.id, current, flow.questions, userId, response.survey_id);
  await answerCallbackQuery(ctx.botToken, callbackId, "题目已更新，已刷新当前题目");
}

function isAnswered(answer: Answer | undefined): boolean {
  if (!answer) return false;
  if (answer.jsonValue !== null) {
    try {
      const parsed = JSON.parse(answer.jsonValue) as unknown;
      if (Array.isArray(parsed)) return parsed.length > 0;
    } catch {
      // Unparseable legacy values are treated as answered.
    }
    return true;
  }
  return (
    answer.textValue !== null ||
    answer.numberValue !== null ||
    answer.booleanValue !== null ||
    answer.dateValue !== null ||
    answer.timeValue !== null
  );
}

function selectedOptionIdForSkip(
  question: SurveyQuestionView,
  answer: Answer | undefined,
): number | null {
  if (
    question.type !== "single" &&
    question.type !== "yes_no" &&
    question.type !== "rating"
  ) {
    return null;
  }
  if (!answer?.jsonValue) return null;
  try {
    const parsed = JSON.parse(answer.jsonValue) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const optionId = Number(parsed[0]);
      return Number.isInteger(optionId) && optionId > 0 ? optionId : null;
    }
  } catch {
    return null;
  }
  return null;
}

/*
 * Mirrors the answer-time walk (skip rules included) so only questions that
 * are actually on the participant's path get checked at submit time.
 */
function findMissingRequiredQuestion(
  flowQuestions: SurveyQuestionView[],
  answersByQuestion: Map<number, Answer>,
): SurveyQuestionView | null {
  const visited = new Set<number>();
  let current = getFirstQuestion({ questions: flowQuestions });
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const answer = answersByQuestion.get(current.id);
    if (current.required && !isAnswered(answer)) {
      return current;
    }
    current = getNextQuestionAfterOption(
      { questions: flowQuestions },
      current.id,
      selectedOptionIdForSkip(current, answer),
    );
  }
  return null;
}

async function getResponseForUser(
  ctx: BotContext,
  survey: Survey,
  dbUserId: number,
  firstQuestionId: number,
) {
  const active = await getActiveResponseBySurveyAndUser(
    ctx.db,
    survey.id,
    dbUserId,
  );
  if (active) {
    return active;
  }

  const participantHash = `user_${dbUserId}`;
  if (survey.allowMultipleResponses) {
    return createResponse(ctx.db, {
      surveyId: survey.id,
      userId: dbUserId,
      participantHash: `${participantHash}_${crypto.randomUUID()}`,
      currentQuestionId: firstQuestionId,
    });
  }

  const existing = await getResponseBySurveyAndHash(
    ctx.db,
    survey.id,
    participantHash,
  );

  if (existing?.status === "completed") {
    throw new Error("你已经完成过该问卷，不能重复提交。");
  }
  if (existing) {
    return restartResponse(ctx.db, existing.id, firstQuestionId);
  }

  return createResponse(ctx.db, {
    surveyId: survey.id,
    userId: dbUserId,
    participantHash,
    currentQuestionId: firstQuestionId,
  });
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

async function startSurvey(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
  skipAccessCheck = false,
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

  if (
    !skipAccessCheck &&
    survey.accessCode &&
    !(isAdmin(userId, ctx.adminIds) || survey.ownerId === user.id)
  ) {
    await initBuilder(ctx.builder, userId);
    await startSurveyAccessCode(ctx.builder, userId, surveyId);
    await sendMessage(ctx.botToken, chatId, "请输入问卷访问密码：");
    return;
  }

  const flow = await getSurveyFlow(ctx.db, surveyId);
  const firstQuestion = getFirstQuestion(flow);
  if (!firstQuestion) {
    await sendMessage(ctx.botToken, chatId, "该问卷还没有题目。");
    return;
  }

  const activeResponse = await getActiveResponseByUser(ctx.db, user.id);
  if (activeResponse && activeResponse.surveyId !== surveyId) {
    await sendMessage(
      ctx.botToken,
      chatId,
      "你还有另一份进行中的问卷，请先在原问卷中点击“退出问卷”。",
    );
    return;
  }

  const response = await getResponseForUser(
    ctx,
    survey,
    user.id,
    firstQuestion.id,
  );
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
  filter?: Survey["status"],
  page = 0,
  messageId?: number,
): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) {
    await sendMessage(ctx.botToken, chatId, "用户信息不存在，请重新 /start。");
    return;
  }

  const surveys = (await listOwnedSurveys(ctx.db, user.id)).filter(
    (survey) => !filter || survey.status === filter,
  );
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
    : `${Array.from(compact).slice(0, maxLength - 1).join("")}…`;
}

export function cleanSurveyDescription(description: string | null): string | null {
  const compact = description?.replace(/\s+/g, " ").trim() ?? "";
  if (!compact || /^Imported from Microsoft Forms PDF\.?$/i.test(compact)) {
    return null;
  }
  return compact;
}

function formatResponseRespondent(
  respondent: Awaited<ReturnType<typeof listResponses>>[number]["respondent"],
  anonymous: boolean,
): string {
  if (anonymous) return "匿名填写者";
  if (!respondent) return "未知填写者";
  const name = [respondent.firstName, respondent.lastName]
    .filter(Boolean)
    .join(" ");
  if (name) return name;
  if (respondent.username) return `@${respondent.username}`;
  return `用户 ${respondent.telegramUserId}`;
}

async function listManageableSurveys(
  ctx: BotContext,
  userId: number,
): Promise<Survey[]> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) throw new Error("用户信息不存在，请重新 /start。");
  if (user.systemRole === "admin" || isAdmin(user.telegramUserId, ctx.adminIds)) {
    return listAllSurveys(ctx.db);
  }
  return listOwnedSurveys(ctx.db, user.id);
}

export async function showSurveyPasswordMenu(
  ctx: BotContext,
  chatId: number,
  userId: number,
): Promise<void> {
  const surveys = await listManageableSurveys(ctx, userId);
  if (surveys.length === 0) {
    await sendMessage(ctx.botToken, chatId, "当前没有可管理的问卷。");
    return;
  }

  const rows: InlineKeyboardMarkup["inline_keyboard"] = surveys.map(
    (survey, index) => [
      {
        text: `${survey.accessCode ? "🔐 已保护" : "🔓 未设置"} · ${compactSurveyTitle(survey.title)}`,
        callback_data: `owner:access_view:${survey.id}`,
      },
    ],
  );
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

const responseStatusLabels = {
  in_progress: "填写中",
  completed: "已完成",
  abandoned: "已中止",
  cancelled: "已取消",
} as const;

const chinaDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatChinaDateTime(value: string | null): string {
  if (!value) return "未完成";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? chinaDateTimeFormatter.format(date)
    : value;
}

function formatRespondent(
  respondent: Awaited<ReturnType<typeof getResponseDetail>> extends infer Detail
    ? Detail extends { respondent: infer Respondent }
      ? Respondent
      : never
    : never,
  anonymous: boolean,
): string {
  if (anonymous) return "匿名";
  if (!respondent) return "未知填写者";
  const name = [respondent.firstName, respondent.lastName]
    .filter(Boolean)
    .join(" ");
  const parts = [
    name,
    respondent.username ? `@${respondent.username}` : "",
    `Telegram ID: ${respondent.telegramUserId}`,
  ].filter(Boolean);
  return parts.join(" / ");
}

function formatStoredAnswer(
  answer: Awaited<ReturnType<typeof getResponseDetail>> extends infer Detail
    ? Detail extends { answers: Array<infer Item> }
      ? Item | undefined
      : never
    : never,
  question: SurveyQuestionView,
): string {
  if (!answer) return "未作答";

  if (answer.jsonValue) {
    try {
      const parsed = JSON.parse(answer.jsonValue) as unknown;
      if (
        question.type === "matrix" && parsed && typeof parsed === "object" &&
        (parsed as { kind?: unknown }).kind === "matrix"
      ) {
        const selections = (parsed as { selections?: unknown }).selections;
        const columns = matrixColumns(question);
        if (selections && typeof selections === "object") {
          const rowLabels = new Map(question.options.map((row) => [String(row.id), row.label]));
          return Object.entries(selections as Record<string, unknown>)
            .map(([rowId, columnIndex]) => `${rowLabels.get(rowId) ?? `行 #${rowId}`}：${columns[Number(columnIndex)] ?? `列 ${Number(columnIndex) + 1}`}`)
            .join("\n");
        }
      }
      if (Array.isArray(parsed)) {
        const optionLabels = new Map(
          question.options.map((option) => [option.id, option.label]),
        );
        const labels = parsed.map(
          (optionId) =>
            optionLabels.get(Number(optionId)) ?? `已删除选项 #${optionId}`,
        );
        if (labels.length > 0) return labels.join("、");
      } else if (
        parsed &&
        typeof parsed === "object" &&
        "mediaAssetId" in parsed
      ) {
        return "已上传媒体文件";
      }
    } catch {
      return answer.jsonValue;
    }
  }

  if (answer.ratingValue !== null) return String(answer.ratingValue);
  if (answer.numberValue !== null) return String(answer.numberValue);
  if (answer.booleanValue !== null) return answer.booleanValue ? "是" : "否";
  if (answer.dateValue !== null) return answer.dateValue;
  if (answer.timeValue !== null) return answer.timeValue;
  if (answer.textValue !== null) return answer.textValue || "（空白）";
  return "未作答";
}

function describeMediaAsset(asset: MediaAsset): string {
  const typeLabels: Record<MediaAsset["mediaType"], string> = {
    photo: "图片",
    video: "视频",
    audio: "音频",
    voice: "语音",
    animation: "动画",
    gif: "GIF",
    sticker: "贴纸",
    document: "文件",
  };
  const details = [
    typeLabels[asset.mediaType],
    asset.fileName,
    asset.duration ? `${asset.duration} 秒` : null,
  ].filter(Boolean);
  return details.join(" · ");
}

function mediaAssetIdFromJson(jsonValue: string | null): number | null {
  if (!jsonValue) return null;
  try {
    const parsed = JSON.parse(jsonValue) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "mediaAssetId" in parsed
    ) {
      const id = Number(
        (parsed as { mediaAssetId?: unknown }).mediaAssetId,
      );
      return Number.isInteger(id) && id > 0 ? id : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function getAnswerMediaAssets(
  ctx: BotContext,
  answer: NonNullable<
    Awaited<ReturnType<typeof getResponseDetail>>
  >["answers"][number],
): Promise<MediaAsset[]> {
  const relations = await getAnswerMediaByAnswerId(ctx.db, answer.id);
  const ids = relations.map((relation) => relation.mediaAssetId);
  const fallbackId = mediaAssetIdFromJson(answer.jsonValue);
  if (fallbackId && !ids.includes(fallbackId)) {
    ids.push(fallbackId);
  }

  const assets: MediaAsset[] = [];
  for (const id of ids) {
    const asset = await getMediaAssetById(ctx.db, id);
    if (asset) assets.push(asset);
  }
  return assets;
}

interface ResponseReportBundle {
  report: ResponseReport;
  attachments: Array<{
    itemIndex: number;
    mediaIndex: number;
    optionIndex?: number;
    role: "question" | "answer" | "option";
    questionNumber: number;
    asset: MediaAsset;
  }>;
}

async function buildResponseReportBundle(
  ctx: BotContext,
  surveyId: number,
  responseId: number,
  responseNumber: number,
): Promise<ResponseReportBundle> {
  const survey = await getSurveyById(ctx.db, surveyId);
  if (!survey) throw new Error("问卷不存在");
  const detail = await getResponseDetail(ctx.db, responseId, survey.anonymous);
  if (!detail || detail.response.surveyId !== surveyId) {
    throw new Error("答卷不存在或不属于该问卷");
  }

  const flow = await getSurveyFlow(ctx.db, surveyId);
  const answersByQuestion = new Map(
    detail.answers.map((answer) => [answer.questionId, answer]),
  );
  const attachments: ResponseReportBundle["attachments"] = [];
  const items: ResponseReport["items"] = [];

  for (let index = 0; index < flow.questions.length; index += 1) {
    const question = flow.questions[index];
    if (!question) continue;
    const answer = answersByQuestion.get(question.id);
    const answerAssets = answer ? await getAnswerMediaAssets(ctx, answer) : [];
    const questionRelations = await getQuestionMediaByQuestionId(ctx.db, question.id);
    const questionAssets = (await Promise.all(questionRelations.map((relation) => getMediaAssetById(ctx.db, relation.mediaAssetId)))).filter((asset): asset is MediaAsset => asset !== null);
    const itemIndex = items.length;
    const questionMedia = questionAssets.map((asset, mediaIndex) => {
      attachments.push({
        itemIndex,
        mediaIndex,
        role: "question",
        questionNumber: index + 1,
        asset,
      });
      return { id: asset.id, label: describeMediaAsset(asset), role: "question" as const, width: asset.width, height: asset.height };
    });
    const answerMedia = answerAssets.map((asset, mediaIndex) => {
      attachments.push({ itemIndex, mediaIndex, role: "answer", questionNumber: index + 1, asset });
      return { id: asset.id, label: describeMediaAsset(asset), role: "answer" as const, width: asset.width, height: asset.height };
    });
    let parsedAnswer: unknown = null;
    try { parsedAnswer = answer?.jsonValue ? JSON.parse(answer.jsonValue) : null; } catch { parsedAnswer = null; }
    const selectedIds = new Set(Array.isArray(parsedAnswer) ? parsedAnswer.map(Number) : []);
    const matrixSelections = parsedAnswer && typeof parsedAnswer === "object" && !Array.isArray(parsedAnswer) && (parsedAnswer as { kind?: unknown }).kind === "matrix"
      ? ((parsedAnswer as { selections?: Record<string, number> }).selections ?? {})
      : undefined;
    const options = [];
    for (let optionIndex = 0; optionIndex < question.options.length; optionIndex += 1) {
      const option = question.options[optionIndex]!;
      const relations = await getOptionMediaByOptionId(ctx.db, option.id);
      const optionAssets = (await Promise.all(relations.map((relation) => getMediaAssetById(ctx.db, relation.mediaAssetId)))).filter((asset): asset is MediaAsset => asset !== null);
      const optionMedia = optionAssets.map((asset, mediaIndex) => {
        attachments.push({ itemIndex, optionIndex, mediaIndex, role: "option", questionNumber: index + 1, asset });
        return { id: asset.id, label: describeMediaAsset(asset), role: "option" as const, width: asset.width, height: asset.height };
      });
      options.push({ id: option.id, label: option.label, selected: selectedIds.has(option.id), media: optionMedia });
    }
    const answerText = formatStoredAnswer(answer, question);
    const rawAnswer = answer ? answer.textValue ?? (answer.numberValue !== null ? String(answer.numberValue) : answer.dateValue ?? answer.timeValue ?? null) : null;
    items.push({
      questionId: question.id,
      number: index + 1,
      type: question.type,
      title: question.title,
      description: question.description,
      required: question.required,
      answered: Boolean(answer),
      answerId: answer?.id ?? null,
      answer: answerText,
      rawAnswer,
      options,
      matrixColumns: question.type === "matrix" ? matrixColumns(question) : undefined,
      matrixSelections,
      questionMedia,
      answerMedia,
    });
  }

  return {
    report: {
      surveyTitle: survey.title,
      responseNumber,
      status:
        responseStatusLabels[detail.response.status] ?? detail.response.status,
      respondent: formatRespondent(detail.respondent, survey.anonymous),
      startedAt: formatChinaDateTime(detail.response.startedAt),
      completedAt: formatChinaDateTime(detail.response.completedAt),
      items,
    },
    attachments,
  };
}

function bytesToBase64(data: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function addReportImages(
  ctx: BotContext,
  bundle: ResponseReportBundle,
): Promise<ResponseReport> {
  const report: ResponseReport = {
    ...bundle.report,
    items: bundle.report.items.map((item) => ({
      ...item,
      options: item.options.map((option) => ({ ...option, media: option.media.map((media) => ({ ...media })) })),
      questionMedia: item.questionMedia.map((media) => ({ ...media })),
      answerMedia: item.answerMedia.map((media) => ({ ...media })),
    })),
  };

  for (const attachment of bundle.attachments) {
    const asset = attachment.asset;
    if (asset.mediaType !== "photo") continue;
    if (!asset.telegramFileId) throw new Error(`答卷图片 #${asset.id} 缺少可下载文件，已中止导出以避免生成不完整文件`);
    try {
      const downloaded = await downloadTelegramFile(
        ctx.botToken,
        asset.telegramFileId,
      );
      const item = report.items[attachment.itemIndex];
      const media = attachment.role === "option"
        ? item?.options[attachment.optionIndex!]?.media[attachment.mediaIndex]
        : attachment.role === "question"
          ? item?.questionMedia[attachment.mediaIndex]
          : item?.answerMedia[attachment.mediaIndex];
      if (media) {
        media.imageDataUrl = `data:${downloaded.contentType};base64,${bytesToBase64(downloaded.data)}`;
      }
    } catch (error) {
      throw new Error(`答卷媒体 #${asset.id} 下载失败，已中止导出以避免生成不完整文件`, { cause: error });
    }
  }

  return report;
}

async function assertResponseAccess(
  ctx: BotContext,
  userId: number,
  surveyId: number,
): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) throw new Error("用户信息不存在");
  await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
}

async function showSurveyResponses(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
  offset: number,
): Promise<void> {
  await assertResponseAccess(ctx, userId, surveyId);
  const survey = await getSurveyById(ctx.db, surveyId);
  if (!survey) throw new Error("问卷不存在");
  const stats = await getSurveyStatistics(ctx.db, surveyId);
  const pageSize = 8;
  const lastPageOffset =
    stats.totalCompleted === 0
      ? 0
      : Math.floor((stats.totalCompleted - 1) / pageSize) * pageSize;
  const safeOffset = Math.max(0, Math.min(offset, lastPageOffset));
  const responses = await listResponses(
    ctx.db,
    surveyId,
    pageSize,
    safeOffset,
    "completed",
  );
  const rows: InlineKeyboardMarkup["inline_keyboard"] = responses.map(
    (response, index) => {
      const responseNumber = stats.totalCompleted - safeOffset - index;
      return [
        {
          text: `第 ${responseNumber} 份 · ${formatResponseRespondent(response.respondent, survey.anonymous)}`,
          callback_data: `owner:response:${surveyId}:${response.id}:${responseNumber}:${safeOffset}`,
        },
      ];
    },
  );

  const navigation: InlineKeyboardMarkup["inline_keyboard"][number] = [];
  if (safeOffset > 0) {
    navigation.push({
      text: "上一页",
      callback_data: `owner:responses:${surveyId}:${Math.max(0, safeOffset - pageSize)}`,
    });
  }
  if (safeOffset + responses.length < stats.totalCompleted) {
    navigation.push({
      text: "下一页",
      callback_data: `owner:responses:${surveyId}:${safeOffset + pageSize}`,
    });
  }
  if (navigation.length > 0) rows.push(navigation);
  rows.push([
    {
      text: "返回统计",
      callback_data: `owner:survey:${surveyId}`,
    },
  ]);

  const page = Math.floor(safeOffset / pageSize) + 1;
  await renderUiScreen(ctx, chatId, userId, {
    screen: "response_list",
    text: stats.totalCompleted === 0
      ? `“${survey.title}”还没有已完成的答卷。`
      : `“${survey.title}”已完成 ${stats.totalCompleted} 份答卷\n第 ${page} 页`,
    replyMarkup: { inline_keyboard: rows },
    state: { surveyId, offset: safeOffset },
  });
}

async function showResponseDetail(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
  responseId: number,
  responseNumber: number,
  returnOffset: number,
): Promise<void> {
  await assertResponseAccess(ctx, userId, surveyId);
  await renderUiScreen(ctx, chatId, userId, { screen: "response_actions", text: `第 ${responseNumber} 份答卷\n请选择操作：`, replyMarkup: {
    inline_keyboard: [
      [
        {
          text: "🎨 生成分析报告",
          callback_data: `owner:response_report:${surveyId}:${responseId}`,
        },
      ],
      [
        {
          text: "📱 手机版报告",
          callback_data: `owner:response_export:png:${surveyId}:${responseId}:${responseNumber}:${returnOffset}`,
        },
      ],
      [
        {
          text: "💻 高清 PDF",
          callback_data: `owner:response_export:pdf:${surveyId}:${responseId}:${responseNumber}:${returnOffset}`,
        },
      ],
      [
        {
          text: "脱敏 PDF",
          callback_data: `owner:response_export:pdf_private:${surveyId}:${responseId}:${responseNumber}:${returnOffset}`,
        },
      ],
      [
        {
          text: "返回答卷列表",
          callback_data: `owner:responses:${surveyId}:${returnOffset}`,
        },
      ],
    ],
  }, state: { surveyId, responseId, returnOffset } });
}

async function showManagedResponseReportTemplates(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
  responseId: number,
): Promise<void> {
  await assertResponseAccess(ctx, userId, surveyId);
  const response = await getResponseById(ctx.db, responseId);
  if (!response || response.surveyId !== surveyId || response.status !== "completed") {
    throw new Error("找不到可生成报告的已完成答卷");
  }
  const templates = (await listVisualTemplates(ctx.db, 100)).filter((template) =>
    template.type === "report" &&
    template.status === "published" &&
    template.currentVersion &&
    (template.surveyId === null || template.surveyId === surveyId),
  );
  await renderUiScreen(ctx, chatId, userId, {
    screen: "response_report_templates",
    text: templates.length
      ? "🎨 生成分析报告\n\n请选择报告模板。生成结果会发送到当前管理员会话。"
      : "当前没有适用于该问卷的已发布报告模板。",
    replyMarkup: {
      inline_keyboard: [
        ...templates.map((template) => [{
          text: `📊 ${template.name}`,
          callback_data: `owner:response_report_generate:${surveyId}:${responseId}:${template.id}`,
        }]),
        [{ text: "返回答卷列表", callback_data: `owner:responses:${surveyId}:0` }],
      ],
    },
    state: { surveyId, responseId },
  });
}

export async function sendResponseReportExport(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
  responseId: number,
  responseNumber: number,
  format: "pdf" | "png",
  anonymize = false,
): Promise<void> {
  await assertResponseAccess(ctx, userId, surveyId);
  if (!ctx.browser) {
    throw new Error("当前部署未启用 PDF/PNG 导出服务");
  }
  const bundle = await buildResponseReportBundle(
    ctx,
    surveyId,
    responseId,
    responseNumber,
  );
  const report = await addReportImages(ctx, bundle);
  if (anonymize) {
    report.respondent = "已隐藏";
    report.startedAt = "已隐藏";
  }
  const artifact = await renderResponseReport(ctx.browser, report, format);
  if (artifact.format === "png") {
    for (let offset = 0; offset < artifact.pages.length; offset += 10) {
      const pages = artifact.pages.slice(offset, offset + 10);
      if (pages.length === 1) {
        await sendPhoto(ctx.botToken, chatId, pages[0]!.bytes, `📱 手机版报告 · 第 ${offset + 1}/${artifact.pages.length} 页`);
      } else {
        await sendPhotoAlbum(ctx.botToken, chatId, pages.map((page, index) => ({
          bytes: page.bytes,
          ...(index === 0 ? { caption: `📱 手机版报告 · 第 ${offset + 1}–${offset + pages.length}/${artifact.pages.length} 页` } : {}),
        })));
      }
    }
    if (artifact.targetTotalBytesExceeded) {
      await sendMessage(ctx.botToken, chatId, `手机版报告共 ${artifact.pages.length} 页、${(artifact.totalBytes / 1024 / 1024).toFixed(1)} MB，内容已全部发送。`);
    }
    return;
  }
  const files = [artifact.bytes];
  for (let index = 0; index < files.length; index += 1) {
    await sendDocument(
      ctx.botToken,
      chatId,
      `survey-${surveyId}-response-${responseNumber}${anonymize ? "-private" : ""}${files.length > 1 ? `-page-${String(index + 1).padStart(2, "0")}` : ""}.${format}`,
      files[index]!,
      "application/pdf",
    );
  }
}

async function sendSurveyExport(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
  format: SurveyExportFormat,
): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) {
    throw new Error("用户信息不存在");
  }
  await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);

  const jobId = await enqueueExportJob(ctx, {
    surveyId,
    userId: user.id,
    chatId,
    format,
  });
  await sendMessage(
    ctx.botToken,
    chatId,
    `导出任务 #${jobId} 已创建，文件生成后会自动发送。`,
  );
}

async function sendSurveySummaryPdf(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
): Promise<void> {
  await assertResponseAccess(ctx, userId, surveyId);
  if (!ctx.browser) {
    throw new Error("当前部署未启用 PDF 导出服务");
  }
  const [survey, statistics, optionStatistics, numericStatistics] = await Promise.all([
    getSurveyById(ctx.db, surveyId),
    getSurveyStatistics(ctx.db, surveyId),
    getOptionStatistics(ctx.db, surveyId),
    getNumericStatistics(ctx.db, surveyId),
  ]);
  if (!survey) throw new Error("问卷不存在");
  const content = await renderSurveySummaryReport(ctx.browser, {
    surveyTitle: survey.title,
    surveyId,
    generatedAt: formatChinaDateTime(new Date().toISOString()),
    statistics,
    optionStatistics,
    numericStatistics,
  });
  await sendDocument(
    ctx.botToken,
    chatId,
    `survey-${surveyId}-statistics.pdf`,
    content,
    "application/pdf",
  );
}

async function sendSurveyJsonExport(
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

  const unified = await exportUnifiedSurveyJson(ctx.db, surveyId);
  if (!unified) {
    throw new Error("问卷不存在");
  }
  await sendDocument(
    ctx.botToken,
    chatId,
    `survey-${surveyId}.json`,
    JSON.stringify(unified, null, 2),
    "application/json",
  );
}

async function sendSurveyPreview(
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

  const flow = await getSurveyFlow(ctx.db, surveyId);
  if (flow.questions.length === 0) {
    throw new Error("问卷没有题目");
  }
  const preview = flow.questions
    .map((question, index) => {
      const options = question.options
        .map((option, optionIndex) => `  ${optionIndex + 1}. ${option.label}`)
        .join("\n");
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
  await sendMessage(
    ctx.botToken,
    chatId,
    `已复制问卷，新问卷内部编号：${duplicated.id}`,
    {
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
    },
  );
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
    await sendMessage(
      ctx.botToken,
      chatId,
      error instanceof Error ? error.message : "无权查看该问卷。",
    );
    return;
  }

  const stats = await getSurveyStatistics(ctx.db, surveyId);
  const survey = await getSurveyById(ctx.db, surveyId);
  const optionStats = await getOptionStatistics(ctx.db, surveyId);
  const numericStats = await getNumericStatistics(ctx.db, surveyId);
  const responses = await listResponses(ctx.db, surveyId, 10);
  const lastCompleted = await ctx.db.prepare(
    "SELECT completed_at FROM survey_responses WHERE survey_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1",
  ).bind(surveyId).first<{ completed_at: string | null }>();

  const lines = [
    `📊 ${survey?.title ?? "问卷"}统计`,
    `内部编号：${surveyId}`,
    `开始：${stats.totalStarted}`,
    `完成：${stats.totalCompleted}`,
    `完成率：${stats.completionRate.toFixed(1)}%`,
    `最近答卷：${lastCompleted?.completed_at ? formatChinaDateTime(lastCompleted.completed_at) : "暂无"}`,
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

  const text = lines.join("\n");
  if (text.length > 4096) {
    await sendLongMessage(ctx.botToken, chatId, text, {
      inline_keyboard: [
        [
          {
            text: "📝 内容与发布",
            callback_data: `owner:content:${surveyId}`,
          },
          {
            text: "📁 答卷与报告",
            callback_data: `owner:reports:${surveyId}`,
          },
          {
            text: `🔐 访问设置${survey?.accessCode ? " · 已保护" : ""}`,
            callback_data: `owner:access_view:${surveyId}`,
          },
        ],
        [{ text: "⬅️ 返回我的问卷", callback_data: "home:my_surveys" }],
      ],
    });
    return;
  }
  const replyMarkup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: "📝 内容与发布", callback_data: `owner:content:${surveyId}` },
          { text: "📁 答卷与报告", callback_data: `owner:reports:${surveyId}` },
          { text: `🔐 访问设置${survey?.accessCode ? " · 已保护" : ""}`, callback_data: `owner:access_view:${surveyId}` },
        ],
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

async function showSurveyContentMenu(
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

  const publication = survey.status === "draft"
    ? { text: "🚀 发布前检查", callback_data: `owner:publish_ask:${surveyId}` }
    : survey.status === "published"
      ? { text: "⏹ 关闭问卷", callback_data: `owner:close:${surveyId}` }
      : { text: "🚀 重新发布", callback_data: `owner:publish_ask:${surveyId}` };

  await renderUiScreen(ctx, chatId, userId, { screen: "survey_content", text: [
      "📝 内容与发布",
      "",
      `“${survey.title}”当前为${survey.status === "draft" ? "草稿" : survey.status === "published" ? "已发布" : "已关闭"}状态。`,
      survey.status === "published"
        ? "用户提交答卷不会自动关闭问卷，需要时请手动关闭。"
        : "",
    ].filter(Boolean).join("\n"), replyMarkup: {
      inline_keyboard: [
        [{ text: "✏️ 编辑题目", callback_data: `owner:questions:${surveyId}` }],
        [publication, { text: "👀 预览填写", callback_data: `owner:preview:${surveyId}` }],
        [{ text: `🔁 重复填写：${survey.allowMultipleResponses ? "允许（不限次数）" : "禁止"}`, callback_data: `owner:repeat_toggle:${surveyId}` }],
        ...(survey.status === "published"
          ? [[{ text: "🔗 分享问卷链接", callback_data: `owner:share:${surveyId}` }]]
          : []),
        [{ text: "📋 复制为新问卷", callback_data: `owner:duplicate:${surveyId}` }],
        [{ text: "⬅️ 返回问卷概览", callback_data: `owner:survey:${surveyId}` }],
      ],
    }, state: { surveyId } });
}

async function showSurveyShareLink(
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
  if (survey.status !== "published") {
    throw new Error("请先发布问卷，发布后才能生成分享链接");
  }
  const url = await getSurveyShareUrl(ctx, surveyId);
  await renderUiScreen(ctx, chatId, userId, { screen: "survey_share", text: [
      `🔗 ${survey.title}`,
      "",
      "把下面链接发给对方。对方点击后会自动打开机器人并直接进入这份问卷。",
      survey.accessCode ? "该问卷已设置访问密码，接收者进入后仍需输入密码。" : "",
      "",
      url,
    ].filter(Boolean).join("\n"), replyMarkup: {
      inline_keyboard: [[{ text: "打开问卷", url }]],
    }, state: { surveyId } });
}

async function showSurveyReportsMenu(
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
  const poster = await getCompletionPosterSetting(ctx.db, surveyId);

  await renderUiScreen(ctx, chatId, userId, { screen: "survey_reports", text: `📁 答卷与报告\n\n选择“${survey.title}”的查看、报告或导出方式。`, replyMarkup: {
      inline_keyboard: [
        [{ text: "查看答卷", callback_data: `owner:responses:${surveyId}:0` }],
        [
          { text: "统计 PDF", callback_data: `owner:export_summary_pdf:${surveyId}` },
          { text: `完成海报 · ${poster.enabled ? "已开启" : "未开启"}`, callback_data: `owner:poster_menu:${surveyId}` },
        ],
        [
          { text: "CSV", callback_data: `owner:export:csv:${surveyId}` },
          { text: "Excel", callback_data: `owner:export:xlsx:${surveyId}` },
          { text: "ZIP", callback_data: `owner:export:zip:${surveyId}` },
          { text: "JSON", callback_data: `owner:export_json:${surveyId}` },
        ],
        [{ text: "⬅️ 返回问卷概览", callback_data: `owner:survey:${surveyId}` }],
      ],
    }, state: { surveyId } });
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
    clean: "简洁", cute: "可爱", editorial: "杂志感", bold: "强对比",
  };
  await renderUiScreen(ctx, chatId, userId, { screen: "poster_settings", text: [
    "完成海报",
    setting.enabled ? `已开启，当前风格：${labels[setting.style]}。` : "当前未开启。开启后答卷者完成时会收到一张 PNG 海报。",
    "问卷封面会优先显示；没有封面时自动尝试使用第一张题目图片。",
  ].join("\n"), replyMarkup: {
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
  }, state: { surveyId } });
}

async function showPublishCheck(
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
  const questions = await listQuestionsBySurvey(ctx.db, surveyId);
  const options = await listOptionsForQuestions(ctx.db, questions.map((question) => question.id));
  const issues: string[] = [];
  if (questions.length === 0) issues.push("没有题目");
  for (const question of questions) {
    if (!question.title.trim()) issues.push(`第 ${question.order + 1} 题没有标题`);
    if (["single", "multiple", "yes_no", "rating"].includes(question.type) && options.filter((option) => option.questionId === question.id).length < 2) {
      issues.push(`第 ${question.order + 1} 题选项不足两个`);
    }
  }
  const settings = [
    `题目：${questions.length} 道`,
    `访问密码：${survey.accessCode ? "已设置" : "未设置"}`,
    `重复填写：${survey.allowMultipleResponses ? `允许，最多 ${survey.maxResponsesPerUser || "不限"} 次` : "不允许"}`,
  ];
  await renderUiScreen(ctx, chatId, userId, { screen: "publish_check", text: [
    "发布前检查",
    "",
    ...settings,
    "",
    issues.length > 0 ? `发现问题：\n${issues.map((issue) => `- ${issue}`).join("\n")}` : "检查通过，可以发布。",
  ].join("\n"), replyMarkup: {
    inline_keyboard: issues.length > 0
      ? [[{ text: "编辑题目", callback_data: `owner:questions:${surveyId}` }], [{ text: "返回问卷", callback_data: `owner:survey:${surveyId}` }]]
      : [[{ text: "确认发布", callback_data: `owner:publish_confirm:${surveyId}` }], [{ text: "编辑题目", callback_data: `owner:questions:${surveyId}` }]],
  }, state: { surveyId } });
}

async function listSurveys(
  ctx: BotContext,
  chatId: number,
  userId?: number,
  page = 0,
  sort: "latest" | "popular" = "latest",
  messageId?: number,
): Promise<void> {
  const search = userId
    ? (await ctx.cache?.get(publicSurveySearchKey(userId)))?.trim() ?? ""
    : "";
  const escapedSearch = search.replace(/[\\%_]/g, "\\$&");
  const where = search ? "AND (s.title LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\')" : "";
  const countBindings = search ? [`%${escapedSearch}%`, `%${escapedSearch}%`] : [];
  const countRow = await ctx.db.prepare(
    `SELECT COUNT(*) AS count FROM surveys s WHERE s.status = 'published' ${where}`,
  ).bind(...countBindings).first<{ count: number }>();
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
      await sendMessage(ctx.botToken, chatId, text, { inline_keyboard: [[{ text: "⬅️ 返回首页", callback_data: "home:menu" }]] });
    }
    return;
  }
  const pageSize = 8;
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const safePage = Math.min(Math.max(0, page), lastPage);
  const orderBy = sort === "popular"
    ? "completed_count DESC, s.published_at DESC, s.id DESC"
    : "s.published_at DESC, s.id DESC";
  const bindings = search
    ? [`%${escapedSearch}%`, `%${escapedSearch}%`, pageSize, safePage * pageSize]
    : [pageSize, safePage * pageSize];
  const result = await ctx.db.prepare(
    `SELECT s.id, s.title, s.description, s.access_code,
            SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed_count
     FROM surveys s
     LEFT JOIN survey_responses r ON r.survey_id = s.id
     WHERE s.status = 'published' ${where}
     GROUP BY s.id
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
  ).bind(...bindings).all<{
    id: number;
    title: string;
    description: string | null;
    access_code: string | null;
    completed_count: number | null;
  }>();
  const surveys = result.results ?? [];
  const rows: InlineKeyboardMarkup["inline_keyboard"] = surveys.map((survey) => [
    {
      text: `${survey.access_code ? "🔐" : "📝"} ${compactSurveyTitle(survey.title, 32)}`,
      callback_data: `q:start:${survey.id}`,
    },
  ]);
  const navigation: InlineKeyboardMarkup["inline_keyboard"][number] = [];
  if (safePage > 0) navigation.push({ text: "⬅️ 上一页", callback_data: `public:list:${safePage - 1}:${sort}` });
  if (safePage < lastPage) navigation.push({ text: "下一页 ➡️", callback_data: `public:list:${safePage + 1}:${sort}` });
  if (navigation.length) rows.push(navigation);
  rows.push([
    { text: "🔎 搜索问卷", callback_data: "public:search" },
    { text: sort === "latest" ? "🔥 热门优先" : "🕒 最新优先", callback_data: `public:sort:${sort === "latest" ? "popular" : "latest"}` },
  ]);
  if (search) rows.push([{ text: "✖️ 清除搜索", callback_data: `public:clear:${sort}` }]);
  const descriptions = surveys.map((survey, index) => {
    const description = cleanSurveyDescription(survey.description);
    return [
      `${safePage * pageSize + index + 1}. ${compactSurveyTitle(survey.title, 48)}`,
      description ? `   ${description.slice(0, 56)}` : "",
      survey.access_code ? "   🔐 需要密码" : "",
    ].filter(Boolean).join("\n");
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
  const templates = (await listVisualTemplates(ctx.db, 100)).filter((template) =>
    template.type === "report" &&
    template.status === "published" &&
    template.currentVersion &&
    (template.surveyId === null || template.surveyId === response.surveyId),
  );
  const rows: InlineKeyboardMarkup["inline_keyboard"] = templates.map((template) => [{
    text: `📊 ${template.name}`,
    callback_data: `rv:generate:${response.id}:${template.id}`,
  }]);
  rows.push([{ text: "暂不生成", callback_data: `rv:skip:${response.id}` }]);
  await renderScreen({
    botToken: ctx.botToken,
    chatId,
    userId,
    ...(messageId === undefined ? {} : { messageId }),
    screen: "RESULT_REPORT_TEMPLATES",
    text: templates.length > 0
      ? "✅ 问卷已完成！\n\n请选择一个报告模板生成你的专属报告："
      : "✅ 问卷已完成！\n\n当前没有可用的报告模板。",
    replyMarkup: { inline_keyboard: rows },
  });
}

export async function handleTelegramMessage(
  ctx: BotContext,
  message: TelegramMessage,
): Promise<void> {
  const text = message.text?.trim();
  const userId = message.from?.id;
  const dbUser = userId ? await getUserByTelegramId(ctx.db, userId) : null;
  const dbUserId = dbUser?.id;
  const canCreateFromCache = async (): Promise<boolean> => {
    if (!dbUser) return false;
    try { return await canCreateSurvey(ctx.db, dbUser, ctx.adminIds); } catch { return isAdmin(dbUser.telegramUserId, ctx.adminIds); }
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
      clearIdentityCardInteractionState(ctx, userId),
      ctx.ui ? clearUiSession(ctx.ui, userId, message.chat.id).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    for (const result of resetResults) {
      if (result.status === "rejected") {
        console.warn("Start command interaction cleanup failed; continuing", result.reason);
      }
    }
    if (Number.isSafeInteger(surveyId) && surveyId > 0) {
      await startSurvey(ctx, message.chat.id, userId, surveyId);
      return;
    }
    const creator = await canCreateFromCache();
    const pausedResponse = dbUserId ? await getActiveResponseByUser(ctx.db, dbUserId) : null;
    await renderUiScreen(ctx, message.chat.id, userId, {
      screen: "home",
      text: creator
        ? "欢迎回来。已清理未完成操作；选择一个入口开始。\n\n🔑 需要问卷密码、软件授权或部署支持，请联系 @meiebhiebot。"
        : "欢迎使用问卷机器人。已清理未完成操作；请选择问卷开始填写。\n\n🔑 需要问卷密码、软件授权或部署支持，请联系 @meiebhiebot。",
      replyMarkup: buildHomeKeyboard(creator, Boolean(dbUser && isAdmin(userId, ctx.adminIds)), Boolean(pausedResponse)),
    });
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
      clearIdentityCardInteractionState(ctx, userId),
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
      replyMarkup: buildHomeKeyboard(
        creator,
        Boolean(dbUser && isAdmin(userId, ctx.adminIds)),
        Boolean(dbUserId && await getActiveResponseByUser(ctx.db, dbUserId)),
      ),
    });
    return;
  }

  if (text && ctx.cache) {
    const waitingForSearch = await ctx.cache.get(publicSurveySearchInputKey(userId));
    if (waitingForSearch === "1") {
    if (text === "/cancel") {
      await ctx.cache.delete(publicSurveySearchInputKey(userId));
        await renderUiScreen(ctx, message.chat.id, userId, {
          screen: "survey_list",
          text: "已取消搜索。使用下方按钮浏览问卷。",
          replyMarkup: buildHomeKeyboard(
            Boolean(dbUser && await canCreateSurvey(ctx.db, dbUser, ctx.adminIds)),
            Boolean(dbUser && isAdmin(userId, ctx.adminIds)),
          ),
        });
        return;
      }
      if (!text.startsWith("/")) {
        await ctx.cache.put(publicSurveySearchKey(userId), text.slice(0, 80), {
          expirationTtl: 24 * 60 * 60,
        });
        await ctx.cache.delete(publicSurveySearchInputKey(userId));
        await listSurveys(ctx, message.chat.id, userId);
        return;
      }
    }
  }

  if (text === "/surveys") {
    await listSurveys(ctx, message.chat.id, userId);
    return;
  }

  if (text === "/help") {
    const creator = Boolean(
      dbUser && await canCreateSurvey(ctx.db, dbUser, ctx.adminIds),
    );
    await renderUiScreen(ctx, message.chat.id, userId, {
      screen: "home",
      text:
      creator
        ? "快捷入口在下方。\n\n继续草稿发送 /continue；导入 JSON 发送 /import。\n\n🔑 需要问卷密码、软件授权或部署支持，请联系 @meiebhiebot。"
        : "从下方选择“浏览问卷”即可开始填写。\n\n🔑 需要问卷密码、软件授权或部署支持，请联系 @meiebhiebot。",
      replyMarkup: buildHomeKeyboard(
        creator,
        Boolean(dbUser && isAdmin(userId, ctx.adminIds)),
        Boolean(dbUserId && await getActiveResponseByUser(ctx.db, dbUserId)),
      ),
    });
    return;
  }

  if (dbUser && await handleIdentityCardMessage(ctx, message, dbUser.id)) {
    return;
  }

  if (dbUser && await handleImageGeneratorParticipantMessage(ctx, message, dbUser.id)) {
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
      await duplicateManagedSurvey(
        ctx,
        message.chat.id,
        userId,
        surveyId,
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

  if (
    text === "/passwords" ||
    text === "/set_survey_code" ||
    text === "/get_survey_code"
  ) {
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
    if (
      !Number.isInteger(surveyId) ||
      surveyId <= 0 ||
      !["csv", "xlsx", "zip"].includes(exportFormat)
    ) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "用法：/export <内部编号> [csv|xlsx|zip]",
      );
      return;
    }

    try {
      await sendSurveyExport(
        ctx,
        message.chat.id,
        userId,
        surveyId,
        exportFormat as SurveyExportFormat,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "导出失败。",
      );
    }
    return;
  }

  if (text?.startsWith("/export_json ")) {
    const surveyId = Number(text.slice("/export_json ".length));
    try {
      await sendSurveyJsonExport(
        ctx,
        message.chat.id,
        userId,
        surveyId,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "导出失败。",
      );
    }
    return;
  }

  if (text?.startsWith("/preview ")) {
    const surveyId = Number(text.slice("/preview ".length));
    try {
      await sendSurveyPreview(
        ctx,
        message.chat.id,
        userId,
        surveyId,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "预览失败。",
      );
    }
    return;
  }

  if (
    text === "/create" ||
    text === "/continue" ||
    text === "/import"
  ) {
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user || !(await canCreateSurvey(ctx.db, user, ctx.adminIds))) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "你没有创建或导入问卷的权限。",
      );
      return;
    }
  }

  const builderState = await getBuilderState(ctx.builder, userId);
  const activeResponse = dbUserId
    ? await getActiveResponseByUser(ctx.db, dbUserId)
    : null;
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

  if (
    activeResponse &&
    (text === "/create" || text === "/continue" || text === "/import")
  ) {
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      "你正在填写问卷，请先点击“退出问卷”，再创建、继续或导入问卷。",
    );
    return;
  }

  if (
    isBuilderCommand ||
    builderOwnsNextMessage(builderState) ||
    builderState?.step === "survey_access_code" ||
    builderState?.step === "set_survey_access_code"
  ) {
    if (await handleBuilderMessage(ctx, message)) {
      return;
    }
  }

  if (builderState?.step === "survey_access_code") {
    const survey = builderState.targetSurveyId
      ? await getSurveyById(ctx.db, builderState.targetSurveyId)
      : null;
    if (!survey?.accessCode) {
      await resumeBuilderAfterAuxiliary(ctx.builder, userId);
      await sendMessage(ctx.botToken, message.chat.id, "问卷访问密码已失效，请重新点击问卷。");
      return;
    }

    const submittedCode = text?.trim();
    if (!submittedCode) {
      await sendMessage(ctx.botToken, message.chat.id, "请输入问卷访问密码。");
      return;
    }

    if (!(await verifySurveyAccessCode(survey.accessCode, submittedCode))) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "密码错误，请重试；发送 /cancel 可退出密码输入。",
      );
      return;
    }

    const surveyId = builderState.targetSurveyId;
    if (!surveyId) {
      await resumeBuilderAfterAuxiliary(ctx.builder, userId);
      await sendMessage(ctx.botToken, message.chat.id, "问卷信息不存在，请重新点击问卷。");
      return;
    }
    await resumeBuilderAfterAuxiliary(ctx.builder, userId);
    await startSurvey(ctx, message.chat.id, userId, surveyId, true);
    return;
  }

  const response = activeResponse;

  if (!response) {
    if (await handleBuilderMessage(ctx, message)) {
      return;
    }
    await sendMessage(ctx.botToken, message.chat.id, "请使用 /surveys 选择一个问卷。");
    return;
  }

  const flow = await getSurveyFlow(ctx.db, response.surveyId);
  const fallbackQuestionId =
    response.currentQuestionId ?? getFirstQuestion(flow)?.id ?? null;
  if (!fallbackQuestionId) {
    await sendMessage(ctx.botToken, message.chat.id, "当前问卷没有可用题目。");
    return;
  }

  let currentQuestionId = fallbackQuestionId;
  try {
    const sessionState = await getSession(
      ctx.session,
      userId,
      response.surveyId,
    );
    currentQuestionId = sessionState.currentQuestionId ?? fallbackQuestionId;
  } catch {
    const sessionState = await initSession(ctx.session, {
      userId,
      surveyId: response.surveyId,
      responseId: response.id,
      currentQuestionId: fallbackQuestionId,
    });
    currentQuestionId = sessionState.currentQuestionId ?? fallbackQuestionId;
  }

  const question = getQuestionById(flow, currentQuestionId);

  if (!question) {
    await sendMessage(ctx.botToken, message.chat.id, "当前题目不存在。");
    return;
  }

  if (!isDirectAnswerQuestion(question)) {
    await renderQuestion(
      ctx,
      message.chat.id,
      response.id,
      question,
      flow.questions,
      userId,
      response.surveyId,
    );
    return;
  }

  if (acceptsMediaAnswer(question)) {
    if (!messageMatchesMediaQuestion(question, message)) {
      const expected =
        question.type === "image"
          ? "图片"
          : question.type === "video"
            ? "视频或动画"
            : question.type === "audio"
              ? "音频或语音"
              : "文件";
      await sendMessage(ctx.botToken, message.chat.id, `请发送${expected}。`);
      return;
    }
    const mediaAssetId = await registerMediaAsset(ctx, message, { scope: "response" });
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
      response.surveyId,
    );
    return;
  }

  if (text) {
    if (text.startsWith("/")) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "填写问卷时无法执行命令。请直接发送本题答案，或使用下方按钮：",
        {
          inline_keyboard: [
            [
              { text: "💾 暂存", callback_data: `q:pause:${response.surveyId}` },
              { text: "退出并放弃", callback_data: `q:exit:${response.surveyId}` },
            ],
          ],
        },
      );
      return;
    }
    if (question.type === "number") {
      const numberValue = Number(text);
      if (!Number.isFinite(numberValue)) {
        await sendMessage(ctx.botToken, message.chat.id, "请输入有效数字。");
        return;
      }
      await upsertNumberAnswer(ctx.db, {
        responseId: response.id,
        questionId: question.id,
        numberValue,
      });
    } else if (question.type === "date") {
      const dateValue = normalizeDateAnswer(text);
      if (!dateValue) {
        await sendMessage(
          ctx.botToken,
          message.chat.id,
          "日期格式不正确，请按 YYYY-MM-DD 输入，例如 2026-08-14。",
        );
        return;
      }
      await upsertDateAnswer(ctx.db, {
        responseId: response.id,
        questionId: question.id,
        dateValue,
      });
    } else if (question.type === "time") {
      const timeValue = normalizeTimeAnswer(text);
      if (!timeValue) {
        await sendMessage(
          ctx.botToken,
          message.chat.id,
          "时间格式不正确，请按 HH:MM 输入，例如 21:30。",
        );
        return;
      }
      await upsertTimeAnswer(ctx.db, {
        responseId: response.id,
        questionId: question.id,
        timeValue,
      });
    } else {
      await upsertTextAnswer(ctx.db, {
        responseId: response.id,
        questionId: question.id,
        textValue: text,
      });
    }
    await advanceQuestion(
      ctx,
      message.chat.id,
      response.id,
      question.id,
      flow.questions,
      userId,
      response.surveyId,
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

  if (await handleIdentityCardCallback(ctx, callback, dbUserId)) {
    return;
  }

  if (await handleImageGeneratorCallback(ctx, callback, dbUserId, false)) {
    return;
  }

  if (data === "home:menu") {
    await showHomeMenu(ctx, chatId, userId, dbUser, callback.message?.message_id);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "home:surveys") {
    await listSurveys(ctx, chatId, userId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "home:resume_survey") {
    const response = await getActiveResponseByUser(ctx.db, dbUserId);
    if (!response) {
      await answerCallbackQuery(ctx.botToken, callback.id, "没有可继续的问卷");
      return;
    }
    await startSurvey(ctx, chatId, userId, response.surveyId);
    await answerCallbackQuery(ctx.botToken, callback.id, "继续填写");
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
    await listSurveys(
      ctx,
      chatId,
      userId,
      page,
      sort,
      callback.message?.message_id,
    );
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
    await listSurveys(
      ctx,
      chatId,
      userId,
      0,
      sort,
      callback.message?.message_id,
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("public:clear:")) {
    const sort = data.endsWith(":popular") ? "popular" : "latest";
    await ctx.cache?.delete(publicSurveySearchKey(userId));
    await listSurveys(
      ctx,
      chatId,
      userId,
      0,
      sort,
      callback.message?.message_id,
    );
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
    await handleBuilderMessage(ctx, { message_id: callback.message?.message_id ?? 0, chat: { id: chatId }, from: callback.from, text: "/continue" });
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "home:import_json") {
    await handleBuilderMessage(ctx, { message_id: callback.message?.message_id ?? 0, chat: { id: chatId }, from: callback.from, text: "/import" });
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
              inline_keyboard: surveys.map((survey) => [{ text: compactSurveyTitle(survey.title), callback_data: `owner:duplicate:${survey.id}` }]),
            },
          }
        : {}),
    };
    await renderUiScreen(ctx, chatId, userId, screen);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data === "home:templates") {
    await renderUiScreen(ctx, chatId, userId, { screen: "templates", text: "问卷模板\n\n选择模板后会生成一份可随意修改的草稿：", replyMarkup: {
      inline_keyboard: listSurveyTemplates().map((template) => [{ text: `${template.title} · ${template.description}`, callback_data: `home:template:${template.id}` }]),
    }});
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("home:template:")) {
    const templateId = data.slice("home:template:".length) as SurveyTemplate["id"];
    try {
      if (!dbUser || !(await canCreateSurvey(ctx.db, dbUser, ctx.adminIds))) throw new Error("你没有创建问卷的权限");
      const survey = await createSurveyFromTemplate(ctx.db, dbUser.id, templateId);
      await renderUiScreen(ctx, chatId, userId, { screen: "template_created", text: `已创建“${survey.title}”模板草稿，共可继续编辑后再发布。`, replyMarkup: {
        inline_keyboard: [[{ text: "编辑题目", callback_data: `owner:questions:${survey.id}` }, { text: "查看发布检查", callback_data: `owner:publish_ask:${survey.id}` }]],
      }});
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
    const filter = filterRaw === "all" ? undefined : ["draft", "published", "closed"].includes(filterRaw ?? "") ? filterRaw as Survey["status"] : undefined;
    const page = Number(pageRaw ?? 0);
    if (!Number.isInteger(page) || page < 0) {
      await answerCallbackQuery(ctx.botToken, callback.id, "页码无效");
      return;
    }
    await listMySurveys(
      ctx,
      chatId,
      userId,
      filter,
      page,
      callback.message?.message_id,
    );
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
      await assertCanEditSurveyQuestions(
        ctx,
        dbUser,
        optionRow.survey_id,
      );
    } catch (error) {
      await answerCallbackQuery(
        ctx.botToken,
        callback.id,
        error instanceof Error ? error.message : "无权编辑该选项",
      );
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
      await assertCanEditSurveyQuestions(
        ctx,
        dbUser,
        optionRow.survey_id,
      );
      await initBuilder(ctx.builder, userId);
      await startEditOptionLabel(ctx.builder, userId, optionId);
      await sendMessage(ctx.botToken, chatId, "请输入新的选项名称：");
    } catch (error) {
      await answerCallbackQuery(
        ctx.botToken,
        callback.id,
        error instanceof Error ? error.message : "无权编辑该选项",
      );
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
      await assertCanEditSurveyQuestions(
        ctx,
        dbUser,
        question.surveyId,
      );
    } catch (error) {
      await answerCallbackQuery(
        ctx.botToken,
        callback.id,
        error instanceof Error ? error.message : "无权编辑该题目",
      );
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
        replyMarkup: { inline_keyboard: [[{ text: "返回主页", callback_data: "home:menu" }]] },
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
    if (
      !response ||
      response.userId !== dbUserId ||
      response.status !== "completed"
    ) {
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
          text: result.status === "processing"
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
              inline_keyboard: [[{ text: "🎨 重试生成", callback_data: `rv:generate:${response.id}${selectedTemplateId === undefined ? "" : `:${selectedTemplateId}`}` }]],
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
    const style = styles.includes(styleRaw as CompletionPosterStyle) ? styleRaw as CompletionPosterStyle : null;
    const surveyId = Number(surveyIdRaw);
    if (!style || !Number.isInteger(surveyId)) {
      await answerCallbackQuery(ctx.botToken, callback.id, "海报风格无效");
      return;
    }
    try {
      const user = await getUserByTelegramId(ctx.db, userId);
      if (!user) throw new Error("用户信息不存在");
      await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
      const setting = await getCompletionPosterSetting(ctx.db, surveyId);
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
    const style = styles.includes(styleRaw as CompletionPosterStyle) ? styleRaw as CompletionPosterStyle : null;
    try {
      const user = await getUserByTelegramId(ctx.db, userId);
      if (!user || !style) throw new Error("海报风格无效");
      await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
      if (!ctx.browser) throw new Error("当前部署未启用海报服务");
      const survey = await getSurveyById(ctx.db, surveyId);
      if (!survey) throw new Error("问卷不存在");
      await answerCallbackQuery(ctx.botToken, callback.id, "正在生成预览");
      const png = await renderCompletionPoster(ctx.browser, { surveyTitle: survey.title, completedAt: "预览效果", style });
      await sendPhoto(ctx.botToken, chatId, png, "完成海报预览");
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "预览失败");
    }
    return;
  }

  if (data.startsWith("owner:response_export:")) {
    const [
      ,
      ,
      format,
      surveyIdRaw,
      responseIdRaw,
      responseNumberRaw,
    ] = data.split(":");
    if (format !== "pdf" && format !== "png" && format !== "pdf_private" && format !== "png_private") {
      await answerCallbackQuery(ctx.botToken, callback.id, "导出格式无效");
      return;
    }
    await answerCallbackQuery(ctx.botToken, callback.id, format.startsWith("png") ? "正在生成手机版报告" : "正在生成高清 PDF");
    try {
      if (format.startsWith("png")) {
        await assertResponseAccess(ctx, userId, Number(surveyIdRaw));
        await ctx.exportQueue.send({
          kind: "response_report",
          chatId,
          userId,
          surveyId: Number(surveyIdRaw),
          responseId: Number(responseIdRaw),
          responseNumber: Number(responseNumberRaw),
          format: "png",
          anonymize: format.endsWith("_private"),
        });
        await sendMessage(ctx.botToken, chatId, "📱 手机版报告已加入后台生成队列，完成后会发送到当前会话。");
        return;
      }
      await sendResponseReportExport(
        ctx,
        chatId,
        userId,
        Number(surveyIdRaw),
        Number(responseIdRaw),
        Number(responseNumberRaw),
        format.startsWith("pdf") ? "pdf" : "png",
        format.endsWith("_private"),
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "答卷导出失败。",
      );
    }
    return;
  }

  if (data.startsWith("owner:response_report_generate:")) {
    const [, , surveyIdRaw, responseIdRaw, templateIdRaw] = data.split(":");
    const surveyId = Number(surveyIdRaw);
    const responseId = Number(responseIdRaw);
    const templateId = Number(templateIdRaw);
    try {
      await assertResponseAccess(ctx, userId, surveyId);
      const response = await getResponseById(ctx.db, responseId);
      if (!response || response.surveyId !== surveyId || response.status !== "completed") {
        throw new Error("找不到可生成报告的已完成答卷");
      }
      const result = await requestConfiguredResultVisual(ctx.db, ctx.exportQueue, {
        responseId,
        chatId,
        requestedBy: dbUserId,
        templateId,
        forceRegenerate: true,
      });
      if (!result) throw new Error("所选报告模板不可用");
      await answerCallbackQuery(ctx.botToken, callback.id, "已开始生成");
      await sendMessage(ctx.botToken, chatId, "🎨 正在为这份答卷生成分析报告，完成后会发送到当前会话。");
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无法生成分析报告");
    }
    return;
  }

  if (data.startsWith("owner:response_report:")) {
    const [, , surveyIdRaw, responseIdRaw] = data.split(":");
    try {
      await showManagedResponseReportTemplates(ctx, chatId, userId, Number(surveyIdRaw), Number(responseIdRaw));
      await answerCallbackQuery(ctx.botToken, callback.id);
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无法打开报告模板");
    }
    return;
  }

  if (data.startsWith("owner:responses:")) {
    const [, , surveyIdRaw, offsetRaw] = data.split(":");
    await answerCallbackQuery(ctx.botToken, callback.id, "正在读取答卷");
    try {
      await showSurveyResponses(
        ctx,
        chatId,
        userId,
        Number(surveyIdRaw),
        Number(offsetRaw ?? 0),
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "读取答卷失败。",
      );
    }
    return;
  }

  if (data.startsWith("owner:response:")) {
    const [
      ,
      ,
      surveyIdRaw,
      responseIdRaw,
      responseNumberRaw,
      returnOffsetRaw,
    ] = data.split(":");
    await answerCallbackQuery(ctx.botToken, callback.id, "正在读取答卷");
    try {
      await showResponseDetail(
        ctx,
        chatId,
        userId,
        Number(surveyIdRaw),
        Number(responseIdRaw),
        Number(responseNumberRaw),
        Number(returnOffsetRaw ?? 0),
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "读取答卷失败。",
      );
    }
    return;
  }

  if (data.startsWith("owner:survey:")) {
    const surveyId = Number(data.slice("owner:survey:".length));
    await showSurveyStats(
      ctx,
      chatId,
      userId,
      surveyId,
      callback.message?.message_id,
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("owner:content:")) {
    const surveyId = Number(data.slice("owner:content:".length));
    try {
      await showSurveyContentMenu(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "读取问卷设置失败。",
      );
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
      const updated = await updateSurveyResponsePolicy(
        ctx.db,
        surveyId,
        !survey.allowMultipleResponses,
        0,
      );
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
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "读取答卷与报告失败。",
      );
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
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "生成分享链接失败。",
      );
    }
    return;
  }

  if (data.startsWith("owner:duplicate:")) {
    const surveyId = Number(data.slice("owner:duplicate:".length));
    await answerCallbackQuery(ctx.botToken, callback.id, "正在复制");
    try {
      await duplicateManagedSurvey(
        ctx,
        chatId,
        userId,
        surveyId,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "复制失败。",
      );
    }
    return;
  }

  if (data.startsWith("owner:preview:")) {
    const surveyId = Number(data.slice("owner:preview:".length));
    await answerCallbackQuery(ctx.botToken, callback.id, "正在生成预览");
    try {
      await sendSurveyPreview(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "预览失败。",
      );
    }
    return;
  }

  if (data.startsWith("owner:export_json:")) {
    const surveyId = Number(data.slice("owner:export_json:".length));
    await answerCallbackQuery(ctx.botToken, callback.id, "正在导出 JSON");
    try {
      await sendSurveyJsonExport(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "导出失败。",
      );
    }
    return;
  }

  if (data.startsWith("owner:export:")) {
    const [, , formatRaw, surveyIdRaw] = data.split(":");
    const surveyId = Number(surveyIdRaw);
    if (
      formatRaw !== "csv" &&
      formatRaw !== "xlsx" &&
      formatRaw !== "zip"
    ) {
      await answerCallbackQuery(ctx.botToken, callback.id, "导出格式无效");
      return;
    }
    await answerCallbackQuery(ctx.botToken, callback.id, "正在创建导出任务");
    try {
      await sendSurveyExport(
        ctx,
        chatId,
        userId,
        surveyId,
        formatRaw,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "导出失败。",
      );
    }
    return;
  }

  if (data.startsWith("owner:export_summary_pdf:")) {
    const surveyId = Number(data.slice("owner:export_summary_pdf:".length));
    await answerCallbackQuery(ctx.botToken, callback.id, "正在生成统计 PDF");
    try {
      await sendSurveySummaryPdf(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "统计 PDF 导出失败。",
      );
    }
    return;
  }

  if (data === "owner:access_codes") {
    await answerCallbackQuery(ctx.botToken, callback.id);
    try {
      await showSurveyPasswordMenu(ctx, chatId, userId);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "读取密码列表失败。",
      );
    }
    return;
  }

  if (data.startsWith("owner:access_view:")) {
    const surveyId = Number(data.slice("owner:access_view:".length));
    await answerCallbackQuery(ctx.botToken, callback.id);
    try {
      await showSurveyPasswordDetails(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "读取密码状态失败。",
      );
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

  if (
    data.startsWith("owner:access_set:") ||
    data.startsWith("owner:access_code:")
  ) {
    const prefix = data.startsWith("owner:access_set:")
      ? "owner:access_set:"
      : "owner:access_code:";
    const surveyId = Number(data.slice(prefix.length));
    await answerCallbackQuery(ctx.botToken, callback.id);
    try {
      await beginSurveyPasswordInput(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "无权设置密码。",
      );
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
      await answerCallbackQuery(
        ctx.botToken,
        callback.id,
        error instanceof Error ? error.message : "无权移除密码",
      );
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
      await answerCallbackQuery(
        ctx.botToken,
        callback.id,
        error instanceof Error ? error.message : "移除密码失败",
      );
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
      await assertSurveyCanPublish(ctx.db, surveyId);
      await updateSurveyStatus(ctx.db, surveyId, "published");
      await showSurveyStats(ctx, chatId, userId, surveyId);
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
      await showSurveyStats(ctx, chatId, userId, surveyId);
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
    await listSurveys(ctx, chatId, userId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("q:start:")) {
    const surveyId = Number(data.slice("q:start:".length));
    await answerCallbackQuery(ctx.botToken, callback.id);
    try {
      await startSurvey(ctx, chatId, userId, surveyId);
    } catch (error) {
      console.error("startSurvey failed", error);
      await sendMessage(
        ctx.botToken,
        chatId,
        `开始问卷失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    }
    return;
  }

  if (data.startsWith("q:skip:")) {
    const questionId = Number(data.slice("q:skip:".length));
    const response = await ctx.db
      .prepare(
        "SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1",
      )
      .bind(dbUserId)
      .first<{
        id: number;
        survey_id: number;
        current_question_id: number | null;
      }>();

    if (!response || response.current_question_id !== questionId) {
      await refreshStaleQuestionCallback(ctx, chatId, userId, callback.id, response);
      return;
    }

    const flow = await getSurveyFlow(ctx.db, response.survey_id);
    const question = getQuestionById(flow, questionId);
    if (!question || question.required) {
      await answerCallbackQuery(ctx.botToken, callback.id, "该题不能跳过");
      return;
    }

    await deleteAnswer(ctx.db, response.id, questionId);
    await clearSessionOptions(ctx.session, userId, response.survey_id);
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

  if (data.startsWith("q:single:")) {
    const [, , questionIdRaw, optionIdRaw] = data.split(":");
    const questionId = Number(questionIdRaw);
    const optionId = Number(optionIdRaw);
    const response = await ctx.db
      .prepare("SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1")
      .bind(dbUserId)
      .first<{ id: number; survey_id: number; current_question_id: number | null }>();

    if (!response || response.current_question_id !== questionId) {
      await refreshStaleQuestionCallback(ctx, chatId, userId, callback.id, response);
      return;
    }

    const flow = await getSurveyFlow(ctx.db, response.survey_id);
    const question = getQuestionById(flow, questionId);
    const selectedOption = question?.options.find(
      (option) => option.id === optionId,
    );
    if (!question || !selectedOption) {
      await answerCallbackQuery(ctx.botToken, callback.id, "选项不存在");
      return;
    }

    const ratingValue =
      question.type === "rating"
        ? Number(selectedOption.value || selectedOption.label)
        : null;
    await upsertOptionAnswer(ctx.db, {
      responseId: response.id,
      questionId,
      selectedOptionIds: [optionId],
      booleanValue:
        question.type === "yes_no"
          ? question.options[0]?.id === optionId
          : null,
      ratingValue:
        ratingValue !== null && Number.isFinite(ratingValue)
          ? ratingValue
          : null,
    });

    await advanceQuestion(
      ctx,
      chatId,
      response.id,
      questionId,
      flow.questions,
      userId,
      response.survey_id,
      optionId,
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
      .bind(dbUserId)
      .first<{ id: number; survey_id: number; current_question_id: number | null }>();

    if (!response || response.current_question_id !== questionId) {
      await refreshStaleQuestionCallback(ctx, chatId, userId, callback.id, response);
      return;
    }

    const flow = await getSurveyFlow(ctx.db, response.survey_id);
    const question = getQuestionById(flow, questionId);
    if (
      question?.type !== "multiple" ||
      !question.options.some((option) => option.id === optionId)
    ) {
      await answerCallbackQuery(ctx.botToken, callback.id, "选项不存在");
      return;
    }

    const sessionState = await toggleSessionOption(
      ctx.session,
      userId,
      response.survey_id,
      optionId,
    );
    const selected = sessionState.selectedOptionIds;

    const messageId = callback.message?.message_id;
    if (messageId) {
      await editMessageReplyMarkup(
        ctx.botToken,
        chatId,
        messageId,
        buildMultipleChoiceKeyboard(
          question,
          selected,
          flow.questions.findIndex((item) => item.id === question.id),
        ),
      );
    }

    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("q:multi:confirm:")) {
    const questionId = Number(data.slice("q:multi:confirm:".length));
    const response = await ctx.db
      .prepare("SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1")
      .bind(dbUserId)
      .first<{ id: number; survey_id: number; current_question_id: number | null }>();

    if (!response || response.current_question_id !== questionId) {
      await refreshStaleQuestionCallback(ctx, chatId, userId, callback.id, response);
      return;
    }

    const selected = await getSessionSelectedOptions(
      ctx.session,
      userId,
      response.survey_id,
    );
    const flow = await getSurveyFlow(ctx.db, response.survey_id);
    const question = getQuestionById(flow, questionId);
    if (!question || (selected.length === 0 && question.required)) {
      await answerCallbackQuery(ctx.botToken, callback.id, "请至少选择一个选项");
      return;
    }
    if (selected.length === 0) {
      await deleteAnswer(ctx.db, response.id, questionId);
    } else {
      await upsertOptionAnswer(ctx.db, {
        responseId: response.id,
        questionId,
        selectedOptionIds: selected,
      });
    }
    await clearSessionOptions(ctx.session, userId, response.survey_id);

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

  if (data === "q:matrix:label") {
    await answerCallbackQuery(ctx.botToken, callback.id, "请先选择要填写的行");
    return;
  }

  if (data.startsWith("q:matrix:row:")) {
    const [, , , questionIdRaw, rowIdRaw] = data.split(":");
    const questionId = Number(questionIdRaw);
    const rowId = Number(rowIdRaw);
    const response = await ctx.db.prepare("SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1").bind(dbUserId).first<{ id: number; survey_id: number; current_question_id: number | null }>();
    if (!response || response.current_question_id !== questionId) {
      await refreshStaleQuestionCallback(ctx, chatId, userId, callback.id, response);
      return;
    }
    const flow = await getSurveyFlow(ctx.db, response.survey_id);
    const question = getQuestionById(flow, questionId);
    const row = question?.options.find((item) => item.id === rowId);
    if (!question || question.type !== "matrix" || !row || matrixColumns(question).length === 0) {
      await answerCallbackQuery(ctx.botToken, callback.id, "矩阵行无效");
      return;
    }
    const selections = await getSessionMatrixSelections(ctx.session, userId, response.survey_id);
    const index = flow.questions.findIndex((item) => item.id === question.id);
    await sendMessage(
      ctx.botToken,
      chatId,
      `矩阵第 ${question.options.findIndex((item) => item.id === rowId) + 1} 行：${row.label}\n\n请选择一个选项：`,
      buildMatrixColumnKeyboard(question, rowId, index, selections[String(rowId)]),
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("q:matrix:back:")) {
    const questionId = Number(data.slice("q:matrix:back:".length));
    const response = await ctx.db.prepare("SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1").bind(dbUserId).first<{ id: number; survey_id: number; current_question_id: number | null }>();
    if (!response || response.current_question_id !== questionId) {
      await refreshStaleQuestionCallback(ctx, chatId, userId, callback.id, response);
      return;
    }
    const flow = await getSurveyFlow(ctx.db, response.survey_id);
    const question = getQuestionById(flow, questionId);
    if (!question || question.type !== "matrix") {
      await answerCallbackQuery(ctx.botToken, callback.id, "矩阵题不存在");
      return;
    }
    await renderQuestion(ctx, chatId, response.id, question, flow.questions, userId, response.survey_id);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("q:matrix:select:")) {
    const [, , , questionIdRaw, rowIdRaw, columnIndexRaw] = data.split(":");
    const questionId = Number(questionIdRaw);
    const rowId = Number(rowIdRaw);
    const columnIndex = Number(columnIndexRaw);
    const response = await ctx.db.prepare("SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1").bind(dbUserId).first<{ id: number; survey_id: number; current_question_id: number | null }>();
    if (!response || response.current_question_id !== questionId) {
      await refreshStaleQuestionCallback(ctx, chatId, userId, callback.id, response);
      return;
    }
    const flow = await getSurveyFlow(ctx.db, response.survey_id);
    const question = getQuestionById(flow, questionId);
    if (!question || question.type !== "matrix" || !question.options.some((row) => row.id === rowId) || columnIndex < 0 || columnIndex >= matrixColumns(question).length) {
      await answerCallbackQuery(ctx.botToken, callback.id, "矩阵选项无效");
      return;
    }
    await setSessionMatrixSelection(ctx.session, userId, response.survey_id, rowId, columnIndex);
    const selectedColumn = matrixColumns(question)[columnIndex] ?? "该选项";
    await answerCallbackQuery(ctx.botToken, callback.id, `已选择：${selectedColumn}`);
    await renderQuestion(ctx, chatId, response.id, question, flow.questions, userId, response.survey_id);
    return;
  }

  if (data.startsWith("q:matrix:confirm:")) {
    const questionId = Number(data.slice("q:matrix:confirm:".length));
    const response = await ctx.db.prepare("SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1").bind(dbUserId).first<{ id: number; survey_id: number; current_question_id: number | null }>();
    if (!response || response.current_question_id !== questionId) {
      await refreshStaleQuestionCallback(ctx, chatId, userId, callback.id, response);
      return;
    }
    const flow = await getSurveyFlow(ctx.db, response.survey_id);
    const question = getQuestionById(flow, questionId);
    const selections = await getSessionMatrixSelections(ctx.session, userId, response.survey_id);
    if (!question || question.type !== "matrix") {
      await answerCallbackQuery(ctx.botToken, callback.id, "矩阵题不存在");
      return;
    }
    if (question.required && question.options.some((row) => selections[String(row.id)] === undefined)) {
      await answerCallbackQuery(ctx.botToken, callback.id, "请完成每一行的选择");
      return;
    }
    if (Object.keys(selections).length === 0) await deleteAnswer(ctx.db, response.id, questionId);
    else await upsertJsonAnswer(ctx.db, { responseId: response.id, questionId, jsonValue: JSON.stringify({ kind: "matrix", selections }) });
    await clearSessionMatrixSelections(ctx.session, userId, response.survey_id);
    await advanceQuestion(ctx, chatId, response.id, questionId, flow.questions, userId, response.survey_id);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("q:prev:")) {
    const questionId = Number(data.slice("q:prev:".length));
    const response = await ctx.db
      .prepare("SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1")
      .bind(dbUserId)
      .first<{ id: number; survey_id: number; current_question_id: number | null }>();

    if (!response || response.current_question_id !== questionId) {
      await refreshStaleQuestionCallback(ctx, chatId, userId, callback.id, response);
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

  if (data.startsWith("q:submit:")) {
    const surveyId = Number(data.slice("q:submit:".length));
    const response = await ctx.db.prepare(
      "SELECT id, survey_id FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1",
    ).bind(dbUserId).first<{ id: number; survey_id: number }>();
    if (!response || response.survey_id !== surveyId) {
      await answerCallbackQuery(ctx.botToken, callback.id, "当前没有可提交的问卷");
      return;
    }
    const flow = await getSurveyFlow(ctx.db, surveyId);
    const detail = await getResponseDetail(ctx.db, response.id);
    const answersByQuestion = new Map(
      (detail?.answers ?? []).map((answer) => [answer.questionId, answer]),
    );
    const missing = findMissingRequiredQuestion(
      flow.questions,
      answersByQuestion,
    );
    if (missing) {
      const missingIndex = flow.questions.findIndex(
        (item) => item.id === missing.id,
      );
      await answerCallbackQuery(
        ctx.botToken,
        callback.id,
        `第 ${missingIndex + 1} 题为必答题，请先完成`,
      );
      await updateResponseCurrentQuestion(ctx.db, response.id, missing.id);
      await setSessionCurrentQuestion(ctx.session, userId, surveyId, missing.id);
      await sendMessage(
        ctx.botToken,
        chatId,
        `第 ${missingIndex + 1} 题“${missing.title}”是必答题，还没有作答。已为你定位到该题：`,
      );
      await renderQuestion(
        ctx,
        chatId,
        response.id,
        missing,
        flow.questions,
        userId,
        surveyId,
      );
      return;
    }
    await completeResponse(ctx.db, response.id);
    await completeSession(ctx.session, userId, surveyId);
    if (dbUserId) {
      try {
        await ensureReportStyleTemplates(ctx, dbUserId);
      } catch (error) {
        // Completing a survey must never fail because a default template could
        // not be provisioned; the report option will be unavailable until an
        // administrator fixes template storage.
        console.warn("Report style provisioning failed", error);
      }
    }
    const hasPublishedReportTemplate = (await listVisualTemplates(ctx.db, 100)).some((template) =>
      template.type === "report" && template.status === "published" && template.currentVersion &&
      (template.surveyId === null || template.surveyId === surveyId),
    );
    if (hasPublishedReportTemplate) {
      await sendMessage(ctx.botToken, chatId, "✅ 问卷已完成！\n\n你的回答已经保存。是否生成专属结果报告？", {
        inline_keyboard: [
          [{ text: "🎨 选择报告模板", callback_data: `rv:templates:${response.id}` }],
          [{ text: "暂不生成", callback_data: `rv:skip:${response.id}` }],
        ],
      });
    } else {
      await sendMessage(ctx.botToken, chatId, "你已完成问卷，感谢参与。");
    }
    try {
      await sendCompletionPoster(ctx, chatId, surveyId);
    } catch (error) {
      console.warn("Completion poster generation failed", error);
    }
    await answerCallbackQuery(ctx.botToken, callback.id, "已提交");
    return;
  }

  if (data.startsWith("q:pause:")) {
    const surveyId = Number(data.slice("q:pause:".length));
    const response = await ctx.db
      .prepare("SELECT id, survey_id FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1")
      .bind(dbUserId)
      .first<{ id: number; survey_id: number }>();
    if (!response || response.survey_id !== surveyId) {
      await answerCallbackQuery(ctx.botToken, callback.id, "当前没有可暂存的问卷");
      return;
    }
    await completeSession(ctx.session, userId, surveyId);
    await sendMessage(ctx.botToken, chatId, "💾 已暂存。下次发送 /start 后点“继续填写”，即可从当前题目继续。", {
      inline_keyboard: [[{ text: "返回首页", callback_data: "home:surveys" }]],
    });
    await answerCallbackQuery(ctx.botToken, callback.id, "已暂存");
    return;
  }

  if (data === "q:exit" || data.startsWith("q:exit:")) {
    const surveyId = data.startsWith("q:exit:")
      ? Number(data.slice("q:exit:".length))
      : null;
    const response = await ctx.db
      .prepare("SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1")
      .bind(dbUserId)
      .first<{ id: number; survey_id: number }>();

    if (response && (surveyId === null || response.survey_id === surveyId)) {
      await cancelResponse(ctx.db, response.id);
      await completeSession(ctx.session, userId, response.survey_id);
      await sendMessage(ctx.botToken, chatId, "已退出当前问卷。");
    } else if (response) {
      await answerCallbackQuery(ctx.botToken, callback.id, "该问卷按钮已失效");
      return;
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
          [
            { text: "取消", callback_data: "builder:cancel" },
          ],
        ],
      });
    } catch (error) {
      await answerCallbackQuery(
        ctx.botToken,
        callback.id,
        error instanceof Error ? error.message : "无法新增题目",
      );
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
      await assertCanEditSurveyQuestions(
        ctx,
        dbUser,
        question.surveyId,
      );
      await initBuilder(ctx.builder, userId);
      await startAddQuestionOption(ctx.builder, userId, question.id);
      await sendMessage(
        ctx.botToken,
        chatId,
        "请输入新选项，每行一个。\n也可以发送带说明文字的图片、音频、视频或文件，直接创建带附件的选项。",
      );
    } catch (error) {
      await answerCallbackQuery(
        ctx.botToken,
        callback.id,
        error instanceof Error ? error.message : "无法新增选项",
      );
      return;
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:option_delete_ask:")) {
    const optionId = Number(
      data.slice("qedit:option_delete_ask:".length),
    );
    const option = await getQuestionOptionById(ctx.db, optionId);
    const question = option
      ? await getQuestionEntityById(ctx.db, option.questionId)
      : null;
    if (!option || !question || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "选项不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(
        ctx,
        dbUser,
        question.surveyId,
      );
      await sendMessage(
        ctx.botToken,
        chatId,
        `确认删除选项“${option.label}”？`,
        {
          inline_keyboard: [
            [
              {
                text: "确认删除",
                callback_data:
                  `qedit:option_delete_confirm:${option.id}`,
              },
              {
                text: "取消",
                callback_data: `qedit:view:${question.id}`,
              },
            ],
          ],
        },
      );
    } catch (error) {
      await answerCallbackQuery(
        ctx.botToken,
        callback.id,
        error instanceof Error ? error.message : "无法删除选项",
      );
      return;
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:option_delete_confirm:")) {
    const optionId = Number(
      data.slice("qedit:option_delete_confirm:".length),
    );
    const option = await getQuestionOptionById(ctx.db, optionId);
    const question = option
      ? await getQuestionEntityById(ctx.db, option.questionId)
      : null;
    if (!option || !question || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "选项不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(
        ctx,
        dbUser,
        question.surveyId,
      );
      const options = await listOptionsForQuestions(ctx.db, [question.id]);
      if (
        question.type !== "single" &&
        question.type !== "multiple"
      ) {
        throw new Error("该题型使用固定选项，不能删除");
      }
      if (
        options.length <= 2
      ) {
        throw new Error("选择题至少需要两个选项，不能继续删除");
      }
      await deleteQuestionOption(ctx.db, option.id);
      await showQuestionEditor(
        ctx,
        chatId,
        userId,
        question.id,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "删除选项失败。",
      );
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (
    data.startsWith("qedit:option_up:") ||
    data.startsWith("qedit:option_down:")
  ) {
    const movingUp = data.startsWith("qedit:option_up:");
    const prefix = movingUp
      ? "qedit:option_up:"
      : "qedit:option_down:";
    const optionId = Number(data.slice(prefix.length));
    const option = await getQuestionOptionById(ctx.db, optionId);
    const question = option
      ? await getQuestionEntityById(ctx.db, option.questionId)
      : null;
    if (!option || !question || !dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "选项不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(
        ctx,
        dbUser,
        question.surveyId,
      );
      if (
        question.type !== "single" &&
        question.type !== "multiple"
      ) {
        throw new Error("该题型使用固定选项，不能调整顺序");
      }
      const options = await listOptionsForQuestions(ctx.db, [question.id]);
      const index = options.findIndex((item) => item.id === option.id);
      const adjacent = options[index + (movingUp ? -1 : 1)];
      if (adjacent) {
        await swapQuestionOptionOrder(ctx.db, option.id, adjacent.id);
      }
      await showQuestionEditor(
        ctx,
        chatId,
        userId,
        question.id,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "调整选项顺序失败。",
      );
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (
    data.startsWith("qedit:qmedia_delete:") ||
    data.startsWith("qedit:omedia_delete:")
  ) {
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
    if (
      !relation ||
      relation.question_id !== questionId ||
      !dbUser
    ) {
      await answerCallbackQuery(ctx.botToken, callback.id, "附件不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(
        ctx,
        dbUser,
        relation.survey_id,
      );
      const confirmAction = isQuestionMedia
        ? "qedit:qmedia_confirm"
        : "qedit:omedia_confirm";
      await sendMessage(
        ctx.botToken,
        chatId,
        "确认移除这个附件？原文件不会从 Telegram 删除。",
        {
          inline_keyboard: [
            [
              {
                text: "确认移除",
                callback_data:
                  `${confirmAction}:${relationId}:${questionId}`,
              },
              {
                text: "取消",
                callback_data: `qedit:view:${questionId}`,
              },
            ],
          ],
        },
      );
    } catch (error) {
      await answerCallbackQuery(
        ctx.botToken,
        callback.id,
        error instanceof Error ? error.message : "无法移除附件",
      );
      return;
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (
    data.startsWith("qedit:qmedia_confirm:") ||
    data.startsWith("qedit:omedia_confirm:")
  ) {
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
    if (
      !relation ||
      relation.question_id !== questionId ||
      !dbUser
    ) {
      await answerCallbackQuery(ctx.botToken, callback.id, "附件不存在");
      return;
    }
    try {
      await assertCanEditSurveyQuestions(
        ctx,
        dbUser,
        relation.survey_id,
      );
      if (isQuestionMedia) {
        await deleteQuestionMedia(ctx.db, relationId);
      } else {
        await deleteOptionMedia(ctx.db, relationId);
      }
      await showQuestionEditor(ctx, chatId, userId, questionId);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "移除附件失败。",
      );
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
      await assertCanEditSurveyQuestions(
        ctx,
        dbUser,
        question.surveyId,
      );
      await initBuilder(ctx.builder, userId);
      await startEditQuestionTitle(ctx.builder, userId, questionId);
      await sendMessage(ctx.botToken, chatId, "请输入新的题目内容：");
    } catch (error) {
      await answerCallbackQuery(
        ctx.botToken,
        callback.id,
        error instanceof Error ? error.message : "无权编辑该题目",
      );
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
        await assertCanEditSurveyQuestions(
          ctx,
          dbUser,
          question.surveyId,
        );
      } catch (error) {
        await answerCallbackQuery(
          ctx.botToken,
          callback.id,
          error instanceof Error ? error.message : "无权编辑该题目",
        );
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
        inline_keyboard: options.map((option) => [{ text: option.label, callback_data: `qedit:skip_option:${questionId}:${option.id}` }]).concat([[{ text: "取消", callback_data: `qedit:view:${questionId}` }]]),
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
      const targets = (await listQuestionsBySurvey(ctx.db, question.surveyId)).filter((item) => item.order > question.order);
      await sendMessage(ctx.botToken, chatId, "选择要跳转到的后续题目：", {
        inline_keyboard: targets.map((target) => [{ text: `第 ${target.order + 1} 题 · ${compactSurveyTitle(target.title, 35)}`, callback_data: `qedit:skip_target:${questionId}:${optionId}:${target.id}` }]).concat([[{ text: "取消", callback_data: `qedit:view:${questionId}` }]]),
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
      getQuestionEntityById(ctx.db, questionId), getQuestionOptionById(ctx.db, optionId), getQuestionEntityById(ctx.db, targetId),
    ]);
    if (!question || !option || !target || option.questionId !== question.id || target.surveyId !== question.surveyId || target.order <= question.order || !dbUser) {
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
        await assertCanEditSurveyQuestions(
          ctx,
          dbUser,
          question.surveyId,
        );
      } catch (error) {
        await answerCallbackQuery(
          ctx.botToken,
          callback.id,
          error instanceof Error ? error.message : "无权编辑该题目",
        );
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
        await assertCanEditSurveyQuestions(
          ctx,
          dbUser,
          question.surveyId,
        );
      } catch (error) {
        await answerCallbackQuery(
          ctx.botToken,
          callback.id,
          error instanceof Error ? error.message : "无权编辑该题目",
        );
        return;
      }
      await sendMessage(
        ctx.botToken,
        chatId,
        `确认删除题目“${question.title}”？此操作不可撤销。`,
        {
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
        },
      );
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
      await assertCanEditSurveyQuestions(
        ctx,
        dbUser,
        question.surveyId,
      );
      await deleteQuestion(ctx.db, questionId);
      await showQuestionList(ctx, chatId, userId, question.surveyId);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "删除题目失败。",
      );
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return;
  }

  if (data.startsWith("qedit:up:")) {
    const questionId = Number(data.slice("qedit:up:".length));
    const question = await getQuestionEntityById(ctx.db, questionId);
    if (question && dbUser) {
      try {
        await assertCanEditSurveyQuestions(
          ctx,
          dbUser,
          question.surveyId,
        );
      } catch (error) {
        await answerCallbackQuery(
          ctx.botToken,
          callback.id,
          error instanceof Error ? error.message : "无权编辑该题目",
        );
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
        await assertCanEditSurveyQuestions(
          ctx,
          dbUser,
          question.surveyId,
        );
      } catch (error) {
        await answerCallbackQuery(
          ctx.botToken,
          callback.id,
          error instanceof Error ? error.message : "无权编辑该题目",
        );
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
