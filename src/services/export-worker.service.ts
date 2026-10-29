import { getExportJobById, updateExportJob } from "../db/repositories/export.repository";
import { buildCsv, serializeExport } from "./export.service";
import type { SurveyExportJobMessage } from "./export-queue.service";
import { processResultVisualMessage, type ResultVisualWorkerEnvironment } from "./result-visual-worker.service";
import { isResultVisualJobMessage } from "./result-visual-queue.service";
import { failRenderJob, releaseRenderJobForRetry } from "../db/repositories/result-visual.repository";
import { getExportRows } from "./export.service";
import { sendDocument, sendMessage } from "../bot/telegram";
import {
  isImageGeneratorJobMessage,
  processImageGeneratorMessage,
  retryImageGeneratorJob,
} from "./image-generator-worker.service";
import type { BrowserWorker } from "@cloudflare/puppeteer";
import { isReportDeliveryMessage, type ReportDeliveryMessage } from "./report-delivery.service";
import { processReportDeliveryMessage, type ReportDeliveryWorkerEnvironment } from "./report-delivery-worker.service";
import {
  PUBLICATION_CLAIM_STALE_MS,
  publishPublicResponseReport,
  type PublicReportEnvironment,
  type PublicReportOutcome,
} from "./public-report.service";
import { createExportJobSender } from "./export-job-dispatch.service";

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
  MEDIA_KV?: KVNamespace;
  REPORT_CHANNEL_ID?: string;
  WEBHOOK_SECRET?: string;
  SELF?: Fetcher;
  TARGET_CHAT_ID?: string;
  TOPIC_ID?: string;
  PUBLICATION_TARGET_CHAT_ID?: string;
  PUBLICATION_TARGET_THREAD_ID?: string;
}

interface PublicReportMessage {
  kind: "public_report";
  responseId: number;
}

/**
 * Browser sessions acquired inside queue consumers die within their first few
 * CDP calls on constrained accounts, while request-context renders keep
 * working. When PUBLIC_BASE_URL is configured, hand the render+send to the
 * worker's own internal HTTP endpoint (request context) instead of rendering
 * here; otherwise fall back to the in-process path.
 *
 * Exported for the queue-less inline dispatcher (export-job-dispatch.service),
 * which must execute exactly the same per-kind logic.
 */
export async function publishPublicReportViaRequestContext(
  env: ExportWorkerEnvironment & PublicReportEnvironment,
  responseId: number,
): Promise<PublicReportOutcome> {
  if (!env.SELF) {
    return publishPublicResponseReport(env, responseId);
  }
  // The dummy host is required by service-binding fetches; the /internal
  // path prefix is what the worker's own router matches on.
  const response = await env.SELF.fetch(`https://internal.internal/internal/render-public-report/${responseId}`, {
    method: "POST",
    headers: { "x-internal-token": env.WEBHOOK_SECRET ?? "" },
  });
  const payload = (await response.json().catch(() => null)) as
    | ({
        ok?: boolean;
        error?: string;
      } & Partial<PublicReportOutcome>)
    | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(`Internal public-report render failed: ${response.status} ${payload?.error ?? ""}`);
  }
  return {
    chatId: Number(payload.chatId),
    messageIds: payload.messageIds ?? [],
    pages: payload.pages ?? 0,
    targets: payload.targets ?? [],
    // skipped 经 SELF 内部路由透传：锁被别的消费者持有时，队列侧靠它决定
    // 延迟重投而不是 ack（见 handleExportQueue 的 skipped 分支）。
    ...(payload.skipped ? { skipped: true as const } : {}),
  };
}

export function isPublicReportMessage(value: unknown): value is PublicReportMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.kind === "public_report" && Number.isInteger(message.responseId) && Number(message.responseId) > 0;
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

export function isResponseReportJobMessage(value: unknown): value is ResponseReportJobMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    message.kind === "response_report" &&
    ["chatId", "userId", "surveyId", "responseId", "responseNumber"].every((key) => Number.isInteger(message[key])) &&
    message.format === "png" &&
    typeof message.anonymize === "boolean"
  );
}

