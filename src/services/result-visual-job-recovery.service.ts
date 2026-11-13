import { sendMessage } from "../bot/telegram";
import type { ResultVisualJobMessage } from "./result-visual-queue.service";
import type { ExportJobSender } from "./export-job-sender";

interface StaleRenderJob {
  id: number;
  chat_id: number | null;
  attempts: number;
  status: string;
}

// How long a render may stay `processing` before the recovery sweep reclaims
// it. This must comfortably exceed the worst legitimate render: multi-page
// HTML reports render up to 20 pages with up to 3 attempts each, and image
// resolution downloads Telegram files sequentially (20s timeout each). The old
// 2-minute cutoff reclaimed *live* jobs, let a second consumer claim the same
// job, and delivered the report twice to the user. 30 minutes matches the
// `*/30` cron interval and is far above any healthy render while still
// recovering a genuinely hung worker within one or two ticks.
const staleProcessingMs = 30 * 60_000;

// queued 超时是独立阈值：一个 queued 行超过它还没被消费者认领，就认定它的队列
// 消息丢了（入队发送失败，或本恢复流程「置回 queued 后 sender.send 失败」的
// 遗留——修复前那种行永远停在 queued，下一轮只扫 processing，任务就此蒸发）。
// 10 分钟远大于队列自身重投间隔（≤60s）。重复投递是可重入的：真消息还在路上
// 或消费者已认领时，重复消息会输掉 claimRenderJob 的 `WHERE status='queued'`
// 原子认领而被跳过，重复执行无害。
const staleQueuedMs = 10 * 60_000;

// attempts 上限与既有口径一致：认领次数到 3 视为终态，不再投递。
const maxAttempts = 3;

/**
 * 口径统一：两个恢复服务都以 started_at 计时，started_at 为空的行（尚未被
 * 认领过的 queued 行）回退 created_at。已知偏差如实说明：被 releaseRender-
 * JobForRetry 重入队的行 started_at 是上一次认领的时间，会让刚重入队的行立刻
 * 显得「超时」——代价只是每轮一条多余的重复消息（被认领仲裁拦下），换来的
 * 是绝不会有消息丢失的行被漏扫。
 */
export async function recoverStaleResultVisualJobs(
  db: D1Database,
  sender: ExportJobSender,
  botToken: string,
  now = Date.now(),
): Promise<{ requeued: number; failed: number }> {
  const processingCutoff = new Date(now - staleProcessingMs).toISOString();
  const queuedCutoff = new Date(now - staleQueuedMs).toISOString();
  const result = await db
    .prepare(
      `SELECT id, chat_id, attempts, status FROM render_jobs
     WHERE (status = 'processing' AND COALESCE(started_at, created_at) < ?)
        OR (status = 'queued' AND COALESCE(started_at, created_at) < ?)
     ORDER BY id ASC LIMIT 20`,
    )
    .bind(processingCutoff, queuedCutoff)
    .all<StaleRenderJob>();

  let requeued = 0;
  let failed = 0;
  for (const job of result.results ?? []) {
    const terminal = job.attempts >= maxAttempts;
    if (job.status === "queued") {
      // queued 超时未投递：终态行先原子占住（WHERE status='queued'，避免误杀
      // 刚被认领的行）再通知；未终态行直接重投一条队列消息——它不带状态变更，
      // 重复执行无害（见 staleQueuedMs 注释）。
      if (terminal) {
        const update = await db
          .prepare(
            `UPDATE render_jobs SET status = 'failed', error_code = ?, error_message = ?,
           completed_at = ?
         WHERE id = ? AND status = 'queued'
           AND COALESCE(started_at, created_at) < ?`,
          )
          .bind("render_delivery_timeout", "结果报告投递超时", new Date(now).toISOString(), job.id, queuedCutoff)
          .run();
        if (!update.meta?.changes) continue;
        failed += 1;
        if (job.chat_id !== null) {
          try {
            await sendMessage(botToken, job.chat_id, "❌ 结果报告生成超时，请回到问卷完成界面重新选择模板。");
          } catch (error) {
            console.error("Failed to notify stale result visual job", job.id, error);
          }
        }
        continue;
      }
      requeued += 1;
      try {
        await sender.send({ kind: "result_visual", jobId: job.id } satisfies ResultVisualJobMessage);
      } catch (error) {
        // 投递失败不炸整个扫描：行仍是 queued，下一轮 queued 扫描会再投。
        console.error("Failed to redeliver queued result visual job", job.id, error);
      }
      continue;
    }

    // processing 超时：沿用原有回收逻辑。置回 queued 后发送失败也不再有丢失
    // 窗口——行停在 queued，由上面的 queued 分支在下一轮接管重投。
    const update = await db
      .prepare(
        `UPDATE render_jobs SET status = ?, error_code = ?, error_message = ?,
         completed_at = ?
       WHERE id = ? AND status = 'processing'
         AND COALESCE(started_at, created_at) < ?`,
      )
      .bind(
        terminal ? "failed" : "queued",
        terminal ? "render_timeout" : null,
        terminal ? "结果报告生成超时" : null,
        terminal ? new Date(now).toISOString() : null,
        job.id,
        processingCutoff,
      )
      .run();
    if (!update.meta?.changes) continue;
    if (terminal) {
      failed += 1;
      if (job.chat_id !== null) {
        try {
          await sendMessage(botToken, job.chat_id, "❌ 结果报告生成超时，请回到问卷完成界面重新选择模板。");
        } catch (error) {
          console.error("Failed to notify stale result visual job", job.id, error);
        }
      }
    } else {
      requeued += 1;
      try {
        await sender.send({ kind: "result_visual", jobId: job.id } satisfies ResultVisualJobMessage);
      } catch (error) {
        console.error("Failed to redeliver recovered result visual job", job.id, error);
      }
    }
  }
  return { requeued, failed };
}
