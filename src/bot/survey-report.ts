import { getResponseById } from "../db/repositories/response.repository";
import { getResponseDetail, listResponses } from "../services/result.service";
import { SurveyQuestionView } from "../survey/engine";
import { MediaAsset } from "../db/schema";
import { ResponseReport } from "../services/response-report/model";
import { BotContext } from "./types";
import { getSurveyById } from "../db/repositories/survey.repository";
import { getSurveyFlow } from "../services/question.service";
import {
  getAnswerMediaByAnswerIds,
  getMediaAssetsByIds,
  getQuestionMediaByQuestionIds,
  listOptionMediaByOptionIds,
} from "../db/repositories/media.repository";
import {
  InlineKeyboardMarkup,
  downloadTelegramFile,
  sendDocument,
  sendMessage,
  sendPhoto,
  sendPhotoAlbum,
} from "./telegram";
import { getUserByTelegramId } from "../db/repositories/user.repository";
import { assertCanManageSurvey } from "../services/permission.service";
import {
  getCompletionTimeBuckets,
  getNumericStatistics,
  getOptionStatistics,
  getSurveyStatistics,
} from "../services/statistics.service";
import { renderUiScreen } from "./ui";
import { listVisualTemplates } from "../db/repositories/visual-template.repository";
import { renderResponseReport } from "../services/response-report.service";
import { SurveyExportFormat, enqueueExportJob } from "../services/export-queue.service";
import { renderSurveySummaryReport } from "../services/survey-report.service";
import { exportUnifiedSurveyJson } from "../services/survey-json.service";
import { getMatrixColumns as matrixColumns } from "../survey/question-presentation";

function formatResponseRespondent(
  respondent: Awaited<ReturnType<typeof listResponses>>[number]["respondent"],
  anonymous: boolean,
): string {
  if (anonymous) return "匿名填写者";
  if (!respondent) return "未知填写者";
  const name = [respondent.firstName, respondent.lastName].filter(Boolean).join(" ");
  if (name) return name;
  if (respondent.username) return `@${respondent.username}`;
  return `用户 ${respondent.telegramUserId}`;
}

const responseStatusLabels = {
  in_progress: "填写中",
  completed: "已完成",
  abandoned: "已中止",
  cancelled: "已取消",
  archived: "已归档",
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
  return Number.isFinite(date.getTime()) ? chinaDateTimeFormatter.format(date) : value;
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
  const name = [respondent.firstName, respondent.lastName].filter(Boolean).join(" ");
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
        question.type === "matrix" &&
        parsed &&
        typeof parsed === "object" &&
        (parsed as { kind?: unknown }).kind === "matrix"
      ) {
        const selections = (parsed as { selections?: unknown }).selections;
        const columns = matrixColumns(question);
        if (selections && typeof selections === "object") {
          const rowLabels = new Map(question.options.map((row) => [String(row.id), row.label]));
          return Object.entries(selections as Record<string, unknown>)
            .map(
              ([rowId, columnIndex]) =>
                `${rowLabels.get(rowId) ?? `行 #${rowId}`}：${columns[Number(columnIndex)] ?? `列 ${Number(columnIndex) + 1}`}`,
            )
            .join("\n");
        }
      }
      if (Array.isArray(parsed)) {
        const optionLabels = new Map(question.options.map((option) => [option.id, option.label]));
        const labels = parsed.map((optionId) => optionLabels.get(Number(optionId)) ?? `已删除选项 #${optionId}`);
        if (labels.length > 0) return labels.join("、");
      } else if (parsed && typeof parsed === "object" && "mediaAssetId" in parsed) {
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
  const details = [typeLabels[asset.mediaType], asset.fileName, asset.duration ? `${asset.duration} 秒` : null].filter(
    Boolean,
  );
  return details.join(" · ");
}

function mediaAssetIdFromJson(jsonValue: string | null): number | null {
  if (!jsonValue) return null;
  try {
    const parsed = JSON.parse(jsonValue) as unknown;
    if (parsed && typeof parsed === "object" && "mediaAssetId" in parsed) {
      const id = Number((parsed as { mediaAssetId?: unknown }).mediaAssetId);
      return Number.isInteger(id) && id > 0 ? id : null;
    }
  } catch {
    return null;
  }
  return null;
}

type ResponseAnswer = NonNullable<Awaited<ReturnType<typeof getResponseDetail>>>["answers"][number];

/** Groups ordered relation rows by their owner id into `owner -> assetId[]`. */
function groupRelationAssetIds<TRow>(
  rows: readonly TRow[],
  ownerIdOf: (row: TRow) => number,
  assetIdOf: (row: TRow) => number,
): Map<number, number[]> {
  const grouped = new Map<number, number[]>();
  for (const row of rows) {
    const ownerId = ownerIdOf(row);
    const existing = grouped.get(ownerId);
    if (existing) existing.push(assetIdOf(row));
    else grouped.set(ownerId, [assetIdOf(row)]);
  }
  return grouped;
}

/**
 * Media asset ids referenced by an answer, in relation order, with the legacy
 * `jsonValue.mediaAssetId` fallback appended once.
 */
