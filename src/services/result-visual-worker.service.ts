import { sendDocument, sendMessage, sendPhoto, sendPhotoAlbum } from "../bot/telegram";
import { getResultProfileById } from "../db/repositories/result-profile.repository";
import { getResponseById } from "../db/repositories/response.repository";
import {
  claimRenderJob,
  completeRenderJob,
  getRenderJobById,
} from "../db/repositories/result-visual.repository";
import { getVisualTemplateById, getVisualTemplateVersion } from "../db/repositories/visual-template.repository";
import { deserializeResultProfile } from "./result-engine.service";
import { renderResultVisualPng } from "./result-visual-renderer.service";
import { RESULT_VISUAL_WASM } from "./result-visual-wasm";
import { RESULT_VISUAL_FONTS } from "./result-visual-font";
import { isResultVisualJobMessage, type ResultVisualJobMessage } from "./result-visual-queue.service";
import { parseVisualTemplateDefinition } from "./visual-template-validator.service";
import { resolveResultVisualImages } from "./result-visual-image.service";
import type { BrowserWorker } from "@cloudflare/puppeteer";
import { renderHtmlReportArtifact } from "./html-report-renderer.service";
import type { ReportArtifact } from "./report/model";

export interface ResultVisualWorkerEnvironment {
  DB: D1Database;
  BOT_TOKEN: string;
  BROWSER?: BrowserWorker;
}

async function deliverReportArtifact(botToken: string, chatId: number, jobId: number, artifact: ReportArtifact, regenerateCallback: string): Promise<number> {
  if (artifact.failures.length) {
    console.error("Report pages were not rendered", { jobId, failures: artifact.failures });
  }
  let delivered = 0;
  let albumDelivered = false;
  if (artifact.deliveryMode === "album" && artifact.pages.length <= 10) {
    try {
      await sendPhotoAlbum(botToken, chatId, artifact.pages.map((page, index) => ({ bytes: page.bytes, ...(index === 0 ? { caption: `🎉 你的分析报告 · 共 ${artifact.totalPages} 页` } : {}) })));
      delivered = artifact.pages.length;
      albumDelivered = true;
    } catch (error) {
      console.error("Telegram report album failed; falling back to per-page delivery", { error, jobId });
    }
  }
  const pageFailures: string[] = [];
  for (const [index, page] of albumDelivered ? [] : artifact.pages.entries()) {
    const plannedPageNumber = Number(page.id.match(/\d+$/)?.[0] ?? index + 1);
    const caption = `分析报告 ${plannedPageNumber}/${artifact.totalPages} · ${page.kind}`;
    const replyMarkup = index === artifact.pages.length - 1 ? { inline_keyboard: [[{ text: "🔄 重新生成", callback_data: regenerateCallback }]] } : undefined;
    try {
      if (page.deliveryMode === "document" || page.size > 10 * 1024 * 1024) throw new Error("page selected document delivery by size policy");
      await sendPhoto(botToken, chatId, page.bytes, caption, replyMarkup);
      delivered += 1;
    } catch (photoError) {
      try {
        await sendDocument(botToken, chatId, `result-report-${jobId}-${String(index + 1).padStart(2, "0")}.${page.format === "jpeg" ? "jpg" : "png"}`, page.bytes, page.type);
        delivered += 1;
      } catch (documentError) {
        pageFailures.push(`${page.id}: ${documentError instanceof Error ? documentError.message : String(documentError)}`);
        console.error("[ReportPage] delivery failed", { jobId, pageId: page.id, mode: page.deliveryMode, sendPhoto: photoError, sendDocument: documentError });
      }
    }
  }
  if (artifact.archivePdf) {
    for (const [index, page] of artifact.pages.entries()) {
      try {
        await sendDocument(botToken, chatId, `result-report-${jobId}-hd-${String(index + 1).padStart(2, "0")}.${page.format === "jpeg" ? "jpg" : "png"}`, page.bytes, page.type);
      } catch (error) {
        pageFailures.push(`${page.id}-hd: ${error instanceof Error ? error.message : String(error)}`);
        console.error("[ReportPage] lossless document delivery failed", { jobId, pageId: page.id, error });
      }
    }
    try {
      await sendDocument(botToken, chatId, `result-report-${jobId}-archive.pdf`, artifact.archivePdf, "application/pdf");
    } catch (error) {
      pageFailures.push(`archive-pdf: ${error instanceof Error ? error.message : String(error)}`);
      console.error("[ReportPDF] archive delivery failed", { jobId, error });
    }
  }
  if (artifact.failures.length || pageFailures.length) {
    const failedPageIds = [...artifact.failures.map((failure) => failure.pageId), ...pageFailures.map((failure) => failure.split(":", 1)[0]!)];
    try { await sendMessage(botToken, chatId, `⚠️ 报告有 ${failedPageIds.length} 个页面生成或发送失败（${failedPageIds.join("、")}）。已送达页面可以正常查看，请稍后重新生成缺失内容。`); }
    catch (error) { console.error("Failed to notify partial report delivery", { error, jobId }); }
  }
  return delivered;
}

