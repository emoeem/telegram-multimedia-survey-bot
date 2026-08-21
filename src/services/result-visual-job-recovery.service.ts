import { sendMessage } from "../bot/telegram";
import type { ResultVisualJobMessage } from "./result-visual-queue.service";

interface StaleRenderJob {
  id: number;
  chat_id: number | null;
  attempts: number;
}

const staleProcessingMs = 2 * 60_000;

export async function recoverStaleResultVisualJobs(
  db: D1Database,
  queue: Queue,
  botToken: string,
  now = Date.now(),
): Promise<{ requeued: number; failed: number }> {
  const cutoff = new Date(now - staleProcessingMs).toISOString();
  const result = await db.prepare(
    `SELECT id, chat_id, attempts FROM render_jobs
     WHERE status = 'processing' AND COALESCE(started_at, created_at) < ?
     ORDER BY id ASC LIMIT 20`,
  ).bind(cutoff).all<StaleRenderJob>();

  let requeued = 0;
  let failed = 0;
  for (const job of result.results ?? []) {
    const terminal = job.attempts >= 3;
    const update = await db.prepare(
      `UPDATE render_jobs SET status = ?, error_code = ?, error_message = ?,
         completed_at = ?
       WHERE id = ? AND status = 'processing'
         AND COALESCE(started_at, created_at) < ?`,
    ).bind(
      terminal ? "failed" : "queued",
      terminal ? "render_timeout" : null,
      terminal ? "结果报告生成超时" : null,
      terminal ? new Date(now).toISOString() : null,
      job.id,
      cutoff,
    ).run();
    if (!(update.meta?.changes)) continue;
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
      await queue.send({ kind: "result_visual", jobId: job.id } satisfies ResultVisualJobMessage);
    }
  }
  return { requeued, failed };
}
