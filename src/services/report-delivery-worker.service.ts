import type { BrowserWorker } from "@cloudflare/puppeteer";
import {
  claimReportDelivery,
  completeReportDelivery,
  failReportDelivery,
  getReportDeliveryByDeliveryId,
} from "../db/repositories/report-delivery.repository";
import { getResponseById } from "../db/repositories/response.repository";
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
import { deleteTemporaryMediaForResponse } from "./media/temporary-media.service";
import { KVMediaStore } from "./media/temporary-media-store";
import { REPORT_TEMPLATES } from "./report/template";
import { getSystemSettingValue } from "./system-settings.service";
import { sendDocument, sendMessage, sendPhoto } from "../bot/telegram";

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

function messageIdFromResponse(response: Response): Promise<number> {
  return response.clone().json().then((body: unknown) => {
    const messageId = (body as { result?: { message_id?: unknown } }).result?.message_id;
    if (typeof messageId !== "number") throw new Error("Telegram 未返回消息 ID");
    return messageId;
  });
}

function isRetryableDeliveryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/REPORT_CHANNEL_ID|BROWSER|未配置|not configured/.test(message)) return false;
  return true;
}

export async function processReportDeliveryMessage(
  env: ReportDeliveryWorkerEnvironment,
  body: unknown,
): Promise<void> {
  if (!isReportDeliveryMessage(body)) return;
  const delivery = await getReportDeliveryByDeliveryId(env.DB, body.deliveryId);
  if (!delivery) return;
  if (delivery.status === "delivered") return; // idempotent: never double-archive
  if (!(await claimReportDelivery(env.DB, delivery.id))) return; // another worker won

  const attempts = delivery.attempts + 1;
  try {
    const result = await deliverReportToChannel(env, delivery.responseId);
    await completeReportDelivery(env.DB, delivery.id, result);
    if (env.MEDIA_KV) {
      try {
        await deleteTemporaryMediaForResponse(
          env.DB,
          new KVMediaStore(env.MEDIA_KV),
          delivery.responseId,
        );
      } catch (cleanupError) {
        console.warn("Temporary media cleanup after delivery failed", {
          responseId: delivery.responseId,
          error: cleanupError,
        });
      }
    }
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
  const configuredChannel = env.REPORT_CHANNEL_ID?.trim() || undefined;
  const cachedChannel = env.CACHE ? await env.CACHE.get(REPORT_CHANNEL_CACHE_KEY) : undefined;
  const settingsChannel = await getSystemSettingValue(env.DB, "report_channel_id");
  const chatIdRaw = configuredChannel ?? cachedChannel ?? settingsChannel ?? undefined;
  const chatId = chatIdRaw === undefined ? NaN : Number(chatIdRaw);
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
  const template = survey?.reportTemplateId
    ? REPORT_TEMPLATES[survey.reportTemplateId]
    : undefined;
  const prepared = await prepareResultProfileForResponse(env.DB, responseId);
  if (!prepared) {
    throw new Error("无法生成答卷结果");
  }
  const snapshot = deserializeResultProfile(prepared.profile);
  const images = await resolveReportProfileImages(env, snapshot);
  const respondentInfo = response.userId === null
    ? null
    : await getUserById(env.DB, response.userId);
  const respondent = respondentInfo
    ? (respondentInfo.username ?? respondentInfo.firstName ?? `用户 ${respondentInfo.telegramUserId}`)
    : "匿名";
  const completedAt = formatChinaDateTime(response.completedAt);

  const pdfMeta: {
    surveyTitle?: string;
    completedAt: string;
    reportId: string;
  } = { completedAt, reportId: `#${responseId}` };
  if (survey?.title) pdfMeta.surveyTitle = survey.title;
  const pdf = await renderReportPdf(env.BROWSER, snapshot, images, pdfMeta, {}, template);

  const caption = [
    "📋 新答卷",
    "",
    `问卷：${survey?.title ?? "未知问卷"}`,
    `答卷：#${responseId}`,
    `用户：${respondent}`,
    `完成时间：${completedAt}`,
    "",
    `📄 报告：report-${responseId}.pdf`,
  ].join("\n");
  const tags = [`#答卷${responseId}`, `#问卷${response.surveyId}`];
  tags.push(respondentInfo ? `#用户${respondentInfo.telegramUserId}` : "#匿名答卷");
  const captionWithTags = `${caption}\n\n${tags.join(" ")}`;

  const pdfResponse = await sendDocument(
    env.BOT_TOKEN,
    chatId,
    `report-${responseId}.pdf`,
    pdf.bytes,
    "application/pdf",
    captionWithTags,
  );
  const pdfMessageId = await messageIdFromResponse(pdfResponse);

  const imageMessageIds: number[] = [];
  const gallery = Object.values(images)
    .filter((url) => url.startsWith("data:image/"))
    .slice(0, 6);
  for (let index = 0; index < gallery.length; index += 1) {
    const url = gallery[index];
    if (!url) continue;
    const bytes = dataUrlToBytes(url);
    try {
      const photoResponse = await sendPhoto(
        env.BOT_TOKEN,
        chatId,
        bytes,
        `用户附件 ${index + 1}/${gallery.length}`,
      );
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
      await sendMessage(
        env.BOT_TOKEN,
        adminId,
        `❌ 答卷 #${responseId} 报告归档失败：${error.slice(0, 300)}`,
      );
    } catch (notificationError) {
      console.error("Failed to notify admin of delivery failure", {
        responseId,
        error: notificationError,
      });
    }
  }
}