export async function processResultVisualMessage(
  env: ResultVisualWorkerEnvironment,
  body: unknown,
): Promise<void> {
  if (!isResultVisualJobMessage(body)) {
    console.error("Invalid result visual queue message");
    return;
  }
  const message: ResultVisualJobMessage = body;
  const job = await getRenderJobById(env.DB, message.jobId);
  if (!job || !await claimRenderJob(env.DB, job.id)) return;

  const [profileRecord, templateVersion] = await Promise.all([
    getResultProfileById(env.DB, job.resultProfileId),
    getVisualTemplateVersion(env.DB, job.templateId, job.templateVersion),
  ]);
  if (!profileRecord) throw new Error("result profile not found");
  if (!templateVersion) throw new Error("template version not found");
  const profile = deserializeResultProfile(profileRecord);
  const template = parseVisualTemplateDefinition(templateVersion.definitionJson);
  const images = await resolveResultVisualImages(env.DB, env.BOT_TOKEN, template, profile);
  const templateRecord = await getVisualTemplateById(env.DB, job.templateId);
  let png: Uint8Array | undefined;
  let artifact: ReportArtifact | undefined;
  if (templateRecord?.type === "report" && env.BROWSER) {
    try {
      artifact = await renderHtmlReportArtifact(env.BROWSER, profile, templateRecord.name, images);
    } catch (error) {
      throw new Error(`Multi-page HTML report rendering failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    png = await renderResultVisualPng(template, profile, {
      wasmModule: RESULT_VISUAL_WASM,
      fontBuffers: RESULT_VISUAL_FONTS,
      images,
    });
  }
  if (job.chatId !== null) {
    if (artifact) {
      const response = await getResponseById(env.DB, profileRecord.responseId);
      const participantRequest = response?.userId !== null && response?.userId === job.requestedBy;
      const regenerateCallback = participantRequest
        ? `rv:regenerate:${profileRecord.responseId}:${job.templateId}`
        : `owner:response_report_generate:${profileRecord.surveyId}:${profileRecord.responseId}:${job.templateId}`;
      const delivered = await deliverReportArtifact(env.BOT_TOKEN, job.chatId, job.id, artifact, regenerateCallback);
      if (delivered === 0) throw new Error("No report pages could be delivered");
      await completeRenderJob(env.DB, job.id);
      return;
    }
    if (!png) throw new Error("Result visual renderer returned no output");
    try {
      await sendPhoto(env.BOT_TOKEN, job.chatId, png, "🎉 你的结果卡已生成", { inline_keyboard: [[{ text: "🔄 重新生成", callback_data: `rv:regenerate:${profileRecord.responseId}` }]] });
    } catch (photoError) {
      console.error("Telegram photo delivery failed; sending PNG as document", { error: photoError, jobId: job.id });
      await sendDocument(env.BOT_TOKEN, job.chatId, `result-report-${job.id}.png`, png, "image/png");
    }
  }
  await completeRenderJob(env.DB, job.id);
}
