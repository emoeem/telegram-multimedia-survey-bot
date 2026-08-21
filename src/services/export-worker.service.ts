import {
  getExportJobById,
  updateExportJob,
} from "../db/repositories/export.repository";
import {
  buildCsv,
  serializeExport,
} from "./export.service";
import type { SurveyExportJobMessage } from "./export-queue.service";
import {
  processResultVisualMessage,
  type ResultVisualWorkerEnvironment,
} from "./result-visual-worker.service";
import { isResultVisualJobMessage } from "./result-visual-queue.service";
import {
  failRenderJob,
  releaseRenderJobForRetry,
} from "../db/repositories/result-visual.repository";
import { getExportRows } from "./export.service";
import { sendDocument, sendMessage } from "../bot/telegram";
import { isImageGeneratorJobMessage, processImageGeneratorMessage, retryImageGeneratorJob } from "./image-generator-worker.service";
import {
  isIdentityCardJobMessage,
  notifyIdentityCardFailure,
  processIdentityCardMessage,
  retryIdentityCardJob,
  type IdentityCardWorkerEnvironment,
} from "./identity-card-worker.service";
import type { BrowserWorker } from "@cloudflare/puppeteer";

export interface ExportWorkerEnvironment {
  DB: D1Database;
  BOT_TOKEN: string;
  ADMIN_IDS?: string;
  CACHE?: KVNamespace;
  SESSION?: DurableObjectNamespace<any>;
  UI?: DurableObjectNamespace<any>;
  BUILDER?: DurableObjectNamespace<any>;
  EXPORT_QUEUE?: Queue;
  BROWSER?: BrowserWorker;
}

interface ResponseReportJobMessage {
  kind: "response_report";
  chatId: number;
  userId: number;
  surveyId: number;
  responseId: number;
  responseNumber: number;
  format: "png";
  anonymize: boolean;
}

function isResponseReportJobMessage(value: unknown): value is ResponseReportJobMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.kind === "response_report" && ["chatId", "userId", "surveyId", "responseId", "responseNumber"].every((key) => Number.isInteger(message[key])) && message.format === "png" && typeof message.anonymize === "boolean";
}

async function processResponseReportMessage(env: ExportWorkerEnvironment, body: ResponseReportJobMessage): Promise<void> {
  if (!env.CACHE || !env.SESSION || !env.UI || !env.BUILDER || !env.EXPORT_QUEUE || !env.BROWSER) throw new Error("Response report worker bindings are unavailable");
  const { sendResponseReportExport } = await import("../bot/survey-handler");
  await sendResponseReportExport({
    botToken: env.BOT_TOKEN,
    db: env.DB,
    cache: env.CACHE,
    session: env.SESSION as never,
    ui: env.UI as never,
    builder: env.BUILDER as never,
    adminIds: (env.ADMIN_IDS ?? "").split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0),
    exportQueue: env.EXPORT_QUEUE,
    browser: env.BROWSER,
  }, body.chatId, body.userId, body.surveyId, body.responseId, body.responseNumber, body.format, body.anonymize);
}

function isExportJobMessage(value: unknown): value is SurveyExportJobMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    Number.isInteger(message.jobId) &&
    Number(message.jobId) > 0 &&
    Number.isInteger(message.surveyId) &&
    Number(message.surveyId) > 0 &&
    Number.isInteger(message.chatId) &&
    typeof message.format === "string" &&
    ["csv", "xlsx", "zip"].includes(message.format)
  );
}