function answerMediaAssetIds(answer: ResponseAnswer, relationsByAnswerId: Map<number, number[]>): number[] {
  const ids = [...(relationsByAnswerId.get(answer.id) ?? [])];
  const fallbackId = mediaAssetIdFromJson(answer.jsonValue);
  if (fallbackId && !ids.includes(fallbackId)) {
    ids.push(fallbackId);
  }
  return ids;
}

/** Resolves asset ids against a preloaded map, skipping missing rows. */
function assetsForIds(ids: readonly number[], assets: Map<number, MediaAsset>): MediaAsset[] {
  const resolved: MediaAsset[] = [];
  for (const id of ids) {
    const asset = assets.get(id);
    if (asset) resolved.push(asset);
  }
  return resolved;
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
  const answersByQuestion = new Map(detail.answers.map((answer) => [answer.questionId, answer]));
  const attachments: ResponseReportBundle["attachments"] = [];
  const items: ResponseReport["items"] = [];

  // One batched query per relation table plus one for the assets themselves,
  // instead of a SELECT per question, option, answer and asset.
  const [questionMediaRows, optionMediaRows, answerMediaRows] = await Promise.all([
    getQuestionMediaByQuestionIds(
      ctx.db,
      flow.questions.map((question) => question.id),
    ),
    listOptionMediaByOptionIds(
      ctx.db,
      flow.questions.flatMap((question) => question.options.map((option) => option.id)),
    ),
    getAnswerMediaByAnswerIds(
      ctx.db,
      detail.answers.map((answer) => answer.id),
    ),
  ]);
  const questionMediaByQuestion = groupRelationAssetIds(
    questionMediaRows,
    (row) => row.questionId,
    (row) => row.mediaAssetId,
  );
  const optionMediaByOption = groupRelationAssetIds(
    optionMediaRows,
    (row) => row.questionOptionId,
    (row) => row.mediaAssetId,
  );
  const answerMediaByAnswer = groupRelationAssetIds(
    answerMediaRows,
    (row) => row.answerId,
    (row) => row.mediaAssetId,
  );
  const referencedAssetIds = new Set<number>();
  for (const ids of questionMediaByQuestion.values()) for (const id of ids) referencedAssetIds.add(id);
  for (const ids of optionMediaByOption.values()) for (const id of ids) referencedAssetIds.add(id);
  for (const answer of detail.answers) {
    for (const id of answerMediaAssetIds(answer, answerMediaByAnswer)) referencedAssetIds.add(id);
  }
  const assetsById = await getMediaAssetsByIds(ctx.db, [...referencedAssetIds]);

  for (let index = 0; index < flow.questions.length; index += 1) {
    const question = flow.questions[index];
    if (!question) continue;
    const answer = answersByQuestion.get(question.id);
    const answerAssets = answer ? assetsForIds(answerMediaAssetIds(answer, answerMediaByAnswer), assetsById) : [];
    const questionAssets = assetsForIds(questionMediaByQuestion.get(question.id) ?? [], assetsById);
    const itemIndex = items.length;
    const questionMedia = questionAssets.map((asset, mediaIndex) => {
      attachments.push({
        itemIndex,
        mediaIndex,
        role: "question",
        questionNumber: index + 1,
        asset,
      });
      return {
        id: asset.id,
        label: describeMediaAsset(asset),
        role: "question" as const,
        width: asset.width,
        height: asset.height,
      };
    });
    const answerMedia = answerAssets.map((asset, mediaIndex) => {
      attachments.push({ itemIndex, mediaIndex, role: "answer", questionNumber: index + 1, asset });
      return {
        id: asset.id,
        label: describeMediaAsset(asset),
        role: "answer" as const,
        width: asset.width,
        height: asset.height,
      };
    });
    let parsedAnswer: unknown = null;
    try {
      parsedAnswer = answer?.jsonValue ? JSON.parse(answer.jsonValue) : null;
    } catch {
      parsedAnswer = null;
    }
    const selectedIds = new Set(Array.isArray(parsedAnswer) ? parsedAnswer.map(Number) : []);
    const matrixSelections =
      parsedAnswer &&
      typeof parsedAnswer === "object" &&
      !Array.isArray(parsedAnswer) &&
      (parsedAnswer as { kind?: unknown }).kind === "matrix"
        ? ((parsedAnswer as { selections?: Record<string, number> }).selections ?? {})
        : undefined;
    const options = [];
    for (let optionIndex = 0; optionIndex < question.options.length; optionIndex += 1) {
      const option = question.options[optionIndex]!;
      const optionAssets = assetsForIds(optionMediaByOption.get(option.id) ?? [], assetsById);
      const optionMedia = optionAssets.map((asset, mediaIndex) => {
        attachments.push({ itemIndex, optionIndex, mediaIndex, role: "option", questionNumber: index + 1, asset });
        return {
          id: asset.id,
          label: describeMediaAsset(asset),
          role: "option" as const,
          width: asset.width,
          height: asset.height,
        };
      });
      options.push({ id: option.id, label: option.label, selected: selectedIds.has(option.id), media: optionMedia });
    }
    const answerText = formatStoredAnswer(answer, question);
    const rawAnswer = answer
      ? (answer.textValue ??
        (answer.numberValue !== null ? String(answer.numberValue) : (answer.dateValue ?? answer.timeValue ?? null)))
      : null;
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
      status: responseStatusLabels[detail.response.status] ?? detail.response.status,
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

async function addReportImages(ctx: BotContext, bundle: ResponseReportBundle): Promise<ResponseReport> {
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
      const downloaded = await downloadTelegramFile(ctx.botToken, asset.telegramFileId);
      const item = report.items[attachment.itemIndex];
      const media =
        attachment.role === "option"
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

export async function assertResponseAccess(ctx: BotContext, userId: number, surveyId: number): Promise<void> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) throw new Error("用户信息不存在");
  await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
}

export async function showSurveyResponses(
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
  const lastPageOffset = stats.totalCompleted === 0 ? 0 : Math.floor((stats.totalCompleted - 1) / pageSize) * pageSize;
  const safeOffset = Math.max(0, Math.min(offset, lastPageOffset));
  const responses = await listResponses(ctx.db, surveyId, pageSize, safeOffset, "completed");
  const rows: InlineKeyboardMarkup["inline_keyboard"] = responses.map((response, index) => {
    const responseNumber = stats.totalCompleted - safeOffset - index;
    return [
      {
        text: `第 ${responseNumber} 份 · ${formatResponseRespondent(response.respondent, survey.anonymous)}`,
        callback_data: `owner:response:${surveyId}:${response.id}:${responseNumber}:${safeOffset}`,
      },
    ];
  });

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
    text:
      stats.totalCompleted === 0
        ? `“${survey.title}”还没有已完成的答卷。`
        : `“${survey.title}”已完成 ${stats.totalCompleted} 份答卷\n第 ${page} 页`,
    replyMarkup: { inline_keyboard: rows },
    state: { surveyId, offset: safeOffset },
  });
}

