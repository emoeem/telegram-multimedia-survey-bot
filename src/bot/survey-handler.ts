import {
  cancelResponse,
  completeResponse,
  createResponse,
  deleteAnswer,
  getActiveResponseBySurveyAndUser,
  getActiveResponseByUser,
  getResponseBySurveyAndHash,
  restartResponse,
  updateResponseCurrentQuestion,
  upsertDateAnswer,
  upsertMediaAnswer,
  upsertNumberAnswer,
  upsertOptionAnswer,
  upsertTextAnswer,
  upsertTimeAnswer,
} from "../db/repositories/response.repository";
import { getSurveyById, setSurveyAccessCode, updateSurveyStatus } from "../db/repositories/survey.repository";
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
} from "../db/repositories/question.repository";
import { registerMediaAsset } from "../services/media.service";
import { getUserByTelegramId } from "../db/repositories/user.repository";
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
import { buildCsv, buildExportZip, buildXlsx, getExportRows } from "../services/export.service";
import {
  renderResponseReport,
  type ResponseReport,
} from "../services/response-report.service";
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
import { getFirstQuestion, getNextQuestion, getPreviousQuestion, getQuestionById, type SurveyQuestionView } from "../survey/engine";
import { answerCallbackQuery, downloadTelegramFile, editMessageReplyMarkup, sendAnimation, sendAudio, sendDocument, sendDocumentByFileId, sendLongMessage, sendMessage, sendPhoto, sendSticker, sendVideo, sendVoice, type InlineKeyboardMarkup } from "./telegram";
import type { BotContext, TelegramCallbackQuery, TelegramMessage } from "./types";
import { handleBuilderCallback, handleBuilderMessage } from "./builder-handler";
import {
  getBuilderState,
  initBuilder,
  resumeBuilderAfterAuxiliary,
  startAddQuestionOption,
  startEditOptionLabel,
  startEditQuestionTitle,
  startOptionMedia,
  startQuestionMedia,
  startSetSurveyAccessCode,
  startSurveyAccessCode,
} from "../services/survey-builder.service";
import { handleAdminCallback, handleAdminMessage } from "./admin-handler";
import { hashSurveyAccessCode, verifySurveyAccessCode } from "../core/security";
import type { MediaAsset, Survey } from "../db/schema";
import { showQuestionEditor, showQuestionList } from "./question-editor";

