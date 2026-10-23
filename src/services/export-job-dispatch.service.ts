import { isReportDeliveryMessage } from "./report-delivery.service";
import type { ReportDeliveryWorkerEnvironment } from "./report-delivery-worker.service";
import type { ExportWorkerEnvironment } from "./export-worker.service";
import type { ExportJobSender } from "./export-job-sender";

export type { ExportJobSender };

/**
 * 无队列部署（Workers Free）的导出任务分发。
 *
 * docs/CLOUDFLARE_PLAN_TIERS.md 原则二：「降级是换实现，不是关功能」。
 * Queues 是 Workers Paid 硬门槛，而导出/归档/可视化等五类任务都走队列；
 * 这里给同一批消息体提供一条功能等价的同步路径：
 *
 *   1. 绑了 EXPORT_QUEUE → 原样 send()（生产行为不变）；
 *   2. 未绑队列但绑了 SELF → 打到本 Worker 的 /internal/dispatch-export-job，
 *      在那个请求的 waitUntil 里执行（浏览器渲染需要请求上下文，与
 *      /internal/render-public-report 同理）；入队方立即拿到响应；
 *   3. 都没有（本地 dev）→ 当前请求内联执行。
 *
 * **所有重处理器一律动态 import**：本模块被 survey/admin 的请求路径静态引用，
 * 而 export-worker.service（及其传递依赖里 result-visual 的 resvg-wasm）绝不
 * 能在模块加载期进入这些链路——纯 Node 单测会把 .wasm 当 JS 解析直接炸掉。
 * 运行时才 import 也让不执行任务的请求保持零开销。
 *
 * 与 handleExportQueue 的配对约束：新增消息种类时两处都要加——queue 路径有
 * ack/retry 语义，内联路径只有单次执行 + 落终态。
 */

export interface ExportJobDispatchEnvironment {
  /** 绑定了 Queues 的部署直接把消息交给它；未绑定走 SELF/内联降级。 */
  EXPORT_QUEUE?: unknown;
  SELF?: Fetcher;
  WEBHOOK_SECRET?: string;
  DB: D1Database;
  BOT_TOKEN: string;
}

/** 立即返回、后台继续执行的内部端点路径（见 src/http/internal-render.ts）。 */
export const INTERNAL_EXPORT_DISPATCH_PATH = "/internal/dispatch-export-job";

/**
 * 从调用方的 env 构造任务发送器。绑定了队列的部署返回队列本身（零行为变化）；
 * 否则返回 SELF/内联降级实现。
 */
