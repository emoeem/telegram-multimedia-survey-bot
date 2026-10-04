import type { BrowserWorker } from "@cloudflare/puppeteer";
import type { BotContext } from "../bot/types";
import { addReportImages, buildResponseReportBundle } from "../bot/survey-report";
import { renderResponseReport } from "./response-report.service";
import { sendMessage, sendPhoto, sendPhotoAlbum } from "../bot/telegram";
import { getDefaultPublicationTarget } from "../db/repositories/publication-target.repository";

export interface PublicReportEnvironment {
  DB: D1Database;
  BOT_TOKEN: string;
  BROWSER?: BrowserWorker;
  MEDIA_KV?: KVNamespace;
}



function caption(report: Awaited<ReturnType<typeof buildResponseReportBundle>>["report"]): string {
  const title = report.surveyTitle?.trim() || "问卷";
  const respondent = report.respondent?.trim() || "匿名填写者";
  return [
    "📋 问卷报告",
    "",
    `问卷：${title.slice(0, 180)}`,
    `填写者：${respondent.slice(0, 120)}`,
    report.completedAt ? `完成时间：${report.completedAt}` : "",
  ].filter(Boolean).join("\n");
}

export async function publishPublicResponseReport(
  env: PublicReportEnvironment,
  responseId: number,
): Promise<{ chatId: number; messageIds: number[]; pages: number }> {
  if (!env.BROWSER) throw new Error("BROWSER 未配置，无法生成公开报告图片");

  const response = await env.DB.prepare(
    "SELECT id, survey_id, status, report_publication_status, publication_target_id, publication_target_chat_id, publication_target_thread_id FROM survey_responses WHERE id=? LIMIT 1",
  ).bind(responseId).first<{ id:number; survey_id:number; status:string; report_publication_status:string; publication_target_id:number|null; publication_target_chat_id:string|null; publication_target_thread_id:number|null }>();
  if (!response || response.status !== "completed") throw new Error("答卷不存在或尚未完成");
  const snapshotTarget = response.publication_target_chat_id
    ? { id: response.publication_target_id, name: "答卷提交时的公开目标", chatId: response.publication_target_chat_id, threadId: response.publication_target_thread_id }
    : null;
  const targetRow = !snapshotTarget && response.publication_target_id
    ? await env.DB.prepare("SELECT id,name,chat_id,thread_id FROM publication_targets WHERE id=? AND enabled=1").bind(response.publication_target_id).first<{id:number;name:string;chat_id:string;thread_id:number|null}>()
    : null;
  const target = snapshotTarget
    ?? (targetRow ? { id: targetRow.id, name: targetRow.name, chatId: targetRow.chat_id, threadId: targetRow.thread_id } : null)
    ?? await getDefaultPublicationTarget(env.DB);
  if (!target) throw new Error("Web 管理后台尚未配置公开报告发布目标");
  if (response.report_publication_status === "published") return { chatId: Number(target.chatId), messageIds: [], pages: 0 };

  const ctx = {
    db: env.DB,
    botToken: env.BOT_TOKEN,
    browser: env.BROWSER,
    mediaKv: env.MEDIA_KV,
  } as unknown as BotContext;

  const bundle = await buildResponseReportBundle(ctx, response.survey_id, responseId, responseId);
  const report = await addReportImages(ctx, bundle);
  const artifact = await renderResponseReport(env.BROWSER, report, "png");
  if (artifact.format !== "png" || artifact.pages.length === 0) throw new Error("公开报告没有生成图片页面");

  const chatId = Number(target.chatId);
  if (!Number.isInteger(chatId) || chatId === 0) throw new Error("公开报告发布目标群组 ID 无效");
  const threadId = target.threadId;
  const messageIds: number[] = [];
  const textCaption = caption(report);

  for (let offset = 0; offset < artifact.pages.length; offset += 10) {
    const pages = artifact.pages.slice(offset, offset + 10);
    if (pages.length === 1) {
      const response = await sendPhoto(env.BOT_TOKEN, chatId, pages[0]!.bytes, textCaption, undefined, threadId ?? undefined);
      const messageId = Number((await response.json() as { result?: { message_id?: number } }).result?.message_id);
      if (Number.isInteger(messageId)) messageIds.push(messageId);
    } else {
      const response = await sendPhotoAlbum(
        env.BOT_TOKEN,
        chatId,
        pages.map((page, index) => ({
          bytes: page.bytes,
          ...(index === 0 && offset === 0 ? { caption: textCaption } : {}),
        })),
        threadId ?? undefined,
      );
      const payload = await response.json() as { result?: Array<{ message_id?: number }> };
      for (const item of payload.result ?? []) {
        if (Number.isInteger(item.message_id)) messageIds.push(item.message_id!);
      }
    }
  }

  await env.DB.prepare(
    "UPDATE survey_responses SET report_publication_status='published', report_published_at=?, updated_at=? WHERE id=?",
  ).bind(new Date().toISOString(), new Date().toISOString(), responseId).run();

  return { chatId, messageIds, pages: artifact.pages.length };
}