export async function processResponseReportMessage(
  env: ExportWorkerEnvironment,
  body: ResponseReportJobMessage,
): Promise<void> {
  if (!env.CACHE || !env.SESSION || !env.UI || !env.BUILDER || !env.BROWSER)
    throw new Error("Response report worker bindings are unavailable");
  const { sendResponseReportExport } = await import("../bot/survey-handler");
  await sendResponseReportExport(
    {
      botToken: env.BOT_TOKEN,
      db: env.DB,
      cache: env.CACHE,
      session: env.SESSION as never,
      ui: env.UI as never,
      builder: env.BUILDER as never,
      adminIds: (env.ADMIN_IDS ?? "")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0),
      exportQueue: createExportJobSender(env),
      ...(env.BROWSER ? { browser: env.BROWSER } : {}),
    },
    body.chatId,
    body.userId,
    body.surveyId,
    body.responseId,
    body.responseNumber,
    body.format,
    body.anonymize,
  );
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
    ["csv", "zip"].includes(message.format)
  );
}

function exportFileMetadata(
  surveyId: number,
  format: SurveyExportJobMessage["format"],
): { fileName: string; contentType: string } {
  if (format === "zip") {
    return { fileName: `survey-${surveyId}.zip`, contentType: "application/zip" };
  }
  return { fileName: `survey-${surveyId}.csv`, contentType: "text/csv" };
}

export async function processExportMessage(env: ExportWorkerEnvironment, body: unknown): Promise<void> {
  if (!isExportJobMessage(body)) {
    console.error("Invalid export queue message", body);
    return;
  }

  // A `completed` job is the only terminal no-op. `pending`/`running`/`failed`
  // are all re-attemptable: a Worker killed mid-export left the row `running`
  // and the queue redelivers the message, so treating `running` as re-runnable
  // is what prevents the job from being stuck forever. Errors are re-thrown so
  // the caller decides retry-vs-terminal from the message attempt count.
  const job = await getExportJobById(env.DB, body.jobId);
  if (!job || job.status === "completed") return;

  await updateExportJob(env.DB, job.id, { status: "running" });
  const { rows } = await getExportRows(env.DB, body.surveyId);
  const csv = buildCsv(rows);
  const content = serializeExport(body.format, csv, rows);
  const metadata = exportFileMetadata(body.surveyId, body.format);
  await sendDocument(env.BOT_TOKEN, body.chatId, metadata.fileName, content, metadata.contentType);
  await updateExportJob(env.DB, job.id, { status: "completed" });
}