function exportFileMetadata(
  surveyId: number,
  format: SurveyExportJobMessage["format"],
): { fileName: string; contentType: string } {
  if (format === "xlsx") {
    return {
      fileName: `survey-${surveyId}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  }
  if (format === "zip") {
    return { fileName: `survey-${surveyId}.zip`, contentType: "application/zip" };
  }
  return { fileName: `survey-${surveyId}.csv`, contentType: "text/csv" };
}

async function processExportMessage(
  env: ExportWorkerEnvironment,
  body: unknown,
): Promise<void> {
  if (!isExportJobMessage(body)) {
    console.error("Invalid export queue message", body);
    return;
  }

  const job = await getExportJobById(env.DB, body.jobId);
  if (!job || job.status !== "pending") return;

  await updateExportJob(env.DB, job.id, { status: "running" });
  try {
    const { rows } = await getExportRows(env.DB, body.surveyId);
    const csv = buildCsv(rows);
    const content = serializeExport(body.format, csv, rows);
    const metadata = exportFileMetadata(body.surveyId, body.format);
    await sendDocument(
      env.BOT_TOKEN,
      body.chatId,
      metadata.fileName,
      content,
      metadata.contentType,
    );
    await updateExportJob(env.DB, job.id, { status: "completed" });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "导出文件生成失败";
    console.error("Survey export job failed", job.id, error);
    await updateExportJob(env.DB, job.id, {
      status: "failed",
      errorMessage: errorMessage.slice(0, 500),
    });
    try {
      await sendMessage(env.BOT_TOKEN, body.chatId, "导出失败，请稍后重新发起导出。");
    } catch (notificationError) {
      console.error("Failed to notify export requester", job.id, notificationError);
    }
  }
}

export async function handleExportQueue(
  batch: MessageBatch<unknown>,
  env: ExportWorkerEnvironment & ResultVisualWorkerEnvironment & IdentityCardWorkerEnvironment,
): Promise<void> {
  for (const message of batch.messages) {
    if (isResponseReportJobMessage(message.body)) {
      try {
        await processResponseReportMessage(env, message.body);
        message.ack();
      } catch (error) {
        const terminal = message.attempts >= 3;
        console.error("Response report queue job failed", { attempts: message.attempts, terminal, error });
        if (terminal) {
          try { await sendMessage(env.BOT_TOKEN, message.body.chatId, "❌ 手机版报告生成失败，请稍后重试。"); }
          catch (notificationError) { console.error("Failed to notify response report requester", notificationError); }
          message.ack();
        } else {
          message.retry({ delaySeconds: Math.min(60, message.attempts * 10) });
        }
      }
    } else if (isImageGeneratorJobMessage(message.body)) {
      try { await processImageGeneratorMessage(env, message.body); message.ack(); }
      catch (error) {
        const detail=error instanceof Error?error.message:"Image generator failed";
        const terminal=message.attempts>=3;
        await retryImageGeneratorJob(env.DB,message.body.jobId,detail,terminal);
        if (terminal) {
          const job = await env.DB.prepare("SELECT chat_id FROM image_generator_jobs WHERE id=?").bind(message.body.jobId).first<{ chat_id: number }>();
          if (job) {
            try { await sendMessage(env.BOT_TOKEN, job.chat_id, "❌ 报告生成失败，请稍后重新生成。"); }
            catch (notificationError) { console.error("Failed to notify report requester", message.body.jobId, notificationError); }
          }
          message.ack();
        } else message.retry({delaySeconds:Math.min(60,message.attempts*10)});
      }
    } else if (isIdentityCardJobMessage(message.body)) {
      try {
        await processIdentityCardMessage(env, message.body);
        message.ack();
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Identity card rendering failed";
        const terminal = message.attempts >= 3;
        console.error("Identity card queue job failed", {
          jobId: message.body.jobId,
          attempts: message.attempts,
          terminal,
          error: detail,
        });
        await retryIdentityCardJob(env.DB, message.body.jobId, detail, terminal);
        if (terminal) {
          await notifyIdentityCardFailure(env, message.body.jobId);
          message.ack();
        } else {
          message.retry({ delaySeconds: Math.min(60, message.attempts * 10) });
        }
      }
    } else if (isResultVisualJobMessage(message.body)) {
      try {
        await processResultVisualMessage(env as ResultVisualWorkerEnvironment, message.body);
        message.ack();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Result visual rendering failed";
        const retryable = message.attempts < 3;
        console.error("Result visual queue job failed", {
          jobId: message.body.jobId,
          attempts: message.attempts,
          retryable,
          error: errorMessage,
        });
        if (retryable) {
          await releaseRenderJobForRetry(env.DB, message.body.jobId, {
            code: "render_retry",
            message: errorMessage,
          });
          message.retry({ delaySeconds: Math.min(60, message.attempts * 10) });
        } else {
          await failRenderJob(env.DB, message.body.jobId, {
            code: "render_failed",
            message: errorMessage,
          });
          try {
            const job = await env.DB.prepare(
              "SELECT chat_id FROM render_jobs WHERE id = ? LIMIT 1",
            ).bind(message.body.jobId).first<{ chat_id: number | null }>();
            if (job?.chat_id !== null && job?.chat_id !== undefined) {
              await sendMessage(
                env.BOT_TOKEN,
                job.chat_id,
                "❌ 结果报告生成失败。你的问卷答案已保存，请稍后从问卷完成界面重新选择模板生成。",
              );
            }
          } catch (notificationError) {
            console.error("Failed to notify result visual requester", message.body.jobId, notificationError);
          }
          message.ack();
        }
      }
    } else {
      await processExportMessage(env, message.body);
      message.ack();
    }
  }
}