export async function showResponseDetail(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
  responseId: number,
  responseNumber: number,
  returnOffset: number,
): Promise<void> {
  await assertResponseAccess(ctx, userId, surveyId);
  await renderUiScreen(ctx, chatId, userId, {
    screen: "response_actions",
    text: `第 ${responseNumber} 份答卷\n请选择操作：`,
    replyMarkup: {
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
    },
    state: { surveyId, responseId, returnOffset },
  });
}

export async function showManagedResponseReportTemplates(
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
  const templates = (await listVisualTemplates(ctx.db, 100)).filter(
    (template) =>
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
        ...templates.map((template) => [
          {
            text: `📊 ${template.name}`,
            callback_data: `owner:response_report_generate:${surveyId}:${responseId}:${template.id}`,
          },
        ]),
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
  const bundle = await buildResponseReportBundle(ctx, surveyId, responseId, responseNumber);
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
        await sendPhoto(
          ctx.botToken,
          chatId,
          pages[0]!.bytes,
          `📱 手机版报告 · 第 ${offset + 1}/${artifact.pages.length} 页`,
        );
      } else {
        await sendPhotoAlbum(
          ctx.botToken,
          chatId,
          pages.map((page, index) => ({
            bytes: page.bytes,
            ...(index === 0
              ? { caption: `📱 手机版报告 · 第 ${offset + 1}–${offset + pages.length}/${artifact.pages.length} 页` }
              : {}),
          })),
        );
      }
    }
    if (artifact.targetTotalBytesExceeded) {
      await sendMessage(
        ctx.botToken,
        chatId,
        `手机版报告共 ${artifact.pages.length} 页、${(artifact.totalBytes / 1024 / 1024).toFixed(1)} MB，内容已全部发送。`,
      );
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

export async function sendSurveyExport(
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
  await sendMessage(ctx.botToken, chatId, `导出任务 #${jobId} 已创建，文件生成后会自动发送。`);
}

export async function sendSurveySummaryPdf(
  ctx: BotContext,
  chatId: number,
  userId: number,
  surveyId: number,
): Promise<void> {
  await assertResponseAccess(ctx, userId, surveyId);
  if (!ctx.browser) {
    throw new Error("当前部署未启用 PDF 导出服务");
  }
  const [survey, statistics, optionStatistics, numericStatistics, completionTimeBuckets] = await Promise.all([
    getSurveyById(ctx.db, surveyId),
    getSurveyStatistics(ctx.db, surveyId),
    getOptionStatistics(ctx.db, surveyId),
    getNumericStatistics(ctx.db, surveyId),
    getCompletionTimeBuckets(ctx.db, surveyId, 14),
  ]);
  if (!survey) throw new Error("问卷不存在");
  const content = await renderSurveySummaryReport(ctx.browser, {
    surveyTitle: survey.title,
    surveyId,
    generatedAt: formatChinaDateTime(new Date().toISOString()),
    statistics,
    optionStatistics,
    numericStatistics,
    completionTimeBuckets,
  });
  await sendDocument(ctx.botToken, chatId, `survey-${surveyId}-statistics.pdf`, content, "application/pdf");
}

export async function sendSurveyJsonExport(
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
