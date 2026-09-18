import type { BrowserWorker } from "@cloudflare/puppeteer";
import {
  claimReportDelivery,
  completeReportDelivery,
  failReportDelivery,
  getReportDeliveryByDeliveryId,
} from "../db/repositories/report-delivery.repository";
import { getResponseById, listAnswersByResponseId } from "../db/repositories/response.repository";
import { getUserById } from "../db/repositories/user.repository";
import { getSurveyById } from "../db/repositories/survey.repository";
import { prepareResultProfileForResponse } from "./result-visual.service";
import { deserializeResultProfile } from "./result-engine.service";
import { renderReportPdf } from "./report/pdf";
import { resolveReportProfileImages } from "./report/report-images.service";
import {
  isReportDeliveryMessage,
  nextReportRetryAt,
  REPORT_DELIVERY_MAX_ATTEMPTS,
  REPORT_CHANNEL_CACHE_KEY,
} from "./report-delivery.service";
import { resolveReportTemplate } from "./report/template-resolver";
import { getSystemSettingValue, loadSystemSettings } from "./system-settings.service";
import { sendDocument, sendMessage, sendPhoto } from "../bot/telegram";
import { zipSync } from "fflate";

export interface ReportDeliveryWorkerEnvironment {
  DB: D1Database;
  BOT_TOKEN: string;
  BROWSER?: BrowserWorker;
  MEDIA_KV?: KVNamespace;
  REPORT_CHANNEL_ID?: string;
  CACHE?: KVNamespace;
  ADMIN_IDS?: string;
}

interface DeliveryResult {
  telegramChatId: number;
  pdfMessageId: number;
  imageMessageIds: number[];
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function respondentHtml(info: { username: string | null; firstName: string | null; telegramUserId: number }): string {
  if (info.username) {
    return `<a href="https://t.me/${escapeHtml(info.username)}">@${escapeHtml(info.username)}</a>`;
  }
  return `<a href="tg://openmessage?user_id=${info.telegramUserId}">用户 ${info.telegramUserId}</a>`;
}

function messageIdFromResponse(response: Response): Promise<number> {
  return response
    .clone()
    .json()
    .then((body: unknown) => {
      const messageId = (body as { result?: { message_id?: unknown } }).result?.message_id;
      if (typeof messageId !== "number") throw new Error("Telegram 未返回消息 ID");
      return messageId;
    });
}

function isRetryableDeliveryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/REPORT_CHANNEL_ID|BROWSER|未配置|not configured/.test(message)) return false;
  if (/超过大小限制|too large/.test(message)) return false;
  return true;
}