export async function handleExportQueue(
  batch: MessageBatch<unknown>,
  env: ExportWorkerEnvironment & ResultVisualWorkerEnvironment & ReportDeliveryWorkerEnvironment,
): Promise<void> {
  for (const message of batch.messages) {
    if (isPublicReportMessage(message.body)) {
      try {
        const result = await publishPublicReportViaRequestContext(env, message.body.responseId);
        if (result.skipped) {
          // 锁被别的消费者持有。原实现这里落进 ack：一旦那个持有者随后被杀，
          // 这份答卷就永久停在 pending——没有队列消息、没有 cron 扫描、UI 上
          // 连重投按钮都没有。改为延迟重投：下一条消息落在 5 分钟锁过期之后，
          // 要么自己抢到锁，要么那份「还活着」的持有者已完成发布。
          if (message.attempts < 3) {
            console.warn("Public report publication lock held elsewhere; retrying later", {
              responseId: message.body.responseId,
              attempts: message.attempts,
            });
            message.retry({ delaySeconds: 150 });
          } else {
            console.error("Public report publication lock still held elsewhere; giving up this delivery", {
              responseId: message.body.responseId,
              attempts: message.attempts,
            });
            message.ack();
          }
        } else {
          console.info("Public Telegram report published", { responseId: message.body.responseId, ...result });
          message.ack();
        }
      } catch (error) {
        const terminal = message.attempts >= 3;
        console.error("Public Telegram report job failed", {
          responseId: message.body.responseId,
          attempts: message.attempts,
          terminal,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        if (terminal) {
          // 终态失败同时放锁，但只放「已过期或空」的锁：锁还新鲜时可能是别的
          // 活跃消费者持有（锁易主一路抛上来的那种），不能替它清。自己崩溃留下
          // 的新鲜锁会在 5 分钟后自然过期，管理端重投随后就能接管。
          const now = new Date().toISOString();
          const staleBefore = new Date(Date.now() - PUBLICATION_CLAIM_STALE_MS).toISOString();
          try {
            await env.DB.prepare(
              `UPDATE survey_responses
                  SET report_publication_status='failed',
                      report_publication_claim_at = CASE
                        WHEN report_publication_claim_at IS NULL OR report_publication_claim_at < ? THEN NULL
                        ELSE report_publication_claim_at END,
                      updated_at=?
                WHERE id=?`,
            )
              .bind(staleBefore, now, message.body.responseId)
              .run();
          } catch (lockError) {
            // 老库没有 0093 的锁列：只标终态。
            if (!/no such column/i.test(lockError instanceof Error ? lockError.message : String(lockError))) {
              throw lockError;
            }
            await env.DB.prepare(
              "UPDATE survey_responses SET report_publication_status='failed', updated_at=? WHERE id=?",
            )
              .bind(now, message.body.responseId)
              .run();
          }
          message.ack();
        } else {
          // New browser acquisitions are account-wide rate limited; retrying
          // too soon just burns attempts while the limiter is still hot.
          message.retry({ delaySeconds: 90 * message.attempts });
        }
      }
    } else if (isReportDeliveryMessage(message.body)) {
      try {
        await processReportDeliveryMessage(env, message.body);
        message.ack();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Report delivery failed";
        console.error("Report delivery queue job failed", {
          deliveryId: (message.body as ReportDeliveryMessage).deliveryId,
          attempts: message.attempts,
          error: errorMessage,
        });
        message.retry({ delaySeconds: Math.min(60, message.attempts * 10) });
      }
    } else if (isResponseReportJobMessage(message.body)) {
      try {
        await processResponseReportMessage(env, message.body);
        message.ack();
      } catch (error) {
        const terminal = message.attempts >= 3;
        console.error("Response report queue job failed", { attempts: message.attempts, terminal, error });
        if (terminal) {
          try {
            await sendMessage(env.BOT_TOKEN, message.body.chatId, "❌ 手机版报告生成失败，请稍后重试。");
          } catch (notificationError) {
            console.error("Failed to notify response report requester", notificationError);
          }
          message.ack();
        } else {
          message.retry({ delaySeconds: Math.min(60, message.attempts * 10) });
        }
      }
    } else if (isImageGeneratorJobMessage(message.body)) {
      try {
        await processImageGeneratorMessage(env, message.body);
        message.ack();
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Image generator failed";
        const terminal = message.attempts >= 3;
        await retryImageGeneratorJob(env.DB, message.body.jobId, detail, terminal);
        if (terminal) {
          const job = await env.DB.prepare("SELECT chat_id FROM image_generator_jobs WHERE id=?")
            .bind(message.body.jobId)
            .first<{ chat_id: number }>();
          if (job) {
            try {
              await sendMessage(env.BOT_TOKEN, job.chat_id, "❌ 报告生成失败，请稍后重新生成。");
            } catch (notificationError) {
              console.error("Failed to notify report requester", message.body.jobId, notificationError);
            }
          }
          message.ack();
        } else message.retry({ delaySeconds: Math.min(60, message.attempts * 10) });
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
            const job = await env.DB.prepare("SELECT chat_id FROM render_jobs WHERE id = ? LIMIT 1")
              .bind(message.body.jobId)
              .first<{ chat_id: number | null }>();
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
      try {
        await processExportMessage(env, message.body);
        message.ack();
      } catch (error) {
        const jobId = (message.body as SurveyExportJobMessage).jobId;
        const chatId = (message.body as SurveyExportJobMessage).chatId;
        const terminal = message.attempts >= 3;
        const detail = error instanceof Error ? error.message : "导出文件生成失败";
        console.error("Survey export queue job failed", { jobId, attempts: message.attempts, terminal, error: detail });
        await updateExportJob(env.DB, jobId, {
          status: terminal ? "failed" : "running",
          errorMessage: terminal ? detail.slice(0, 500) : null,
        });
        if (terminal) {
          try {
            await sendMessage(env.BOT_TOKEN, chatId, "导出失败，请稍后重新发起导出。");
          } catch (notificationError) {
            console.error("Failed to notify export requester", jobId, notificationError);
          }
          message.ack();
        } else {
          message.retry({ delaySeconds: Math.min(60, message.attempts * 10) });
        }
      }
    }
  }
}