function buildSingleChoiceKeyboard(
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
    ...question.options.map((option) => [
      {
        text: option.label,
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
      text: "退出问卷",
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

function buildMultipleChoiceKeyboard(
  question: SurveyQuestionView,
  selectedOptionIds: number[],
  currentIndex: number,
): InlineKeyboardMarkup {
  const selected = new Set(selectedOptionIds);
  const optionRows = question.options.map((option) => [
    {
      text: `${selected.has(option.id) ? "✅" : "⬜"} ${option.label}`,
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
      text: "退出问卷",
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
      text: "退出问卷",
      callback_data: `q:exit:${question.surveyId}`,
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

  if (usesSingleChoiceKeyboard(question)) {
    if (question.type === "rating") {
      parts.push("请选择一个分数");
    } else {
      parts.push("请选择一个选项");
    }
  } else if (question.type === "multiple") {
    parts.push("可选择多个选项，完成后点击“完成选择”");
  } else if (
    question.type === "image" ||
    question.type === "video" ||
    question.type === "audio" ||
    question.type === "file"
  ) {
    parts.push("请直接发送对应的媒体文件");
  } else if (question.type === "number") {
    parts.push("请输入一个数字");
  } else if (question.type === "date") {
    parts.push("请输入日期，格式：YYYY-MM-DD");
  } else if (question.type === "time") {
    parts.push("请输入时间，格式：HH:MM");
  } else {
    parts.push("请直接发送你的回答");
  }

  return parts.join("\n\n");
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

interface QuestionMediaItem {
  asset: MediaAsset;
  label: string | null;
}

async function getQuestionMediaItems(
  ctx: BotContext,
  question: SurveyQuestionView,
): Promise<QuestionMediaItem[]> {
  const items: QuestionMediaItem[] = [];
  const questionMedia = await getQuestionMediaByQuestionId(ctx.db, question.id);
  for (const relation of questionMedia) {
    const asset = await getMediaAssetById(ctx.db, relation.mediaAssetId);
    if (asset?.telegramFileId) {
      items.push({ asset, label: null });
    }
  }

  for (let index = 0; index < question.options.length; index += 1) {
    const option = question.options[index];
    if (!option) continue;
    const optionMedia = await getOptionMediaByOptionId(ctx.db, option.id);
    for (const relation of optionMedia) {
      const asset = await getMediaAssetById(ctx.db, relation.mediaAssetId);
      if (asset?.telegramFileId) {
        items.push({
          asset,
          label: `选项 ${index + 1}：${option.label}`,
        });
      }
    }
  }

  return items;
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
  const prompt = formatQuestionText(question, index, total);

  let replyMarkup: InlineKeyboardMarkup;

  if (usesSingleChoiceKeyboard(question)) {
    replyMarkup = buildSingleChoiceKeyboard(question, index);
  } else if (question.type === "multiple") {
    const selected = await getSessionSelectedOptions(ctx.session, userId, surveyId);
    replyMarkup = buildMultipleChoiceKeyboard(question, selected, index);
  } else {
    replyMarkup = buildNavigationKeyboard(question, index);
  }

  const mediaItems = await getQuestionMediaItems(ctx, question);
  if (mediaItems.length === 0) {
    await sendMessage(ctx.botToken, chatId, prompt, replyMarkup);
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
      await sendMessage(ctx.botToken, chatId, prompt);
      promptSent = true;
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
  return !usesSingleChoiceKeyboard(question) && question.type !== "multiple";
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
          {
            text: survey.accessCode ? "🔒 修改密码" : "🔓 设置密码",
            callback_data: `owner:access_code:${survey.id}`,
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
          {
            text: survey.accessCode ? "🔒 修改密码" : "🔓 设置密码",
            callback_data: `owner:access_code:${survey.id}`,
          },
        ]);
      } else {
        rows.push([
          {
            text: "编辑",
            callback_data: `owner:questions:${survey.id}`,
          },
          {
            text: survey.accessCode ? "🔒 修改密码" : "🔓 设置密码",
            callback_data: `owner:access_code:${survey.id}`,
          },
        ]);
      }

      return rows;
    }),
  };

  await sendMessage(ctx.botToken, chatId, "我的问卷：", keyboard);
}

type SurveyExportFormat = "csv" | "xlsx" | "zip";

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
    const assets = answer ? await getAnswerMediaAssets(ctx, answer) : [];
    const itemIndex = items.length;
    const media = assets.map((asset, mediaIndex) => {
      attachments.push({
        itemIndex,
        mediaIndex,
        questionNumber: index + 1,
        asset,
      });
      return { label: describeMediaAsset(asset) };
    });
    items.push({
      number: index + 1,
      title: question.title,
      answer: formatStoredAnswer(answer, question),
      media,
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
      media: item.media.map((media) => ({ ...media })),
    })),
  };

  for (const attachment of bundle.attachments) {
    const asset = attachment.asset;
    if (asset.mediaType !== "photo" || !asset.telegramFileId) continue;
    try {
      const downloaded = await downloadTelegramFile(
        ctx.botToken,
        asset.telegramFileId,
      );
      if (downloaded.data.byteLength > 8 * 1024 * 1024) continue;
      const media = report.items[attachment.itemIndex]?.media[
        attachment.mediaIndex
      ];
      if (media) {
        media.imageDataUrl = `data:${downloaded.contentType};base64,${bytesToBase64(downloaded.data)}`;
      }
    } catch (error) {
      console.warn("Failed to embed response image", asset.id, error);
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
          text: `第 ${responseNumber} 份 · ${formatChinaDateTime(response.completedAt)}`,
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
  await sendMessage(
    ctx.botToken,
    chatId,
    stats.totalCompleted === 0
      ? `“${survey.title}”还没有已完成的答卷。`
      : `“${survey.title}”已完成 ${stats.totalCompleted} 份答卷\n第 ${page} 页`,
    { inline_keyboard: rows },
  );
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
  const bundle = await buildResponseReportBundle(
    ctx,
    surveyId,
    responseId,
    responseNumber,
  );
  const report = bundle.report;
  const lines = [
    `📄 ${report.surveyTitle}`,
    `第 ${report.responseNumber} 份答卷`,
    `状态：${report.status}`,
    `填写者：${report.respondent}`,
    `开始：${report.startedAt}`,
    `完成：${report.completedAt}`,
  ];
  for (const item of report.items) {
    lines.push("", `第 ${item.number} 题：${item.title}`, `回答：${item.answer}`);
    for (const media of item.media) {
      lines.push(`附件：${media.label}`);
    }
  }
  await sendLongMessage(ctx.botToken, chatId, lines.join("\n"));

  for (const attachment of bundle.attachments) {
    await sendStoredMedia(
      ctx,
      chatId,
      attachment.asset,
      `第 ${attachment.questionNumber} 题附件`,
    );
  }

  await sendMessage(ctx.botToken, chatId, "答卷操作：", {
    inline_keyboard: [
      [
        {
          text: "导出 PDF",
          callback_data: `owner:response_export:pdf:${surveyId}:${responseId}:${responseNumber}:${returnOffset}`,
        },
        {
          text: "导出 PNG",
          callback_data: `owner:response_export:png:${surveyId}:${responseId}:${responseNumber}:${returnOffset}`,
        },
      ],
      [
        {
          text: "返回答卷列表",
          callback_data: `owner:responses:${surveyId}:${returnOffset}`,
        },
      ],
    ],
  });
}

async function sendResponseReportExport(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
  responseId: number,
  responseNumber: number,
  format: "pdf" | "png",
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
  const content = await renderResponseReport(ctx.browser, report, format);
  await sendDocument(
    ctx.botToken,
    chatId,
    `survey-${surveyId}-response-${responseNumber}.${format}`,
    content,
    format === "pdf" ? "application/pdf" : "image/png",
  );
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

  const { rows } = await getExportRows(ctx.db, surveyId);
  const csv = buildCsv(rows);
  if (format === "zip") {
    await sendDocument(
      ctx.botToken,
      chatId,
      `survey-${surveyId}.zip`,
      buildExportZip(csv, rows),
      "application/zip",
    );
  } else if (format === "xlsx") {
    await sendDocument(
      ctx.botToken,
      chatId,
      `survey-${surveyId}.xlsx`,
      buildXlsx(rows),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  } else {
    await sendDocument(
      ctx.botToken,
      chatId,
      `survey-${surveyId}.csv`,
      csv,
      "text/csv",
    );
  }
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

  const lines = [
    `📊 ${survey?.title ?? "问卷"}统计`,
    `内部编号：${surveyId}`,
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

  await sendLongMessage(
    ctx.botToken,
    chatId,
    lines.join("\n"),
    {
      inline_keyboard: [
        [
          {
            text: "预览",
            callback_data: `owner:preview:${surveyId}`,
          },
          {
            text: "编辑题目",
            callback_data: `owner:questions:${surveyId}`,
          },
          {
            text: "复制问卷",
            callback_data: `owner:duplicate:${surveyId}`,
          },
        ],
        [
          {
            text: "查看答卷",
            callback_data: `owner:responses:${surveyId}:0`,
          },
        ],
        [
          {
            text: "CSV",
            callback_data: `owner:export:csv:${surveyId}`,
          },
          {
            text: "Excel",
            callback_data: `owner:export:xlsx:${surveyId}`,
          },
          {
            text: "ZIP",
            callback_data: `owner:export:zip:${surveyId}`,
          },
          {
            text: "JSON",
            callback_data: `owner:export_json:${surveyId}`,
          },
        ],
      ],
    },
  );
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
  const dbUser = userId ? await getUserByTelegramId(ctx.db, userId) : null;
  const dbUserId = dbUser?.id;
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
      "欢迎使用问卷机器人。\n\n发送 /create 创建问卷，发送 /surveys 浏览问卷。\n\n需要问卷访问密码或想购买本软件，请联系 @meiebhiebot。",
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
      "命令：\n/start 开始\n/create 创建问卷\n/continue 继续草稿\n/surveys 浏览问卷\n/my_surveys 我的问卷\n/import 导入 JSON\n/admin 管理员面板\n/export <内部编号> [csv|xlsx|zip] 导出\n/license_help 软件授权管理（管理员）",
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

  if (text === "/set_survey_code") {
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      "用法：/set_survey_code <内部编号> <密码>",
    );
    return;
  }

  if (text?.startsWith("/set_survey_code ")) {
    const match = text.match(/^\/set_survey_code\s+(\d+)\s+(.+)$/);
    const surveyId = Number(match?.[1]);
    const code = match?.[2]?.trim();
    if (!surveyId || !code) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "用法：/set_survey_code <内部编号> <密码>",
      );
      return;
    }
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user) {
      await sendMessage(ctx.botToken, message.chat.id, "用户不存在。");
      return;
    }
    try {
      await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
      if (code !== "/clear" && (code.length < 4 || code.length > 64)) {
        throw new Error("密码长度必须为 4 到 64 个字符");
      }
      await setSurveyAccessCode(
        ctx.db,
        surveyId,
        code === "/clear" ? null : await hashSurveyAccessCode(code),
      );
      await sendMessage(ctx.botToken, message.chat.id, `问卷内部编号 ${surveyId} 的访问密码已更新。`);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "设置密码失败。",
      );
    }
    return;
  }

  if (text === "/get_survey_code") {
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      "用法：/get_survey_code <内部编号>",
    );
    return;
  }

  if (text?.startsWith("/get_survey_code ")) {
    const surveyId = Number(text.slice("/get_survey_code ".length));
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user) {
      await sendMessage(ctx.botToken, message.chat.id, "用户不存在。");
      return;
    }
    try {
      await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
      const survey = await getSurveyById(ctx.db, surveyId);
      if (!survey) throw new Error("问卷不存在");
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        survey.accessCode
          ? `问卷内部编号 ${surveyId} 已设置访问密码。密码不会直接显示。`
          : `问卷内部编号 ${surveyId} 未设置访问密码。`,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "查看密码失败。",
      );
    }
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

  if (text === "/create") {
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user || !canCreateSurvey(user, ctx.adminIds)) {
      await sendMessage(ctx.botToken, message.chat.id, "你没有创建问卷的权限。");
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
      response.surveyId,
    );
    return;
  }

  if (text) {
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

  if (data.startsWith("owner:response_export:")) {
    const [
      ,
      ,
      format,
      surveyIdRaw,
      responseIdRaw,
      responseNumberRaw,
    ] = data.split(":");
    if (format !== "pdf" && format !== "png") {
      await answerCallbackQuery(ctx.botToken, callback.id, "导出格式无效");
      return;
    }
    await answerCallbackQuery(ctx.botToken, callback.id, "正在生成文件");
    try {
      await sendResponseReportExport(
        ctx,
        chatId,
        userId,
        Number(surveyIdRaw),
        Number(responseIdRaw),
        Number(responseNumberRaw),
        format,
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
    await showSurveyStats(ctx, chatId, userId, surveyId);
    await answerCallbackQuery(ctx.botToken, callback.id);
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
    await answerCallbackQuery(ctx.botToken, callback.id, "正在生成导出文件");
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

  if (data.startsWith("owner:access_code:")) {
    const surveyId = Number(data.slice("owner:access_code:".length));
    if (!dbUser) {
      await answerCallbackQuery(ctx.botToken, callback.id, "用户不存在");
      return;
    }
    try {
      await assertCanManageSurvey(ctx.db, dbUser, surveyId, ctx.adminIds);
      await initBuilder(ctx.builder, userId);
      await startSetSurveyAccessCode(ctx.builder, userId, surveyId);
      await sendMessage(
        ctx.botToken,
        chatId,
        `请为问卷内部编号 ${surveyId} 输入 4 到 64 个字符的访问密码。\n发送 /clear 可移除现有密码，发送 /cancel 取消。`,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "无权设置密码。",
      );
    }
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
      await assertSurveyCanPublish(ctx.db, surveyId);
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
      await answerCallbackQuery(ctx.botToken, callback.id, "该题按钮已失效");
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
      await answerCallbackQuery(ctx.botToken, callback.id, "该题按钮已失效");
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
      await answerCallbackQuery(ctx.botToken, callback.id, "该题按钮已失效");
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
      await answerCallbackQuery(ctx.botToken, callback.id, "该题按钮已失效");
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

  if (data.startsWith("q:prev:")) {
    const questionId = Number(data.slice("q:prev:".length));
    const response = await ctx.db
      .prepare("SELECT * FROM survey_responses WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1")
      .bind(dbUserId)
      .first<{ id: number; survey_id: number; current_question_id: number | null }>();

    if (!response || response.current_question_id !== questionId) {
      await answerCallbackQuery(ctx.botToken, callback.id, "该题按钮已失效");
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
    await answerCallbackQuery(ctx.botToken, callback.id, "请先回答当前题目");
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
