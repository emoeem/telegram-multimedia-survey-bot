import { sendMessage } from "../bot/telegram";
import type { ImageGeneratorJobMessage } from "./image-generator-worker.service";
import type { ExportJobSender } from "./export-job-sender";

interface StaleImageGeneratorJob {
  id: number;
  chat_id: number | null;
  attempts: number;
  status: string;
}

// `image_generator_jobs` has no started_at, so age is measured from created_at.
// Image generation is a fast WASM render, so anything still `processing` half
// an hour after creation is a dead invocation rather than a slow one.
const staleProcessingMs = 30 * 60_000;

// queued 超时是独立阈值：一个 queued 行超过它还没被消费者认领，就认定它的队列
// 消息丢了（入队发送失败，或本恢复流程「置回 queued 后 sender.send 失败」的
// 遗留——修复前那种行永远停在 queued，下一轮只扫 processing，任务就此蒸发）。
// 10 分钟远大于队列自身重投间隔（≤60s），撞上「真消息还在路上」的概率极低；
// 就算撞上，重复消息也会输掉消费者 `WHERE status='queued'` 的原子认领而被跳过，
// 所以重投是可重入的，重复执行无害。
const staleQueuedMs = 10 * 60_000;

// attempts 上限与既有口径一致：认领次数到 3 视为终态，不再投递。
const maxAttempts = 3;

/**
 * 口径统一：两个恢复服务都以 started_at 计时。本表没有 started_at 列（迁移
 * 0014/0015 均未加），SQL 层回退 created_at——本表入队即发消息，正常情况下
 * queued→processing 只差秒级，两者基本重合。残余风险如实说明：一个排队超过
 * 30 分钟才被认领的活任务可能被误回收一次（置回 queued + 重投），最坏情况是
 * 一次多余的重复渲染；阈值 30 分钟远大于正常排队时间，把它压到极小概率。
 */
export async function recoverStaleImageGeneratorJobs(
  db: D1Database,
  sender: ExportJobSender,
  botToken: string,
  now = Date.now(),
): Promise<{ requeued: number; failed: number }> {
  const processingCutoff = new Date(now - staleProcessingMs).toISOString();
  const queuedCutoff = new Date(now - staleQueuedMs).toISOString();
  const result = await db
    .prepare(
      `SELECT id, chat_id, attempts, status FROM image_generator_jobs
       WHERE (status = 'processing' AND created_at < ?)
          OR (status = 'queued' AND created_at < ?)
       ORDER BY id ASC LIMIT 20`,
    )
    .bind(processingCutoff, queuedCutoff)
    .all<StaleImageGeneratorJob>();

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
            `UPDATE image_generator_jobs
             SET status = 'failed', error_message = ?, completed_at = ?
             WHERE id = ? AND status = 'queued' AND created_at < ?`,
          )
          .bind("图像生成投递超时", new Date(now).toISOString(), job.id, queuedCutoff)
          .run();
        if (!update.meta?.changes) continue;
        failed += 1;
        if (job.chat_id !== null) {
          try {
            await sendMessage(botToken, job.chat_id, "❌ 图像生成超时，请稍后重新生成。");
          } catch (error) {
            console.error("Failed to notify stale image generator job", job.id, error);
          }
        }
        continue;
      }
      requeued += 1;
      try {
        await sender.send({ kind: "image_generator", jobId: job.id } satisfies ImageGeneratorJobMessage);
      } catch (error) {
        // 投递失败不炸整个扫描：行仍是 queued，下一轮 queued 扫描会再投。
        console.error("Failed to redeliver queued image generator job", job.id, error);
      }
      continue;
    }

    // processing 超时：沿用原有回收逻辑。置回 queued 后发送失败也不再有丢失
    // 窗口——行停在 queued，由上面的 queued 分支在下一轮接管重投。
    const update = await db
      .prepare(
        `UPDATE image_generator_jobs
         SET status = ?, error_message = ?, completed_at = ?
         WHERE id = ? AND status = 'processing' AND created_at < ?`,
      )
      .bind(
        terminal ? "failed" : "queued",
        terminal ? "图像生成超时" : null,
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
          await sendMessage(botToken, job.chat_id, "❌ 图像生成超时，请稍后重新生成。");
        } catch (error) {
          console.error("Failed to notify stale image generator job", job.id, error);
        }
      }
    } else {
      requeued += 1;
      try {
        await sender.send({ kind: "image_generator", jobId: job.id } satisfies ImageGeneratorJobMessage);
      } catch (error) {
        console.error("Failed to redeliver recovered image generator job", job.id, error);
      }
    }
  }
  return { requeued, failed };
}

export type ImageGeneratorRetryResult =
  { outcome: "requeued"; status: "queued" } | { outcome: "not_found" } | { outcome: "not_retryable"; status: string };

/**
 * 人工重试一条 failed 的图片生成任务(控制台 POST
 * /api/control/jobs/image_generator/:id/retry,通宵批次 B6;此前 failed 只能
 * 等 30 分钟一次的恢复 cron——而恢复扫描只回收 processing/queued 卡死的行,
 * 对 failed 终态行从不回头)。语义与上面的恢复扫描一致:条件 UPDATE 抢占
 * (WHERE status='failed',两个并发重试只有一个赢),赢者经同一 sender 重投
 * 一条队列消息——与 recoverStaleImageGeneratorJobs 走完全相同的投递路径,
 * 不新造调度。attempts 不重置:恢复扫描的终态口径(attempts>=3 不再自动
 * 投递)不被人工重试绕过,一次重试只多给一次认领机会,不会形成无限自动重试。
 */
export async function retryFailedImageGeneratorJob(
  db: D1Database,
  sender: ExportJobSender,
  id: number,
): Promise<ImageGeneratorRetryResult> {
  const update = await db
    .prepare(
      `UPDATE image_generator_jobs
       SET status = 'queued', error_message = NULL, completed_at = NULL
       WHERE id = ? AND status = 'failed'`,
    )
    .bind(id)
    .run();
  if (update.meta?.changes) {
    // 直接 await 不吞错:行已回 queued,投递失败时端点如实给 503;丢掉的队列
    // 消息由上面 queued 扫描的 10 分钟阈值兜底重投(见 staleQueuedMs 注释)。
    await sender.send({ kind: "image_generator", jobId: id } satisfies ImageGeneratorJobMessage);
    return { outcome: "requeued", status: "queued" };
  }
  const job = await db
    .prepare("SELECT status FROM image_generator_jobs WHERE id = ? LIMIT 1")
    .bind(id)
    .first<{ status: string }>();
  if (!job) return { outcome: "not_found" };
  return { outcome: "not_retryable", status: job.status };
}