export function createExportJobSender(env: ExportJobDispatchEnvironment): ExportJobSender {
  if (isQueue(env.EXPORT_QUEUE)) return env.EXPORT_QUEUE;
  return {
    async send(body: unknown): Promise<void> {
      if (env.SELF && env.WEBHOOK_SECRET) {
        try {
          const response = await env.SELF.fetch(`https://internal.internal${INTERNAL_EXPORT_DISPATCH_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-internal-token": env.WEBHOOK_SECRET },
            body: JSON.stringify(body),
          });
          if (response.ok) return;
          console.error("Internal export-job dispatch failed", { status: response.status, kind: kindOf(body) });
        } catch (error) {
          console.error("Internal export-job dispatch errored", { kind: kindOf(body), error });
        }
      }
      await runExportJobInline(env as never, body);
    },
  };
}

function isQueue(value: unknown): value is { send(body: unknown): Promise<unknown> } {
  return typeof value === "object" && value !== null && typeof (value as { send?: unknown }).send === "function";
}

function kindOf(body: unknown): string {
  return typeof body === "object" && body !== null && "kind" in body
    ? String((body as { kind: unknown }).kind)
    : "unknown";
}

/** public_report 消息守卫：结构与 export-worker.service 的 isPublicReportMessage 一致。 */
function isPublicReportKind(value: unknown): value is { kind: "public_report"; responseId: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "public_report" &&
    Number.isInteger((value as { responseId?: unknown }).responseId)
  );
}

/**
 * 单次内联执行一条队列消息。错误处理对齐 handleExportQueue 的终态分支
 * （队列的重试在这里不存在，能落终态的落终态，留给 cron 恢复的留给 cron：
 * report_delivery 自带 retryable 记账，result_visual/image_generator 的
 * pending/running 行由每 30 分钟的 recovery cron 重新分发）。
 */
export async function runExportJobInline(
  env: ExportWorkerEnvironment & ReportDeliveryWorkerEnvironment,
  body: unknown,
): Promise<void> {
  try {
    // 运行时才加载重依赖（原因见模块注释）。
    const [
      { processReportDeliveryMessage },
      { publishPublicReportViaRequestContext, isResponseReportJobMessage, processResponseReportMessage },
      { isImageGeneratorJobMessage, processImageGeneratorMessage, retryImageGeneratorJob },
      { processResultVisualMessage },
      { isResultVisualJobMessage },
      { failRenderJob },
      { sendMessage },
    ] = await Promise.all([
      import("./report-delivery-worker.service"),
      import("./export-worker.service"),
      import("./image-generator-worker.service"),
      import("./result-visual-worker.service"),
      import("./result-visual-queue.service"),
      import("../db/repositories/result-visual.repository"),
      import("../bot/telegram"),
    ]);

    if (isReportDeliveryMessage(body)) {
      // 自带失败记账（retryable/next_retry_at），不向上抛。
      await processReportDeliveryMessage(env, body);
      return;
    }
    if (isPublicReportKind(body)) {
      try {
        const result = await publishPublicReportViaRequestContext(env, body.responseId);
        console.info("Public Telegram report published", { responseId: body.responseId, ...result });
      } catch (error) {
        // 无重试：标记失败，让提交端看到明确的终态而不是永远的 pending。
        await env.DB.prepare("UPDATE survey_responses SET report_publication_status='failed', updated_at=? WHERE id=?")
          .bind(new Date().toISOString(), body.responseId)
          .run();
        throw error;
      }
      return;
    }
    if (isResponseReportJobMessage(body)) {
      await processResponseReportMessage(env, body);
      return;
    }
    if (isImageGeneratorJobMessage(body)) {
      try {
        await processImageGeneratorMessage(env, body);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Image generator failed";
        await retryImageGeneratorJob(env.DB, body.jobId, detail, true);
        const job = await env.DB.prepare("SELECT chat_id FROM image_generator_jobs WHERE id=?")
          .bind(body.jobId)
          .first<{ chat_id: number }>();
        if (job) {
          try {
            await sendMessage(env.BOT_TOKEN, job.chat_id, "❌ 报告生成失败，请稍后重新生成。");
          } catch (notificationError) {
            console.error("Failed to notify report requester", body.jobId, notificationError);
          }
        }
      }
      return;
    }
    if (isResultVisualJobMessage(body)) {
      try {
        await processResultVisualMessage(env as never, body);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Result visual rendering failed";
        await failRenderJob(env.DB, body.jobId, { code: "render_failed", message: errorMessage });
        const job = await env.DB.prepare("SELECT chat_id FROM render_jobs WHERE id = ? LIMIT 1")
          .bind(body.jobId)
          .first<{ chat_id: number | null }>();
        if (job?.chat_id !== null && job?.chat_id !== undefined) {
          try {
            await sendMessage(
              env.BOT_TOKEN,
              job.chat_id,
              "❌ 结果报告生成失败。你的问卷答案已保存，请稍后从问卷完成界面重新选择模板生成。",
            );
          } catch (notificationError) {
            console.error("Failed to notify result visual requester", body.jobId, notificationError);
          }
        }
      }
      return;
    }
    // 兜底分支：survey 导出（csv/zip）。失败即终态——内联路径没有重试。
    try {
      const { processExportMessage } = await import("./export-worker.service");
      await processExportMessage(env as never, body);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "导出文件生成失败";
      const job = body as { jobId?: unknown; chatId?: unknown };
      if (typeof job.jobId !== "number") throw error;
      console.error("Survey export inline job failed", { jobId: job.jobId, error: detail });
      const { updateExportJob } = await import("../db/repositories/export.repository");
      await updateExportJob(env.DB, job.jobId, { status: "failed", errorMessage: detail.slice(0, 500) });
      if (typeof job.chatId === "number") {
        try {
          await sendMessage(env.BOT_TOKEN, job.chatId, "导出失败，请稍后重新发起导出。");
        } catch (notificationError) {
          console.error("Failed to notify export requester", job.jobId, notificationError);
        }
      }
    }
  } catch (error) {
    console.error("Inline export job failed", { kind: kindOf(body), error });
  }
}