export async function processReportDeliveryMessage(env: ReportDeliveryWorkerEnvironment, body: unknown): Promise<void> {
  if (!isReportDeliveryMessage(body)) return;
  const delivery = await getReportDeliveryByDeliveryId(env.DB, body.deliveryId);
  if (!delivery) return;
  if (delivery.status === "delivered") return; // idempotent: never double-archive
  if (!(await claimReportDelivery(env.DB, delivery.id))) return; // another worker won

  const attempts = delivery.attempts + 1;
  try {
    const result = await deliverReportToChannel(env, delivery.responseId);
    await completeReportDelivery(env.DB, delivery.id, result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const retryable = isRetryableDeliveryError(error);
    const nextRetryAt = nextReportRetryAt(attempts);
    await failReportDelivery(env.DB, delivery.id, {
      error: errorMessage,
      retryable: retryable && attempts < REPORT_DELIVERY_MAX_ATTEMPTS,
      nextRetryAt: retryable && attempts < REPORT_DELIVERY_MAX_ATTEMPTS ? nextRetryAt : null,
    });
    console.error("Report delivery failed", {
      deliveryId: delivery.deliveryId,
      responseId: delivery.responseId,
      attempts,
      retryable,
      error: errorMessage,
    });
    if (!retryable || attempts >= REPORT_DELIVERY_MAX_ATTEMPTS) {
      await notifyAdminDeliveryFailure(env, delivery.responseId, errorMessage);
    }
  }
}

async function deliverReportToChannel(
  env: ReportDeliveryWorkerEnvironment,
  responseId: number,
): Promise<DeliveryResult> {
  const settingsChannel = await getSystemSettingValue(env.DB, "report_channel_id");
  const cachedChannel = env.CACHE ? await env.CACHE.get(REPORT_CHANNEL_CACHE_KEY) : undefined;
  const chatId =
    [settingsChannel, cachedChannel, env.REPORT_CHANNEL_ID]
      .map((value) => Number(value?.trim()))
      .find((value) => Number.isInteger(value) && value !== 0) ?? NaN;
  if (!Number.isInteger(chatId) || chatId === 0) {
    throw new Error("REPORT_CHANNEL_ID 未配置或无效");
  }
  if (!env.BROWSER) {
    throw new Error("BROWSER 未配置，无法生成 PDF");
  }

  const response = await getResponseById(env.DB, responseId);
  if (!response || response.status !== "completed") {
    throw new Error("答卷不存在或尚未完成");
  }
  const survey = await getSurveyById(env.DB, response.surveyId);
  const settings = await loadSystemSettings(env.DB);
  const template = await resolveReportTemplate(env.DB, survey?.reportTemplateId ?? settings.defaultReportTemplate);
  const prepared = await prepareResultProfileForResponse(env.DB, responseId);
  if (!prepared) {
    throw new Error("无法生成答卷结果");
  }
  const snapshot = deserializeResultProfile(prepared.profile);
  const images = await resolveReportProfileImages(env, snapshot);
  const respondentInfo = response.userId === null ? null : await getUserById(env.DB, response.userId);
  const answers = await listAnswersByResponseId(env.DB, responseId);
  const completedAt = formatChinaDateTime(response.completedAt);

  const pdfMeta: {
    surveyTitle?: string;
    completedAt: string;
    reportId: string;
    watermark?: string;
  } = { completedAt, reportId: `#${responseId}` };
  if (survey?.title) pdfMeta.surveyTitle = survey.title;
  pdfMeta.watermark = settings.reportWatermark;
  const pdf = await renderReportPdf(env.BROWSER, snapshot, images, pdfMeta, {}, template);
  const pdfMaxBytes = settings.pdfMaxMb * 1024 * 1024;
  if (pdf.byteSize > pdfMaxBytes) {
    throw new Error(`PDF 超过大小限制（${settings.pdfMaxMb}MB，实际 ${(pdf.byteSize / 1024 / 1024).toFixed(1)}MB）`);
  }

  // Package the PDF together with the participant's uploaded images into a
  // single zip so the archive channel receives everything in one file.
  const mediaFiles = Object.entries(images)
    .filter(([, url]) => url.startsWith("data:image/"))
    .map(([key, url]) => ({ key, bytes: dataUrlToBytes(url), extension: dataUrlExtension(url) }));
  const zip = buildReportZip({ responseId, surveyId: response.surveyId, surveyTitle: survey?.title ?? "未知问卷", completedAt, respondent: respondentInfo, profile: snapshot, answers, pdfBytes: pdf.bytes, media: mediaFiles });
  const sendZip = zip.byteLength <= 45 * 1024 * 1024;
  const archiveName = sendZip ? `report-${responseId}.zip` : `report-${responseId}.pdf`;
  const archiveBytes = sendZip ? zip : pdf.bytes;
  const archiveType = sendZip ? "application/zip" : "application/pdf";

  const caption = [
    "📋 新答卷",
    "",
    `问卷：${escapeHtml(survey?.title ?? "未知问卷")}`,
    `答卷：#${responseId}`,
    `用户：${respondentInfo ? respondentHtml(respondentInfo) : "匿名"}`,
    `完成时间：${completedAt}`,
    "",
    sendZip ? `📦 完整归档包：report-${responseId}.zip（报告 / 结果 / 答案 / 图片）` : `📄 报告：report-${responseId}.pdf`,
  ].join("\n");
  const tags = [`#答卷${responseId}`, `#问卷${response.surveyId}`];
  tags.push(respondentInfo ? `#用户${respondentInfo.telegramUserId}` : "#匿名答卷");
  const captionWithTags = `${caption}\n\n${tags.join(" ")}`;

  const pdfResponse = await sendDocument(
    env.BOT_TOKEN,
    chatId,
    archiveName,
    archiveBytes,
    archiveType,
    captionWithTags,
    "HTML",
  );
  const pdfMessageId = await messageIdFromResponse(pdfResponse);

  const imageMessageIds: number[] = [];
  // Fallback when the zip would be too large: send the PDF plus up to 6 user
  // images as separate Telegram messages.
  if (!sendZip) {
    const gallery = mediaFiles.slice(0, 6);
    for (let index = 0; index < gallery.length; index += 1) {
      const bytes = gallery[index]?.bytes;
      if (!bytes) continue;
      try {
        const photoResponse = await sendPhoto(env.BOT_TOKEN, chatId, bytes, `用户附件 ${index + 1}/${gallery.length}`);
        imageMessageIds.push(await messageIdFromResponse(photoResponse));
      } catch {
        const documentResponse = await sendDocument(
          env.BOT_TOKEN,
          chatId,
          `attachment-${index + 1}.img`,
          bytes,
          "image/jpeg",
        );
        imageMessageIds.push(await messageIdFromResponse(documentResponse));
      }
    }
  }

  return { telegramChatId: chatId, pdfMessageId, imageMessageIds };
}

function dataUrlToBytes(url: string): Uint8Array {
  const comma = url.indexOf(",");
  const base64 = url.slice(comma + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function dataUrlExtension(url: string): string {
  const match = /^data:image\/([a-zA-Z0-9.+-]+);/.exec(url);
  const type = match?.[1]?.toLowerCase() ?? "img";
  return type === "jpeg" ? "jpg" : type;
}

function buildReportZip(input: {
  responseId: number; surveyId: number; surveyTitle: string; completedAt: string;
  respondent: { username: string | null; firstName: string | null; telegramUserId: number } | null;
  profile: ReturnType<typeof deserializeResultProfile>; answers: Awaited<ReturnType<typeof listAnswersByResponseId>>;
  pdfBytes: Uint8Array; media: Array<{ key: string; bytes: Uint8Array; extension: string }>;
}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "01-report/report.pdf": input.pdfBytes,
    "01-report/result.json": new TextEncoder().encode(JSON.stringify(input.profile, null, 2)),
    "02-answers/answers.json": new TextEncoder().encode(JSON.stringify(input.answers.map((answer) => ({
      questionId: answer.questionId, textValue: answer.textValue, numberValue: answer.numberValue, booleanValue: answer.booleanValue,
      ratingValue: answer.ratingValue, dateValue: answer.dateValue, timeValue: answer.timeValue, jsonValue: answer.jsonValue,
    })), null, 2)),
  };
  const manifest = {
    packageVersion: 2, responseId: input.responseId, surveyId: input.surveyId, surveyTitle: input.surveyTitle,
    completedAt: input.completedAt, respondent: input.respondent ? { username: input.respondent.username, firstName: input.respondent.firstName, telegramUserId: input.respondent.telegramUserId } : null,
    files: ["01-report/report.pdf", "01-report/result.json", "02-answers/answers.json"],
  };
  input.media.forEach((item, index) => {
    const safeKey = item.key.replace(/[^A-Za-z0-9._-]+/g, "_");
    const group = item.key.startsWith("gallery.") ? "03-attachments" : item.key.startsWith("avatar") || item.key.startsWith("portrait") ? "04-profile" : "05-result-assets";
    const path = `${group}/${String(index + 1).padStart(2, "0")}-${safeKey}.${item.extension}`;
    files[path] = item.bytes; manifest.files.push(path);
  });
  files["00-index.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  return zipSync(files);
}

function formatChinaDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

async function notifyAdminDeliveryFailure(
  env: ReportDeliveryWorkerEnvironment,
  responseId: number,
  error: string,
): Promise<void> {
  const adminIds = (env.ADMIN_IDS ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  for (const adminId of adminIds) {
    try {
      await sendMessage(env.BOT_TOKEN, adminId, `❌ 答卷 #${responseId} 报告归档失败：${error.slice(0, 300)}`);
    } catch (notificationError) {
      console.error("Failed to notify admin of delivery failure", {
        responseId,
        error: notificationError,
      });
    }
  }
}
